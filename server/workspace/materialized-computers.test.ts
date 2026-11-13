import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const root = mkdtempSync(join(tmpdir(), 'materialized-computers-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.NODE_ENV = 'test';
const { save, get, remove, db } = await import('./store.ts');
const { computers, revokeWorker, jobCommand } = await import('./coordination.ts');
const { workerCommand } = await import('./protocol.ts');
const { workerRole, workerComputerId } = await import('./computer-role-policy.ts');
const { enrollWorker, workerAuthentication } = await import('./credentials.ts');
const nodes = await import('../store/nodes.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function register(owner: string) {
  return workerCommand(owner, '/workers/register', {
    workerId: 'worker',
    instanceId: 'instance',
    name: 'Computer',
    platform: 'linux',
    architecture: 'arm64',
    checkpointJobs: true,
  });
}

test('many reads share one computation, owner isolation and passive ageing use the cadence', (t) => {
  const owner = randomUUID();
  register(owner);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const prepare = t.mock.method(db, 'prepare');
  const first = computers(owner);
  const count = prepare.mock.callCount();
  for (let i = 0; i < 50; i++) assert.equal(computers(owner), first);
  assert.equal(prepare.mock.callCount(), count);
  register(owner);
  assert.equal(computers(owner), first, 'unchanged registration preserves the view');
  const another = computers(randomUUID());
  assert.notEqual(another, first);
  save('worker', owner, { ...get('worker', owner, 'worker'), heartbeat: new Date().toISOString() });
  assert.equal(computers(owner), first, 'heartbeat-only writes preserve the view');
  t.mock.timers.tick(1000);
  assert.notEqual(computers(owner), first);
  t.mock.timers.tick(10000);
  assert.equal(computers(owner)[0].status, 'offline');
  assert.throws(() => computers(owner)[0].capabilities.push('mutated'), TypeError);
});

test('every inventory dependency invalidates on writes and removal', () => {
  const owner = randomUUID();
  register(owner);
  const changes: [string, any][] = [
    ['worker', { ...get('worker', owner, 'worker'), name: 'Renamed' }],
    ['worker', { ...get('worker', owner, 'worker'), build: { version: '0.0.1' }, agentTools: [] }],
    [
      'interactive-worker',
      {
        id: 'worker',
        targets: [{ id: 'desktop', kind: 'computer', permissions: { accessibility: true } }],
      },
    ],
    ['managed-worker', { id: 'worker' }],
    ['project', { id: 'project', name: 'Repo', autoApproveTaskBrowser: true }],
    ['v2-computer-roles', { id: 'worker', workerIds: ['worker'], roles: [] }],
    ['terminal-permission', { id: 'worker', enabled: true }],
    ['tool-probe', { id: 'worker:node', workerId: 'worker', tool: 'node', has: true }],
  ];
  for (const [kind, row] of changes) {
    const before = computers(owner);
    save(kind, owner, row);
    assert.notEqual(computers(owner), before, `${kind} write`);
    const written = computers(owner);
    remove(kind, owner, row.id);
    assert.notEqual(computers(owner), written, `${kind} removal`);
    save(kind, owner, row);
  }
  const before = computers(owner);
  nodes.setComputerRolePreferences('coordinator', { tasks: false });
  assert.notEqual(computers(owner), before);
  assert.equal(workerRole(owner, 'worker', 'take-tasks'), false);
  nodes.setComputerRolePreferences('coordinator', { tasks: true });
  const global = computers(owner);
  save('worker-inventory', 'system', { id: 'local', capabilities: ['shell'] });
  assert.notEqual(computers(owner), global);
  const reservation = computers(owner);
  save('v2-update-reservation', 'system', { id: 'test', workers: [{ owner, id: 'worker' }] });
  assert.notEqual(computers(owner), reservation);
  remove('v2-update-reservation', 'system', 'test');
});

test('roles, node linkage, revocation and credentials change on the next read', () => {
  const owner = randomUUID();
  register(owner);
  const credentials = enrollWorker(owner, { workerId: 'worker' });
  const req = {
    headers: { 'x-deploy-worker-id': 'worker', 'x-deploy-worker-token': credentials.workerToken },
  } as any;
  assert.ok(workerAuthentication(req));
  const before = computers(owner);
  assert.equal(workerRole(owner, 'worker', 'take-tasks'), true);
  nodes.setComputerRolePreferences('worker', { tasks: false });
  assert.equal(workerRole(owner, 'worker', 'take-tasks'), false);
  assert.notEqual(computers(owner), before);
  nodes.setComputerRolePreferences('worker', { tasks: true });
  assert.equal(workerRole(owner, 'worker', 'take-tasks'), true);
  const enrollment = nodes.createNodeEnrollment('Computer ' + owner, owner);
  const node = nodes.redeemNodeEnrollment({ code: enrollment.code });
  assert.ok(node.nodeId);
  save('worker', owner, { ...get('worker', owner, 'worker'), nodeId: node.nodeId });
  assert.equal(workerComputerId(owner, 'worker'), node.nodeId);
  assert.ok(nodes.getNode(node.nodeId));
  assert.equal(nodes.authenticateNode(node.nodeId, node.secret), true);
  nodes.revokeNode(node.nodeId);
  assert.ok(nodes.getNode(node.nodeId)?.revokedAt);
  assert.equal(nodes.authenticateNode(node.nodeId, node.secret), false);
  revokeWorker(owner, 'worker');
  assert.equal(workerAuthentication(req), null);
  assert.ok(!computers(owner).some((worker) => worker.id === 'worker'));
});

test('a polling worker claims fresh jobs even when its cached heartbeat is offline', () => {
  const owner = randomUUID();
  register(owner);
  save('worker', owner, { ...get('worker', owner, 'worker'), heartbeat: '2000-01-01' });
  assert.equal(computers(owner)[0].status, 'offline');
  save('checkpoint', owner, {
    id: 'checkpoint',
    snapshot: { files: [], excluded: [], digest: 'test' },
  });
  save('job', owner, {
    id: 'job',
    checkpointId: 'checkpoint',
    status: 'queued',
    requirements: { os: 'linux', capabilities: [] },
  });
  const claimed = jobCommand(owner, 'worker', 'poll', { instanceId: 'instance' });
  assert.equal(claimed.job.id, 'job');
  assert.equal(claimed.job.status, 'running');
  assert.equal(
    jobCommand(owner, 'worker', 'poll', { instanceId: 'instance' }).job.generation,
    claimed.job.generation,
  );
  assert.equal(computers(owner)[0].status, 'offline', 'claim does not mutate shared view');
  workerCommand(owner, '/workers/register', {
    workerId: 'other',
    instanceId: 'other-instance',
    platform: 'linux',
    checkpointJobs: true,
  });
  assert.deepEqual(jobCommand(owner, 'other', 'poll', { instanceId: 'other-instance' }), {
    job: null,
  });
});

test('rolled-back inventory cannot escape into the shared view', () => {
  const owner = randomUUID();
  register(owner);
  computers(owner);
  assert.throws(
    () =>
      db.transaction(() => {
        save('worker', owner, { ...get('worker', owner, 'worker'), name: 'Uncommitted' });
        assert.equal(computers(owner)[0].name, 'Uncommitted');
        throw new Error('rollback');
      })(),
    /rollback/,
  );
  assert.equal(computers(owner)[0].name, 'Computer');
});

test('node and preference lookups reuse values for two seconds and invalidate on node writes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const enrollment = nodes.createNodeEnrollment('Cached ' + randomUUID(), 'owner', { tasks: true });
  const node = nodes.redeemNodeEnrollment({ code: enrollment.code, platform: 'linux' });
  assert.ok(node.nodeId);
  const first = nodes.getNode(node.nodeId);
  const preferences = nodes.getComputerRolePreferences(node.nodeId);
  for (let i = 0; i < 50; i++) {
    assert.equal(nodes.getNode(node.nodeId), first);
    assert.equal(nodes.getComputerRolePreferences(node.nodeId), preferences);
  }
  t.mock.timers.tick(1999);
  assert.equal(nodes.getNode(node.nodeId), first);
  t.mock.timers.tick(1);
  assert.notEqual(nodes.getNode(node.nodeId), first);
  assert.notEqual(nodes.getComputerRolePreferences(node.nodeId), preferences);
  nodes.heartbeatNode(node.nodeId, { platform: 'darwin' });
  assert.equal(nodes.getNode(node.nodeId)?.platform, 'darwin');
  nodes.setComputerRolePreferences(node.nodeId, { tasks: false });
  assert.equal(nodes.getComputerRolePreferences(node.nodeId).tasks, false);
  nodes.revokeNode(node.nodeId);
  assert.ok(nodes.getNode(node.nodeId)?.revokedAt);
});

test('a rotated worker credential rejects the old secret without waiting for any cadence', () => {
  const owner = randomUUID();
  register(owner);
  const first = enrollWorker(owner, { workerId: 'worker' });
  const request = (token: string) =>
    ({ headers: { 'x-deploy-worker-id': 'worker', 'x-deploy-worker-token': token } }) as any;
  computers(owner);
  assert.ok(workerAuthentication(request(first.workerToken)));
  const second = enrollWorker(owner, { workerId: 'worker' });
  assert.equal(workerAuthentication(request(first.workerToken)), null);
  assert.ok(workerAuthentication(request(second.workerToken)));
});
