import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'telemetry-relay-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const record = () => ({
  t: Date.now(),
  kind: 'page',
  route: '/photos/:id',
  status: 200,
  ms: 12,
  phases: { ssr: 10 },
  build: null,
  aborted: false,
});
const batch = () => ({ v: 1, records: [record()] });
async function invoke(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
  body: unknown,
  options: { peer?: string; headers?: Record<string, string>; path?: string; raw?: string } = {},
) {
  const req = Object.assign(Readable.from([Buffer.from(options.raw ?? JSON.stringify(body))]), {
    method: 'POST',
    url: options.path ?? '/__deploy/v1/server',
    headers: options.headers ?? { authorization: `Bearer ${'a'.repeat(43)}` },
    socket: { remoteAddress: options.peer ?? '172.17.0.2' },
  });
  let status = 0;
  const res = Object.assign(
    new Writable({
      write(_chunk, _encoding, done) {
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
after(async () => {
  const { resetRequestsDb } = await import('./requests-db.ts');
  const { _resetDb } = await import('./store.ts');
  resetRequestsDb();
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('remote container environment uses the local relay and SER-issued token without a local database', async () => {
  const runtime = await import('./telemetry-runtime.ts');
  runtime.configureRemoteTelemetry(async () => ({
    RFR_TELEMETRY_URL: 'http://host.lima.internal:5358/__deploy',
    RFR_TELEMETRY_TOKEN: 'a'.repeat(43),
    DEPLOY_TELEMETRY_URL: 'http://host.lima.internal:5358/__deploy',
    DEPLOY_TELEMETRY_TOKEN: 'a'.repeat(43),
  }));
  try {
    const env = await runtime.containerTelemetryEnvironment('forma', async () => {
      throw new Error('SER bridge lookup');
    });
    assert.equal(env.RFR_TELEMETRY_URL, 'http://host.lima.internal:5358/__deploy');
    assert.equal(env.RFR_TELEMETRY_TOKEN, 'a'.repeat(43));
    assert.equal(env.DEPLOY_TELEMETRY_URL, env.RFR_TELEMETRY_URL);
    assert.equal(env.DEPLOY_TELEMETRY_TOKEN, env.RFR_TELEMETRY_TOKEN);
  } finally {
    runtime.configureRemoteTelemetry(undefined);
  }
});

test('relay accepts only local container peers, bearer tokens and valid bounded v1 shape', async () => {
  const { createTelemetryRelay, relayNetwork } = await import('./telemetry-relay.ts');
  const network = relayNetwork(
    'linux',
    [
      {
        Name: 'bridge',
        Driver: 'bridge',
        IPAM: { Config: [{ Subnet: '172.17.0.0/16', Gateway: '172.17.0.1' }] },
      },
    ],
    5358,
  );
  assert.equal(network.url, 'http://172.17.0.1:5358/__deploy');
  const mac = relayNetwork('darwin', [], 5358);
  assert.equal(mac.url, 'http://host.lima.internal:5358/__deploy');
  assert.equal(mac.bind, '127.0.0.1');
  assert.equal(mac.allowed('::ffff:127.0.0.1'), true);
  assert.equal(mac.allowed('192.168.1.4'), false);
  const relay = createTelemetryRelay({
    coordinatorUrl: 'https://coordinator.test',
    nodeId: 'mac',
    secret: 'computer-secret',
    allowedPeer: network.allowed,
    fetch: async () => new Response(null, { status: 204 }),
  });
  try {
    assert.equal(await invoke(relay.handler, batch()), 204);
    assert.equal(
      await invoke(relay.handler, batch(), {
        peer: '192.168.1.4',
        headers: { authorization: `Bearer ${'a'.repeat(43)}`, 'x-forwarded-for': '172.17.0.2' },
      }),
      404,
    );
    assert.equal(await invoke(relay.handler, batch(), { headers: {} }), 401);
    assert.equal(
      await invoke(relay.handler, batch(), { headers: { authorization: 'Bearer invalid' } }),
      401,
    );
    assert.equal(await invoke(relay.handler, { v: 2, records: [] }), 400);
    assert.equal(await invoke(relay.handler, { ...batch(), deployment: 'victim' }), 400);
    assert.equal(
      await invoke(relay.handler, { v: 1, records: [{ ...record(), route: '/?secret=x' }] }),
      400,
    );
    assert.equal(await invoke(relay.handler, null, { raw: ' '.repeat(512 * 1024 + 1) }), 413);
    assert.equal(await invoke(relay.handler, batch(), { path: '/other/v1/server' }), 404);
  } finally {
    await relay.close();
  }
});

test('relay forwards with the computer credential and original deployment bearer, refusing redirects', async () => {
  const { createTelemetryRelay } = await import('./telemetry-relay.ts');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const relay = createTelemetryRelay({
    coordinatorUrl: 'https://coordinator.test',
    nodeId: 'mac',
    secret: 'computer-secret',
    allowedPeer: () => true,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 204 });
    },
  });
  try {
    const body = batch();
    assert.equal(await invoke(relay.handler, body), 204);
    await relay.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://coordinator.test/api/agent/telemetry/v1/server');
    assert.deepEqual(calls[0].init.headers, {
      'Content-Type': 'application/json',
      'x-deploy-node-id': 'mac',
      'x-deploy-node-secret': 'computer-secret',
      authorization: `Bearer ${'a'.repeat(43)}`,
    });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), body);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(relay.stats.forwardedRecords, 1);
  } finally {
    await relay.close();
  }
});

test('dead SER never blocks app responses or crashes the relay; queue and failures are counted', async () => {
  const { createTelemetryRelay } = await import('./telemetry-relay.ts');
  let attempts = 0;
  const relay = createTelemetryRelay({
    coordinatorUrl: 'http://127.0.0.1:5359',
    nodeId: 'mac',
    secret: 'secret',
    allowedPeer: () => true,
    maxBatches: 2,
    maxBytes: 1024 * 1024,
    timeoutMs: 25,
    fetch: async (_url, init) => {
      attempts++;
      return new Promise((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new Error('dead SER')), {
          once: true,
        }),
      );
    },
  });
  try {
    const start = performance.now();
    for (let i = 0; i < 5; i++) assert.equal(await invoke(relay.handler, batch()), 204);
    assert.equal(attempts, 0, 'app responses do not await network IO');
    assert.ok(performance.now() - start < 1000);
    assert.equal(relay.stats.queuedBatches, 2);
    assert.equal(relay.stats.droppedRecords, 3);
    await relay.flush();
    assert.equal(attempts, 2);
    assert.equal(relay.stats.droppedRecords, 5);
    assert.equal(relay.stats.failedBatches, 2);
    assert.equal(relay.stats.queuedBytes, 0);
    assert.equal(await invoke(relay.handler, batch()), 204);
  } finally {
    await relay.close();
  }
});

test('relay byte budget includes an in-flight batch; SER rejection is dropped without retries', async () => {
  const { createTelemetryRelay } = await import('./telemetry-relay.ts');
  const body = batch();
  const bytes = Buffer.byteLength(JSON.stringify(body));
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const relay = createTelemetryRelay({
    coordinatorUrl: 'https://coordinator.test',
    nodeId: 'mac',
    secret: 'secret',
    allowedPeer: () => true,
    maxBytes: bytes,
    fetch: async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response(null, { status: 401 });
    },
  });
  try {
    assert.equal(await invoke(relay.handler, body), 204);
    const flushed = relay.flush();
    await ready;
    assert.equal(await invoke(relay.handler, body), 204);
    assert.equal(relay.stats.queuedBytes, bytes);
    assert.equal(relay.stats.droppedRecords, 1);
    release();
    await flushed;
    assert.equal(relay.stats.droppedRecords, 2);
    assert.equal(relay.stats.failedBatches, 1);
    assert.equal(relay.stats.queuedBatches, 0);
    assert.equal(relay.stats.queuedBytes, 0);
  } finally {
    await relay.close();
  }
});

