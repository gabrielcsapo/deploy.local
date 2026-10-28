import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createServer as createHTTP2Server, type ServerHttp2Stream } from 'node:http2';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = mkdtempSync(join(tmpdir(), 'deploy-v2-push-'));
process.env.DEPLOY_DATA_DIR = root;
for (const key of ['KEY_PATH', 'KEY_ID', 'TEAM_ID', 'TOPIC'])
  delete process.env['DEPLOY_APNS_' + key];
const { db, list, save, event } = await import('../workspace/store.ts');
const {
  APNsClient,
  pushConfiguration,
  inboxPush,
  registerDevice,
  removeDevice,
  deliverPushEvents,
  pushApi,
} = await import('./push.ts');
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const config = {
  key: privateKey,
  keyId: 'KEY1234567',
  teamId: 'TEAM123456',
  topic: 'local.deploy.workspace.ios',
};
const token = 'ab'.repeat(32);
const item = {
  id: 'rollback:home-gym:9c3e1fa',
  kind: 'rollback' as const,
  title: 'Roll back home-gym?',
  text: '38% of jobs fail.',
  from: 'warden',
  createdAt: new Date().toISOString(),
  actions: [
    { id: 'rollback', label: 'Roll back', primary: true },
    { id: 'dismiss', label: 'Not now' },
  ],
  state: 'waiting' as const,
};
const servers: { close: (callback?: () => void) => unknown }[] = [];
async function listen(
  server: ReturnType<typeof createServer> | ReturnType<typeof createHTTP2Server>,
) {
  for (let port = 5180; port <= 5199; port++) {
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      servers.push(server);
      return `http://127.0.0.1:${port}`;
    } catch (error: any) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('No fixture port available');
}
after(async () => {
  for (const server of servers) await new Promise<void>((done) => server.close(done));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('configuration is disabled without all four settings', () => {
  assert.equal(pushConfiguration({}), undefined);
  assert.equal(pushConfiguration({ DEPLOY_APNS_KEY_ID: 'only-one' }), undefined);
});
test('provider token uses ES256 P1363, correct claims, and bounded refresh', () => {
  const client = new APNsClient(config);
  const jwt = client.authorization(1_800_000_000_000);
  const [header, claims, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), {
    alg: 'ES256',
    kid: config.keyId,
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url').toString()), {
    iss: config.teamId,
    iat: 1_800_000_000,
  });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(
    verify(
      'sha256',
      Buffer.from(header + '.' + claims),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  );
  assert.equal(client.authorization(1_800_000_060_000), jwt);
  assert.notEqual(client.authorization(1_800_003_000_000), jwt);
});
test('registration validates and scopes deletion; changing accounts removes old ownership', () => {
  for (const body of [
    {},
    { token: '../token', environment: 'sandbox' },
    { token, environment: 'other' },
  ])
    assert.throws(() => registerDevice('alice', body));
  registerDevice('alice', { token, environment: 'sandbox' });
  registerDevice('alice', { token, environment: 'sandbox' });
  assert.equal(list('v2-device', 'alice').length, 1);
  removeDevice('bob', token);
  assert.equal(list('v2-device', 'alice').length, 1);
  registerDevice('bob', { token, environment: 'production' });
  assert.equal(list('v2-device', 'alice').length, 0);
  assert.equal(list('v2-device', 'bob')[0].environment, 'production');
  removeDevice('bob', token);
});
test('HTTP/2 APNs request carries topic, alert, actions and valid authorization', async () => {
  const received: any[] = [];
  const server = createHTTP2Server();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    let body = '';
    stream.on('data', (chunk) => {
      body += chunk;
    });
    stream.on('end', () => {
      received.push({ headers, body: JSON.parse(body) });
      stream.respond({ ':status': 200 });
      stream.end();
    });
  });
  const endpoint = await listen(server);
  const client = new APNsClient({ ...config, endpoint });
  assert.equal(
    (
      await client.send(
        { id: 'd', token, environment: 'sandbox', registeredAt: 0 },
        inboxPush(item),
        item.id,
      )
    ).status,
    200,
  );
  const request = received[0];
  assert.equal(request.headers[':method'], 'POST');
  assert.equal(request.headers[':path'], '/3/device/' + token);
  assert.equal(request.headers['apns-topic'], config.topic);
  assert.equal(request.headers['apns-push-type'], 'alert');
  assert.match(request.headers.authorization, /^bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.equal(request.body.aps.category, 'DEPLOY_DECISION');
  assert.equal(request.body.approveActionId, 'rollback');
  assert.equal(request.body.notNowActionId, 'dismiss');
  assert.equal(
    inboxPush({ ...item, actions: [{ ...item.actions[0], confirm: 'Really?' }, item.actions[1]] })
      .aps.category,
    'DEPLOY_OPEN',
  );
});
test('durable consumer sends creation once and only transitions into failing', async () => {
  const owner = 'transitions';
  registerDevice(owner, { token: 'cd'.repeat(32), environment: 'sandbox' });
  const received: any[] = [];
  const client = {
    send: async (_device: any, payload: any) => {
      received.push(payload);
      return { status: 200 };
    },
  };
  event(owner, '', null, 'v2.inbox', { item });
  event(owner, '', null, 'v2.inbox', { item: { ...item, text: 'Changed text' } });
  event(owner, '', null, 'v2.inbox', { item: { ...item, state: 'answered' } });
  const app = { appId: 'sync', kind: 'worker', state: 'failing', summary: '38% of jobs fail' };
  event(owner, '', null, 'v2.health', { app });
  event(owner, '', null, 'v2.health', { app: { ...app, summary: '39% of jobs fail' } });
  await deliverPushEvents(owner, client);
  assert.equal(received.length, 2);
  await deliverPushEvents(owner, client);
  assert.equal(received.length, 2);
  event(owner, '', null, 'v2.health', { app: { ...app, state: 'healthy' } });
  event(owner, '', null, 'v2.health', { app });
  await deliverPushEvents(owner, client);
  assert.equal(received.length, 3);
});
test('transient delivery retries without resending to acknowledged peers; invalid tokens expire', async () => {
  const owner = 'retry';
  registerDevice(owner, { token: '01'.repeat(32), environment: 'sandbox' });
  registerDevice(owner, { token: '02'.repeat(32), environment: 'sandbox' });
  event(owner, '', null, 'v2.inbox', { item });
  const calls: string[] = [];
  let fail = true;
  const client = {
    send: async (device: any) => {
      calls.push(device.token);
      return { status: device.token.startsWith('02') && fail ? 503 : 200 };
    },
  };
  await assert.rejects(deliverPushEvents(owner, client), /503/);
  fail = false;
  await deliverPushEvents(owner, client);
  assert.equal(calls.filter((value) => value.startsWith('01')).length, 1);
  assert.equal(calls.filter((value) => value.startsWith('02')).length, 2);
  event(owner, '', null, 'v2.inbox', { item: { ...item, id: 'another' } });
  await deliverPushEvents(owner, { send: async () => ({ status: 410 }) });
  assert.equal(list('v2-device', owner).length, 0);
});
test('device endpoint requires user auth, rejects worker headers, and supports DELETE', async () => {
  const server = createServer((req, res) => {
    void pushApi(req, res, (request, response) => {
      if (request.headers['x-test-user'] !== 'user') {
        response.writeHead(401);
        response.end('{}');
        return null;
      }
      return { username: 'user' };
    });
  });
  const origin = await listen(server);
  const body = JSON.stringify({ token: 'ee'.repeat(32), environment: 'sandbox' });
  assert.equal((await fetch(origin + '/api/v2/devices', { method: 'POST', body })).status, 401);
  const headers = { 'x-test-user': 'user' };
  assert.equal(
    (
      await fetch(origin + '/api/v2/devices', {
        method: 'POST',
        body,
        headers: { ...headers, 'x-deploy-agent-token': 'agent' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(origin + '/api/v2/devices', { method: 'POST', body, headers })).status,
    200,
  );
  assert.equal(
    (await fetch(origin + '/api/v2/devices', { method: 'DELETE', body, headers })).status,
    200,
  );
  assert.equal(list('v2-device', 'user').length, 0);
  assert.equal((await fetch(origin + '/api/v2/devices', { method: 'GET', headers })).status, 405);
  assert.equal(
    (await fetch(origin + '/api/v2/devices', { method: 'POST', headers, body: 'x'.repeat(4097) }))
      .status,
    413,
  );
  assert.equal(
    (await fetch(origin + '/api/v2/devices', { method: 'POST', headers, body: 'not json' })).status,
    400,
  );
});
test('registration starts at current cursor instead of replaying historical alerts', async () => {
  event('new-phone', '', null, 'v2.inbox', { item });
  registerDevice('new-phone', { token: 'ff'.repeat(32), environment: 'sandbox' });
  let calls = 0;
  await deliverPushEvents('new-phone', {
    send: async () => {
      calls++;
      return { status: 200 };
    },
  });
  assert.equal(calls, 0);
  save('v2-push-health', 'new-phone', { id: 'sync', state: 'healthy' });
});

test('resolved decisions are not sent from old event rows', async () => {
  registerDevice('resolved', { token: 'aa'.repeat(32), environment: 'sandbox' });
  event('resolved', '', null, 'v2.inbox', { item });
  save('v2-inbox', 'resolved', { ...item, state: 'answered' });
  let calls = 0;
  await deliverPushEvents('resolved', {
    send: async () => {
      calls++;
      return { status: 200 };
    },
  });
  assert.equal(calls, 0);
});
