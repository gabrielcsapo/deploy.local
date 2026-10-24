import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Agent, createServer, get as httpGet, type Server, type IncomingMessage } from 'node:http';
import {
  connect,
  constants as h2,
  createSecureServer,
  type ClientHttp2Session,
  type Http2SecureServer,
} from 'node:http2';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyControlError, createControlForwarder } from './control-forward.ts';
import {
  EDGE_HTTP2_CONNECTION_WINDOW,
  EDGE_HTTP2_SETTINGS,
  tuneHttp2Session,
} from './http2-tuning.ts';

const BIG = JSON.stringify({ events: 'x'.repeat(8 * 1024 * 1024) });

function listen(server: Server | Http2SecureServer) {
  return new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), 'edge-forward-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function pooled(agent: Agent) {
  const count = (group: NodeJS.ReadOnlyDict<Socket[]>) =>
    Object.values(group).reduce((n, sockets) => n + (sockets?.length ?? 0), 0);
  return { busy: count(agent.sockets), free: count(agent.freeSockets) };
}

function h2Get(session: ClientHttp2Session, path: string, method = 'GET') {
  return new Promise<{ status: number; body: Buffer; ms: number }>((resolve, reject) => {
    const started = performance.now();
    const chunks: Buffer[] = [];
    let status = 0;
    const stream = session.request({ ':path': path, ':method': method });
    stream.on('response', (headers) => (status = Number(headers[':status'])));
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      if (stream.rstCode && stream.rstCode !== h2.NGHTTP2_NO_ERROR)
        reject(new Error(`stream reset ${stream.rstCode}`));
      else resolve({ status, body: Buffer.concat(chunks), ms: performance.now() - started });
    });
    stream.on('error', reject);
    stream.end();
  });
}