test('SER ingests relayed records by token only, scoped to computer and current app owner', async () => {
  const { fleetRoutes } = await import('./api/fleet.ts');
  const store = await import('./store.ts');
  const { getRequestsSqlite } = await import('./requests-db.ts');
  const { issueRemoteTelemetryToken } = await import('./telemetry-remote.ts');
  const enroll = (name: string) =>
    store.redeemNodeEnrollment({ code: store.createNodeEnrollment(name, 'owner').code });
  const mac = enroll('Mac'),
    other = enroll('Other');
  assert.ok(mac.secret);
  assert.ok(mac.nodeId);
  assert.ok(other.secret);
  assert.ok(other.nodeId);
  store.registerDeploymentStart('forma', 'owner', 'node');
  const db = getRequestsSqlite();
  const token = issueRemoteTelemetryToken(db, 'forma', mac.nodeId, 'owner');
  const path = '/api/agent/telemetry/v1/server';
  const handler = (req: IncomingMessage, res: ServerResponse) =>
    fleetRoutes({ req, res, path, method: 'POST' } as never);
  const headers = {
    authorization: `Bearer ${token}`,
    'x-deploy-node-id': mac.nodeId,
    'x-deploy-node-secret': mac.secret,
  };
  assert.equal(await invoke(handler, batch(), { path, headers }), 204);
  assert.deepEqual(db.prepare('SELECT deployment_name,source,count FROM telemetry_routes').all(), [
    { deployment_name: 'forma', source: 'server', count: 1 },
  ]);
  assert.equal(
    await invoke(handler, batch(), {
      path,
      headers: { ...headers, 'x-deploy-node-secret': 'wrong' },
    }),
    401,
  );
  assert.equal(
    await invoke(handler, batch(), {
      path,
      headers: {
        ...headers,
        'x-deploy-node-id': other.nodeId,
        'x-deploy-node-secret': other.secret,
      },
    }),
    401,
  );
  assert.equal(
    await invoke(handler, batch(), { path, headers: { authorization: `Bearer ${token}` } }),
    401,
  );
  assert.equal(await invoke(handler, { ...batch(), deployment: 'victim' }, { path, headers }), 400);
  assert.equal(
    await invoke(handler, batch(), {
      path,
      headers: { ...headers, authorization: `Bearer ${'z'.repeat(43)}` },
    }),
    401,
  );
  store.registerDeploymentStart('forma', 'new-owner', 'node');
  assert.equal(await invoke(handler, batch(), { path, headers }), 401);
  store.registerDeploymentStart('forma', 'owner', 'node');
  store.revokeNode(mac.nodeId);
  assert.equal(await invoke(handler, batch(), { path, headers }), 401);
});

