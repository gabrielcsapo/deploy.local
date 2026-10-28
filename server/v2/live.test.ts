import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-live-test-'));
process.env.DEPLOY_DATA_DIR = root;
const { saveDeployment, updateDeploymentStatus, registerUser, authenticate, _resetDb } =
  await import('../store.ts');
const { issueOwnedCiCredential, revokeCiCredential } = await import('../ci-releases.ts');
const { db, save } = await import('../workspace/store.ts');
const { acceptWorkerReport, getLive, recordLiveRelease, raiseWorkerDecision } =
  await import('./live.ts');
const { syncInbox, answerInbox } = await import('./inbox.ts');
const { waitForV2Events } = await import('./events.ts');
const { v2Api } = await import('./api.ts');
const owner = 'gabriel';
const token = registerUser(owner, 'test-password').token!;
const headers = { 'x-deploy-username': owner, 'x-deploy-token': token };
saveDeployment({ name: 'sync', username: owner, type: 'worker' });
updateDeploymentStatus('sync', 'running');
saveDeployment({ name: 'private', username: 'other', type: 'worker' });
const server = createServer(
  (req, res) =>
    void v2Api(req, res, (request, response) => {
      const username = request.headers['x-deploy-username'] as string;
      if (authenticate(username, request.headers['x-deploy-token'] as string)) return { username };
      response.writeHead(401);
      response.end('{}');
      return null;
    }),
);
let port = 5180;
for (; port <= 5199; port++) {
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    break;
  } catch (error: any) {
    if (error.code !== 'EADDRINUSE') throw error;
  }
}
if (port > 5199) throw new Error('No isolated test port available');
const origin = `http://127.0.0.1:${port}/api/v2`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});
const report = {
  appId: 'sync',
  jobs: 100,
  failures: 1,
  intervalSec: 60,
  queueDepth: 0,
  oldestJobAgeSec: 0,
};

test('API shapes, missing data, auth, methods and owner isolation', async () => {
  assert.equal((await fetch(origin + '/live')).status, 401);
  const response = await fetch(origin + '/live', { headers });
  assert.equal(response.status, 200);
  const live = await response.json();
  assert.deepEqual(Object.keys(live.summary).sort(), [
    'checkedAt',
    'failing',
    'running',
    'warning',
  ]);
  assert.deepEqual(
    live.computers.flatMap((c: any) => c.apps).map((a: any) => a.appId),
    ['sync'],
  );
  assert.equal(live.computers[0].apps[0].summary, 'Health checks unavailable');
  assert.equal('cpu' in live.computers[0], false);
  const detail = await (await fetch(origin + '/live/sync', { headers })).json();
  assert.deepEqual(Object.keys(detail).sort(), ['app', 'history']);
  assert.deepEqual(detail.history, []);
  assert.equal((await fetch(origin + '/live/private', { headers })).status, 404);
  assert.equal((await fetch(origin + '/live', { headers, method: 'POST' })).status, 405);
});