describe('edge → control forwarding', () => {
  const tls = selfSignedCert();
  const hits = new Map<string, number>();
  const pendingSlow = new Set<() => void>();
  let failNextReused = false;
  let controlConnections = 0;

  const control = createServer((req, res) => {
    const path = req.url || '/';
    hits.set(path, (hits.get(path) ?? 0) + 1);
    if (path === '/api/big') {
      // The control plane's JSON helper: headers, then one large end() write.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(BIG);
      return;
    }
    if (path === '/api/small' || path === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (path === '/api/slow') {
      const respond = () => {
        pendingSlow.delete(respond);
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(BIG);
      };
      pendingSlow.add(respond);
      setTimeout(respond, 250);
      return;
    }
    if (path === '/api/crash-mid-body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"partial":"' + 'y'.repeat(256 * 1024));
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }
    if (path === '/api/stale') {
      // Simulates control closing an idle keep-alive socket at the moment the
      // edge reuses it: the request dies before any response bytes.
      if (failNextReused) {
        failNextReused = false;
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"fresh":true}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  control.on('connection', () => controlConnections++);

  let controlPort = 0;
  let agent: Agent;
  let forwarder: ReturnType<typeof createControlForwarder>;
  let edge: Http2SecureServer;
  let edgePort = 0;
  let session: ClientHttp2Session;
  const h1Agent = new HttpsAgent({
    keepAlive: true,
    rejectUnauthorized: false,
    ALPNProtocols: ['http/1.1'],
  });

  function h1Get(path: string, method = 'GET', body?: string) {
    return new Promise<{ status: number; body: Buffer; ms: number }>((resolve, reject) => {
      const started = performance.now();
      const req = httpsRequest(
        { host: '127.0.0.1', port: edgePort, path, method, agent: h1Agent },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (!res.complete) reject(new Error('response aborted'));
            else
              resolve({
                status: res.statusCode!,
                body: Buffer.concat(chunks),
                ms: performance.now() - started,
              });
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  before(async () => {
    controlPort = await listen(control);
    agent = new Agent({ keepAlive: true, maxSockets: 64, timeout: 60_000 });
    forwarder = createControlForwarder({
      port: controlPort,
      agent,
      retryWindowMs: 400,
      retryDelayMs: 50,
    });
    edge = createSecureServer(
      { ...tls, allowHTTP1: true, settings: EDGE_HTTP2_SETTINGS },
      (req, res) => forwarder.forward(req as any, res as any),
    );
    edge.on('session', tuneHttp2Session);
    edgePort = await listen(edge);
    session = connect(`https://127.0.0.1:${edgePort}`, { rejectUnauthorized: false });
  });

  after(() => {
    session.close();
    h1Agent.destroy();
    agent.destroy();
    edge.close();
    control.close();
    control.closeAllConnections();
  });

  it('streams a multi-megabyte body over HTTP/2 quickly and intact', async (t) => {
    await h2Get(session, '/api/big'); // warm the TLS session and control pool
    const result = await h2Get(session, '/api/big');
    assert.equal(result.status, 200);
    assert.equal(result.body.length, Buffer.byteLength(BIG));
    t.diagnostic(`8 MiB over h2: ${Math.round(result.ms)}ms`);
    assert.ok(result.ms < 1000, `8 MiB over h2 took ${Math.round(result.ms)}ms`);
  });

  it('streams a multi-megabyte body over HTTP/1.1 quickly and intact', async (t) => {
    await h1Get('/api/big');
    const result = await h1Get('/api/big');
    assert.equal(result.status, 200);
    assert.equal(result.body.length, Buffer.byteLength(BIG));
    t.diagnostic(`8 MiB over h1: ${Math.round(result.ms)}ms`);
    assert.ok(result.ms < 1000, `8 MiB over h1 took ${Math.round(result.ms)}ms`);
  });

  it('keeps small requests responsive while large bodies stream', async () => {
    const big = [1, 2, 3, 4].map(() => h2Get(session, '/api/big'));
    await sleep(5);
    const small = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => (n % 2 ? h2Get(session, '/api/small') : h1Get('/api/small'))),
    );
    for (const result of small) {
      assert.equal(result.status, 200);
      assert.ok(result.ms < 500, `small request took ${Math.round(result.ms)}ms`);
    }
    for (const result of await Promise.all(big))
      assert.equal(result.body.length, Buffer.byteLength(BIG));
  });

  it('raises the HTTP/2 connection window for uploads', async () => {
    const local = await new Promise<number>((resolve) => {
      edge.once('session', (serverSession) =>
        setImmediate(() => resolve(serverSession.state.localWindowSize ?? 0)),
      );
      connect(`https://127.0.0.1:${edgePort}`, { rejectUnauthorized: false }).on(
        'connect',
        function (this: ClientHttp2Session) {
          setTimeout(() => this.close(), 50);
        },
      );
    });
    assert.equal(local, EDGE_HTTP2_CONNECTION_WINDOW);
  });

  for (const protocol of ['h2', 'http/1.1'] as const) {
    it(`releases the control request when an ${protocol} client cancels before headers`, async () => {
      hits.delete('/api/slow');
      for (let i = 0; i < 4; i++) {
        if (protocol === 'h2') {
          const stream = session.request({ ':path': '/api/slow' });
          stream.on('error', () => {});
          stream.end();
          setTimeout(() => stream.close(h2.NGHTTP2_CANCEL), 40);
        } else {
          const req = httpsRequest({
            host: '127.0.0.1',
            port: edgePort,
            path: '/api/slow',
            agent: h1Agent,
          });
          req.on('error', () => {});
          req.end();
          setTimeout(() => req.destroy(), 40);
        }
      }
      await sleep(600); // past control's 250ms response and the retry window
      // One control request per client request: a cancel is not a failure to retry.
      assert.equal(hits.get('/api/slow'), 4);
      // No control socket is pinned behind a response nobody will read.
      assert.equal(pooled(agent).busy, 0);
    });
  }

  it('resets the client stream when control dies mid-body instead of ending it cleanly', async () => {
    await assert.rejects(h2Get(session, '/api/crash-mid-body'));
    await assert.rejects(h1Get('/api/crash-mid-body'));
  });

  it('retries an idempotent request whose pooled socket control already closed', async () => {
    await h2Get(session, '/api/small'); // leave a pooled socket behind
    failNextReused = true;
    const result = await h2Get(session, '/api/stale');
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body.toString()), { fresh: true });
  });

  it('does not call a reset connection a restart', async () => {
    await h2Get(session, '/api/small');
    failNextReused = true;
    const result = await h2Get(session, '/api/stale', 'POST');
    assert.equal(result.status, 502);
    assert.deepEqual(JSON.parse(result.body.toString()), {
      error: 'control plane closed the connection before responding',
    });
  });

  it('does not cut off a slow response with the pooled-socket idle timeout', async () => {
    const shortAgent = new Agent({ keepAlive: true, timeout: 100 });
    const slow = createControlForwarder({ port: controlPort, agent: shortAgent });
    const server = createServer((req, res) => slow.forward(req, res));
    const port = await listen(server);
    try {
      const status = await new Promise<number>((resolve, reject) => {
        httpGet({ host: '127.0.0.1', port, path: '/api/slow', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        }).on('error', reject);
      });
      assert.equal(status, 200);
    } finally {
      shortAgent.destroy();
      server.close();
    }
  });

  it("honors control's keep-alive hint so idle sockets close before control closes them", async () => {
    const hinted = createServer((_req, res) => res.end('ok'));
    hinted.keepAliveTimeout = 2000; // `Keep-Alive: timeout=2`: the agent keeps idle sockets 1s
    let connections = 0;
    hinted.on('connection', () => connections++);
    const port = await listen(hinted);
    const hintedAgent = new Agent({ keepAlive: true, timeout: 60_000 });
    const viaEdge = createControlForwarder({ port, agent: hintedAgent });
    const server = createServer((req, res) => viaEdge.forward(req, res));
    const edgeHttp = await listen(server);
    const get = () =>
      new Promise<void>((resolve, reject) =>
        httpGet({ host: '127.0.0.1', port: edgeHttp, path: '/api/x', agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        }).on('error', reject),
      );
    try {
      await get();
      await sleep(1400); // past the agent's 1s, before control's 2s
      assert.equal(pooled(hintedAgent).free, 0, 'idle socket should be retired by the hint');
      await get();
      assert.equal(connections, 2);
    } finally {
      hintedAgent.destroy();
      server.close();
      hinted.close();
      hinted.closeAllConnections();
    }
  });

  it('answers 503 "restarting" only when control refuses connections, and rides out a restart', async () => {
    const down = createServer((_req, res) => res.end('{"back":true}'));
    const port = await listen(down);
    await new Promise((resolve) => down.close(resolve));
    const restartAgent = new Agent({ keepAlive: true });
    const viaEdge = createControlForwarder({
      port,
      agent: restartAgent,
      retryWindowMs: 300,
      retryDelayMs: 50,
    });
    const server = createServer((req, res) => viaEdge.forward(req, res));
    const edgeHttp = await listen(server);
    const get = (path: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) =>
        httpGet({ host: '127.0.0.1', port: edgeHttp, path, agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode!, body }));
        }).on('error', reject),
      );
    try {
      const refused = await get('/api/state');
      assert.equal(refused.status, 503);
      assert.deepEqual(JSON.parse(refused.body), { error: 'control plane restarting' });

      const pending = get('/api/state');
      await sleep(120);
      await new Promise<void>((resolve) => down.listen(port, '127.0.0.1', () => resolve()));
      const recovered = await pending;
      assert.equal(recovered.status, 200);
      assert.deepEqual(JSON.parse(recovered.body), { back: true });
    } finally {
      restartAgent.destroy();
      server.close();
      down.close();
      down.closeAllConnections();
    }
  });

  it('classifies control errors by what actually failed', () => {
    const code = (value: string) =>
      classifyControlError(Object.assign(new Error(value), { code: value }));
    assert.equal(code('ECONNREFUSED').status, 503);
    assert.equal(code('ECONNREFUSED').error, 'control plane restarting');
    assert.equal(code('ECONNRESET').status, 502);
    assert.equal(code('ETIMEDOUT').status, 504);
    assert.notEqual(code('ETIMEDOUT').error, 'control plane restarting');
  });
});