test('authenticated job claim provisions a SER telemetry token for remote deploy, recreate and release', async () => {
  const { fleetRoutes } = await import('./api/fleet.ts');
  const store = await import('./store.ts');
  const { getRequestsSqlite } = await import('./requests-db.ts');
  const { deploymentForToken } = await import('./telemetry.ts');
  const enrolled = store.redeemNodeEnrollment({
    code: store.createNodeEnrollment('Job Mac', 'owner').code,
  });
  assert.ok(enrolled.secret);
  assert.ok(enrolled.nodeId);
  store.registerDeploymentStart('job-app', 'owner', 'node');
  for (const type of ['deploy', 'recreate', 'project-release']) {
    const job = store.enqueueAgentJob({
      nodeId: enrolled.nodeId,
      type,
      deploymentName: 'job-app',
      payload: {},
    });
    let value: any;
    const req = Object.assign(Readable.from([]), {
      method: 'POST',
      url: '/api/agent/jobs/claim',
      headers: { 'x-deploy-node-id': enrolled.nodeId, 'x-deploy-node-secret': enrolled.secret },
      socket: {},
    });
    const res = {
      writeHead() {},
      end(body: string) {
        value = JSON.parse(body);
      },
    };
    await fleetRoutes({ req, res, path: req.url, method: req.method } as never);
    assert.equal(deploymentForToken(getRequestsSqlite(), value.telemetryToken ?? ''), 'job-app');
    store.completeAgentJob(job.id, enrolled.nodeId, { success: true, result: {} });
  }
});