test('app tokens are scoped, revoked credentials fail, and reports emit typed health', async () => {
  const credential = issueOwnedCiCredential(owner, 'sync', 300);
  const post = (body: any, bearer = credential.token) =>
    fetch(origin + '/health/report', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  assert.equal((await post({ ...report, appId: 'private' })).status, 403);
  assert.equal((await post({ ...report, failures: -1 })).status, 400);
  assert.equal((await post(report)).status, 200);
  assert.equal((await post(report)).status, 400);
  revokeCiCredential(credential.id, owner);
  assert.equal((await post(report)).status, 401);
  const events = await waitForV2Events(owner, 0, 0, new AbortController().signal);
  assert.ok(events.events.some((e) => e.type === 'health' && e.app.appId === 'sync'));
  assert.ok(events.events.every((e) => e.type !== 'health' || e.app.appId !== 'private'));
});

test('sustained failures create exactly one Warden item for a recent whole-project release', async () => {
  const now = Date.now();
  const release = {
    id: '9c3e1fa',
    projectId: 'home-gym',
    projectName: 'home-gym',
    releasedAt: new Date(now - 300_000).toISOString(),
    apps: ['sync'],
  };
  recordLiveRelease(owner, release);
  save('v2-worker-health', owner, { id: 'sync' });
  for (let minute = 0; minute <= 4; minute++)
    acceptWorkerReport(
      owner,
      { ...report, failures: minute < 2 ? 1 : 40 },
      now - (4 - minute) * 60_000,
    );
  const live = await getLive(owner);
  assert.equal(live.summary.failing, 1);
  const items = syncInbox(owner);
  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.kind, 'rollback');
  assert.equal(item.from, 'warden');
  assert.equal(item.title, 'Roll back home-gym?');
  assert.equal(item.actions[0].id, 'rollback');
  const app = live.computers[0].apps[0];
  raiseWorkerDecision(owner, app, release, now);
  assert.equal(syncInbox(owner).length, 1);
  assert.equal(
    raiseWorkerDecision(
      owner,
      app,
      { ...release, id: 'old', releasedAt: new Date(now - 3600_000).toISOString() },
      now,
    ),
    undefined,
  );
  assert.throws(
    () => answerInbox(owner, item.id, { actionId: 'rollback', on: 'web' }),
    /not available yet/,
  );
  assert.equal(syncInbox(owner)[0].state, 'waiting');
  const answered = answerInbox(owner, item.id, { actionId: 'dismiss', on: 'web' });
  assert.equal(answered.answer?.by, owner);
  assert.equal(answered.state, 'answered');
  raiseWorkerDecision(owner, app, release, now);
  assert.equal(syncInbox(owner).filter((i) => i.state === 'waiting').length, 0);
  assert.throws(
    () => answerInbox(owner, item.id, { actionId: 'dismiss', on: 'cli' }),
    /already resolved/,
  );
  const detail = await (await fetch(origin + '/live/sync', { headers })).json();
  assert.equal(detail.app.release, '9c3e1fa');
  assert.equal(detail.history.length, 5);
  assert.equal(detail.history.at(-1).failRate, 0.4);
});

test('computer credentials report only their assigned apps and cannot read client commands', async () => {
  const { createNodeEnrollment, redeemNodeEnrollment, revokeNode } = await import('../store.ts');
  const enrollment = createNodeEnrollment('bazzite', owner);
  const node = redeemNodeEnrollment({ code: enrollment.code });
  assert.ok(node.nodeId && node.secret);
  saveDeployment({ name: 'fetcher', username: owner, type: 'worker', activeNodeId: node.nodeId });
  updateDeploymentStatus('fetcher', 'running');
  const credentials = { 'x-deploy-node-id': node.nodeId, 'x-deploy-node-secret': node.secret };
  const post = (appId: string) =>
    fetch(origin + '/health/report', {
      method: 'POST',
      headers: credentials,
      body: JSON.stringify({ ...report, appId }),
    });
  assert.equal((await post('sync')).status, 403);
  assert.equal((await post('fetcher')).status, 200);
  assert.equal((await fetch(origin + '/live', { headers: credentials })).status, 401);
  revokeNode(node.nodeId);
  assert.equal((await post('fetcher')).status, 401);
});

test('rollback decisions can enqueue through an available release handler with first-answer-wins', async () => {
  const { publishInboxItem, registerInboxAction } = await import('./inbox.ts');
  const item = publishInboxItem(owner, {
    id: 'rollback:available',
    kind: 'rollback',
    from: 'warden',
    title: 'Roll back home-gym?',
    text: 'Jobs fail.',
    projectId: 'home-gym',
    createdAt: new Date().toISOString(),
    state: 'waiting',
    actions: [{ id: 'rollback', label: 'Roll back home-gym' }],
  });
  let requests = 0;
  const unregister = registerInboxAction('rollback', 'rollback', (_owner, decision) => {
    assert.equal(decision.projectId, 'home-gym');
    requests++;
  });
  try {
    assert.equal(
      answerInbox(owner, item.id, { actionId: 'rollback', on: 'cli' }).answer?.actionId,
      'rollback',
    );
    assert.throws(
      () => answerInbox(owner, item.id, { actionId: 'rollback', on: 'web' }),
      /already resolved/,
    );
    assert.equal(requests, 1);
  } finally {
    unregister();
  }
});
