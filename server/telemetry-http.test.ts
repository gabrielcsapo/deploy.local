import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import {
  request as httpRequest,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { openRequestsDb, resetRequestsDb } from './requests-db.ts';
import { issueTelemetryToken } from './telemetry.ts';
import {
  handleBrowserTelemetry,
  serverTelemetryHandler,
  TelemetryRateLimit,
} from './telemetry-http.ts';
import { collectorNetwork } from './telemetry-runtime.ts';
const root = mkdtempSync(join(tmpdir(), 'telemetry-http-'));
process.env.DEPLOY_DATA_DIR = root;
const db = openRequestsDb(join(root, 'requests.db'));
after(() => {
  db.close();
  resetRequestsDb();
  rmSync(root, { recursive: true, force: true });
});
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>,
  body: unknown,
  options: {
    headers?: Record<string, string>;
    peer?: string;
    url?: string;
    method?: string;
    raw?: string;
  } = {},
) {
  const req = Object.assign(Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]), {
    headers: options.headers ?? {},
    socket: { remoteAddress: options.peer ?? '172.17.0.2' },
    url: options.url ?? '/__deploy/v1/server',
    method: options.method ?? 'POST',
  });
  let status = 0;
  const res = Object.assign(
    new Writable({
      write(_chunk, _enc, done) {
        done();
      },
    }),
    {
      writeHead(code: number) {
        status = code;
        return res;
      },
    },
  );
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return status;
}
test('server endpoint checks real peer, token, version, attribution and streamed body cap', async () => {
  const token = issueTelemetryToken(db, 'app');
  const headers = { authorization: `Bearer ${token}` };
  const handler = serverTelemetryHandler(
    (ip) => ip === '172.17.0.2',
    () => db,
  );
  const record = {
    t: Date.now(),
    kind: 'page',
    route: '/photos/:id',
    status: 200,
    ms: 100,
    phases: { ssr: 80 },
    build: 'b',
    aborted: false,
  };
  assert.equal(await invoke(handler, { v: 1, records: [record] }, { headers }), 204);
  assert.equal(
    await invoke(
      handler,
      { v: 1, records: [record] },
      { headers: { ...headers, 'x-forwarded-for': '172.17.0.2' }, peer: '192.168.0.2' },
    ),
    404,
  );
  assert.equal(await invoke(handler, { v: 1, records: [record] }), 401);
  assert.equal(
    await invoke(
      handler,
      { v: 1, records: [record] },
      { headers: { authorization: 'Bearer invalid' } },
    ),
    401,
  );
  assert.equal(await invoke(handler, { v: 2, records: [record] }, { headers }), 400);
  assert.equal(
    await invoke(handler, { v: 1, deployment: 'victim', records: [record] }, { headers }),
    400,
  );
  assert.equal(await invoke(handler, null, { headers, raw: ' '.repeat(512 * 1024 + 1) }), 413);
  assert.equal(await invoke(handler, null, { headers, method: 'GET' }), 404);
  assert.equal(await invoke(handler, null, { headers, url: '/__deploy/v1/server?x=1' }), 404);
  assert.deepEqual(db.prepare('SELECT DISTINCT deployment_name FROM telemetry_routes').all(), [
    { deployment_name: 'app' },
  ]);
});
test('server endpoint hides Docker-only path from outside peers, ignoring forwarded IPs', async () => {
  const network = collectorNetwork('linux', [
    {
      Name: 'bridge',
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
    },
  ]);
  const handler = serverTelemetryHandler(network.allowed, () => db);
  assert.equal(
    await invoke(
      handler,
      { v: 1, records: [] },
      { peer: '192.168.1.5', headers: { 'x-forwarded-for': '172.17.0.2' } },
    ),
    404,
  );
});
test('server endpoint on Docker subnet requires a token on the new path', async () => {
  const handler = serverTelemetryHandler(
    (ip) => ip === '172.17.0.2',
    () => db,
  );
  assert.equal(await invoke(handler, { v: 1, records: [] }), 401);
});
test('browser endpoint caps bytes, rejects invalid JSON, limits peer IP and isolates deployments', async () => {
  const rate = new TelemetryRateLimit(10);
  const handler = (req: IncomingMessage, res: ServerResponse) =>
    handleBrowserTelemetry(req, res, 'host-app', () => db, rate);
  const body = {
    v: 1,
    build: 'b',
    events: [{ type: 'nav', route: '/', from: '/photos/:id', ms: 30, prefetch: 'inflight' }],
  };
  assert.equal(await invoke(handler, body), 204);
  assert.equal(await invoke(handler, null, { raw: ' '.repeat(16 * 1024 + 1) }), 413);
  assert.equal(await invoke(handler, null, { raw: '{' }), 400);
  assert.equal(await invoke(handler, { ...body, v: 2 }), 400);
  assert.equal(await invoke(handler, body, { headers: { 'content-length': '16385' } }), 413);
  assert.deepEqual(db.prepare('SELECT DISTINCT deployment_name FROM telemetry_pages').all(), [
    { deployment_name: 'host-app' },
  ]);
  const limited = new TelemetryRateLimit(1, 1);
  assert.equal(limited.allow('a', 0), true);
  assert.equal(limited.allow('a', 1), false);
  assert.equal(limited.allow('b', 1), false);
  assert.equal(limited.allow('b', 60_001), true);
});
test('collector network uses port 80 under /__deploy and only admits Docker bridge peers on Linux', () => {
  const linux = collectorNetwork('linux', [
    {
      Name: 'bridge',
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
    },
    {
      Name: 'app',
      Driver: 'bridge',
      IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] },
    },
  ]);
  assert.equal(linux.url, 'http://172.17.0.1/__deploy');
  assert.equal(linux.allowed('172.18.0.5'), true);
  assert.equal(linux.allowed('::ffff:172.17.0.5'), true);
  assert.equal(linux.allowed('192.168.1.5'), false);
  assert.equal(linux.allowed('127.0.0.1'), false);
  const mac = collectorNetwork('darwin', []);
  assert.equal(mac.url, 'http://host.docker.internal/__deploy');
  assert.equal(mac.allowed('127.0.0.1'), true);
  assert.equal(mac.allowed('192.168.1.5'), false);
  assert.throws(() => collectorNetwork('linux', []));
});
test('edge intercepts only exact beacon pathname and POST; header route survives proxy', async () => {
  const { createHotPathHandler } = await import('./edge/proxy.ts');
  const logged: Record<string, unknown>[] = [];
  let proxied = 0;
  const upstream = createServer((_req, res) => {
    proxied++;
    res.writeHead(200, {
      'server-timing': 'route;desc="/photos/:id", match;dur=0.1, render;dur=2',
    });
    res.end('app');
  });
  const handler = createHotPathHandler({
    getRoute: (name) => (name === 'fixture' ? { name, port: 5351 } : null),
    logRequest: (_name, entry) => logged.push(entry),
    emitEvent: () => {},
  });
  const edge = createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  upstream.listen(5351, '127.0.0.1');
  edge.listen(5350, '127.0.0.1');
  await Promise.all([once(upstream, 'listening'), once(edge, 'listening')]);
  try {
    const headers = { host: 'fixture.local' };
    const fetch = async (
      url: string,
      init: { method?: string; headers: Record<string, string>; body?: string },
    ) =>
      new Promise<{
        status: number;
        text: () => Promise<string>;
        headers: { get: (key: string) => string | null };
      }>((resolve, reject) => {
        const parsed = new URL(url);
        const req = httpRequest(
          {
            host: '127.0.0.1',
            port: 5350,
            path: parsed.pathname,
            method: init.method,
            headers: init.headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                text: async () => Buffer.concat(chunks).toString(),
                headers: { get: (key) => String(res.headers[key] ?? '') },
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(init.body);
      });
    const post = await fetch('http://127.0.0.1:5350/__deploy/telemetry', {
      method: 'POST',
      headers,
      body: JSON.stringify({ v: 1, build: 'b', events: [] }),
    });
    assert.equal(post.status, 204);
    assert.equal(proxied, 0);
    for (const [method, path] of [
      ['GET', '/__deploy/telemetry'],
      ['POST', '/__deploy/telemetry/'],
      ['POST', '/__deploy/telemetry-extra'],
    ]) {
      const response = await fetch('http://127.0.0.1:5350' + path, { method, headers });
      assert.equal(await response.text(), 'app');
      assert.match(response.headers.get('server-timing')!, /route/);
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(proxied, 3);
    assert.equal(logged.length, 3);
    assert.ok(logged.every((row) => row.route === '/photos/:id'));
  } finally {
    edge.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => edge.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
test('container environment is provisioned even in a release worker without bootServer', async () => {
  const { containerTelemetryEnvironment } = await import('./telemetry-runtime.ts');
  for (const [platform, networks, expected] of [
    ['darwin', [], 'http://host.docker.internal/__deploy'],
    [
      'linux',
      [
        {
          Name: 'bridge',
          Driver: 'bridge',
          IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
        },
      ],
      'http://172.17.0.1/__deploy',
    ],
  ] as [string, Parameters<typeof collectorNetwork>[1], string][]) {
    const env = await containerTelemetryEnvironment(
      'worker-app',
      async () => collectorNetwork(platform, networks).url,
    );
    assert.equal(env.DEPLOY_TELEMETRY_URL, expected);
    assert.match(env.DEPLOY_TELEMETRY_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  }
});
test('server peer gate awaits subnet refresh and fails closed for LAN callers', async () => {
  const token = issueTelemetryToken(db, 'app');
  const handler = serverTelemetryHandler(
    async () => false,
    () => db,
  );
  assert.equal(
    await invoke(
      handler,
      { v: 1, records: [] },
      { headers: { authorization: `Bearer ${token}` }, peer: '192.168.1.3' },
    ),
    404,
  );
});

test('collector refreshes new bridges on rejection, periodically removes old bridges and closes its timer', async (context) => {
  const { createTelemetryCollector } = await import('./telemetry-runtime.ts');
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 });
  const bridge = {
    Name: 'bridge',
    Driver: 'bridge',
    IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
  };
  const app = {
    Name: 'app',
    Driver: 'bridge',
    IPAM: { Config: [{ Subnet: '172.18.0.0/16', Gateway: '172.18.0.1' }] },
  };
  let list = [bridge];
  let discoveries = 0;
  const collector = await createTelemetryCollector({
    platform: 'linux',
    networks: async () => {
      discoveries++;
      return list;
    },
  });
  try {
    list = [bridge, app];
    // 401 proves that subnet refresh admitted the new TCP peer to token validation.
    assert.equal(await invoke(collector.handler, {}, { peer: '::ffff:172.18.0.2' }), 401);
    assert.equal(discoveries, 2);
    assert.equal(await invoke(collector.handler, {}, { peer: '192.168.1.5' }), 404);
    assert.equal(discoveries, 2, 'rejected peers cannot trigger unbounded Docker discovery');
    list = [bridge];
    context.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(discoveries, 3);
    assert.equal(await invoke(collector.handler, {}, { peer: '172.18.0.2' }), 404);
    assert.equal(await invoke(collector.handler, {}, { peer: '172.17.0.2' }), 401);
  } finally {
    collector.close();
  }
  context.mock.timers.tick(30_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(discoveries, 3);
});

test('collector stays closed when Docker discovery is unavailable and recovers on refresh', async (context) => {
  const { createTelemetryCollector } = await import('./telemetry-runtime.ts');
  context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 10_000 });
  const warning = context.mock.method(console, 'warn', () => {});
  let available = false;
  const collector = await createTelemetryCollector({
    platform: 'linux',
    networks: async () => {
      if (!available) throw new Error('fixture Docker unavailable');
      return [
        {
          Name: 'bridge',
          Driver: 'bridge',
          IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
        },
      ];
    },
  });
  try {
    assert.equal(warning.mock.callCount(), 1);
    assert.equal(await invoke(collector.handler, {}), 404);
    available = true;
    context.mock.timers.tick(30_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(await invoke(collector.handler, {}), 401);
    assert.equal(await invoke(collector.handler, {}, { peer: '192.168.1.5' }), 404);
  } finally {
    collector.close();
  }
});
