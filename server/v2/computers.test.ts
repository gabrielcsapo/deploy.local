import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-computers-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save, list } = await import('../workspace/store.ts');
const {
  mergeComputers,
  getComputers,
  setComputerRoles,
  removalPlan,
  removeComputer,
  getModels,
  setModelDefaults,
} = await import('./computers.ts');
const { workerCommand } = await import('../workspace/protocol.ts');
const { enrollWorker, workerAuthentication } = await import('../workspace/credentials.ts');
const { v2Api } = await import('./api.ts');
store.registerUser('owner', 'test-password');
store.registerUser('other', 'test-password');
const timestamp = new Date().toISOString();
function worker(id: string, owner = 'owner') {
  save('worker', owner, {
    id,
    instanceId: id,
    name: id,
    heartbeat: timestamp,
    capabilities: ['codex'],
    modelOptions: [{ id: 'codex', models: [{ id: 'gpt-example', name: 'Example' }] }],
    providers: [
      {
        id: 'codex',
        status: 'signed-in',
        windows: [{ label: 'Weekly', usedPercent: 18 }],
        checkedAt: 1,
      },
    ],
  });
}
const server = createServer(
  (req, res) =>
    void v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') })),
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
if (port > 5199) throw new Error('No test port available');
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
test('merges local and explicitly linked workers, never names; omits unknown metrics and secrets', () => {
  const computers = mergeComputers({
    nodes: [
      {
        id: 'coordinator',
        name: 'SER',
        online: true,
        capabilities: '{"memoryBytes":45000}',
        credentialHash: 'secret',
      },
      { id: 'linux', name: 'bazzite', online: true },
    ],
    workers: [
      { id: 'local', name: 'SER', status: 'online' },
      { id: 'remote', name: 'bazzite', status: 'online' },
      { id: 'same-name', name: 'SER', status: 'offline' },
    ],
    apps: [{ name: 'home-gym', activeNodeId: 'linux', status: 'running' }],
    runs: [{ id: 'run', workerId: 'remote', taskId: 'task', status: 'running' }],
    jobs: [],
    tasks: [{ id: 'task', title: 'Fix the sync migration' }],
    settings: [{ id: 'linux', workerIds: ['remote'], roles: ['take-tasks', 'run-apps'] }],
  });
  assert.equal(computers.length, 3);
  assert.deepEqual(computers[0].workerIds, ['local']);
  assert.equal(computers[0].cpu, undefined);
  assert.equal(computers[1].doing[1].name, 'Fix the sync migration');
  assert.equal(computers[2].online, false);
  assert.ok(!JSON.stringify(computers).includes('secret'));
});
test('a computer and the task worker it enrolled, or SER and its managed worker, are one row', () => {
  const computers = mergeComputers({
    nodes: [
      { id: 'coordinator', name: 'SER', online: true },
      { id: 'node_b', name: 'bazzite', online: false },
    ],
    workers: [
      { id: 'managed-1', name: 'SER', status: 'online', managed: true },
      { id: 'node-worker-node_b', name: 'bazzite', status: 'online' },
      { id: 'node-worker-unknown', name: 'old', status: 'offline' },
    ],
    apps: [],
    runs: [],
    jobs: [],
    tasks: [],
    settings: [],
  });
  assert.deepEqual(
    computers.map((c) => [c.id, c.workerIds, c.roles, c.online]),
    [
      ['coordinator', ['managed-1'], ['coordinator', 'run-apps', 'take-tasks'], true],
      ['node_b', ['node-worker-node_b'], ['run-apps', 'take-tasks'], true],
      ['worker:node-worker-unknown', ['node-worker-unknown'], ['take-tasks'], false],
    ],
  );
});
test('role changes fence new task claims without interrupting a running task', () => {
  worker('roles');
  save('task', 'owner', { id: 'task', title: 'Task' });
  save('run', 'owner', { id: 'queued', taskId: 'task', workerId: 'roles', status: 'queued' });
  const changed = setComputerRoles('owner', 'worker:roles', []);
  assert.deepEqual(changed.roles, []);
  assert.equal(workerCommand('owner', '/workers/roles/poll', { instanceId: 'roles' }).run, null);
  setComputerRoles('owner', 'worker:roles', ['take-tasks']);
  assert.equal(
    workerCommand('owner', '/workers/roles/poll', { instanceId: 'roles' }).run.id,
    'queued',
  );
  setComputerRoles('owner', 'worker:roles', []);
  assert.equal(
    workerCommand('owner', '/workers/roles/poll', { instanceId: 'roles' }).run.id,
    'queued',
  );
  assert.throws(() => setComputerRoles('other', 'worker:roles', []), /Administrator/);
  assert.throws(() => setComputerRoles('owner', 'worker:roles', ['bad']), /valid computer roles/);
});
test('removal refuses apps without a destination and busy workers, and revokes idle credentials', () => {
  const enrollment = store.createNodeEnrollment('bazzite', 'owner');
  const joined = store.redeemNodeEnrollment({ code: enrollment.code });
  assert.ok('nodeId' in joined);
  const nodeId = joined.nodeId!;
  store.saveDeployment({ name: 'private-app', username: 'other', activeNodeId: nodeId });
  const plan = removalPlan('owner', nodeId);
  assert.equal(plan.allowed, false);
  // The coordinator counts as a destination once it is registered as a computer.
  assert.match(
    plan.reasons.join(' '),
    plan.apps[0].destinations.length
      ? /through their project releases/
      : /No other online computer/,
  );
  assert.throws(() => removeComputer('owner', nodeId), /new home|through their project releases/);
  assert.throws(() => removeComputer('owner', 'worker:roles'), /queued and active tasks/);
  worker('pending');
  save('run', 'owner', {
    id: 'pending-run',
    taskId: 'task',
    workerId: 'pending',
    status: 'queued',
  });
  assert.throws(() => removeComputer('owner', 'worker:pending'), /queued and active/);
  worker('idle');
  const credential = enrollWorker('owner', { workerId: 'idle' });
  removeComputer('owner', 'worker:idle');
  assert.equal(
    workerAuthentication({
      headers: { 'x-deploy-worker-id': 'idle', 'x-deploy-worker-token': credential.workerToken },
    } as any),
    null,
  );
  assert.ok(!getComputers('owner').some((c) => c.id === 'worker:idle'));
});
test('models persist owner defaults and project weekly usage only when reported', () => {
  worker('models');
  save('worker', 'owner', {
    id: 'malformed-options',
    modelOptions: [null, { models: {} }, { id: 'codex', models: [null] }],
  });
  const models = getModels('owner');
  assert.equal(models.providers.find((p) => p.id === 'codex')?.weekly?.usedPercent, 18);
  assert.equal(models.providers.find((p) => p.id === 'claude')?.weekly, undefined);
  const defaults = {
    'writing-code': 'codex:gpt-example',
    reviewing: null,
    'answering-questions': null,
  };
  assert.deepEqual(setModelDefaults('owner', defaults).defaults, defaults);
  assert.equal(getModels('other').defaults['writing-code'], null);
  assert.throws(
    () => setModelDefaults('owner', { ...defaults, reviewing: 'missing' }),
    /available model/,
  );
  assert.equal(list('v2-model-defaults', 'owner').length, 1);
});
test('HTTP list/detail and models use envelopes, agent writes are refused', async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/computers`);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.ok(Array.isArray(value.computers));
  const detail = await fetch(`http://127.0.0.1:${port}/api/v2/computers/worker%3Amodels`);
  assert.equal((await detail.json()).computer.id, 'worker:models');
  const rejected = await fetch(`http://127.0.0.1:${port}/api/v2/computers/worker%3Amodels`, {
    method: 'PATCH',
    headers: { 'x-deploy-agent-token': 'agent' },
    body: '{"roles":[]}',
  });
  assert.equal(rejected.status, 403);
});
