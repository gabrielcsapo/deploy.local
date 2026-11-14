import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = mkdtempSync(join(tmpdir(), 'computer-policy-removals-'));
process.env.DEPLOY_DATA_DIR = root;
const engine = await import('./store.ts');
const { save, remove, db, now } = await import('./workspace/store.ts');
const policy = await import('./workspace/computer-role-policy.ts');
const { onlineTaskWorker } = await import('./v2/task-computer.ts');
const { getComputers, removalPlan } = await import('./v2/computers.ts');
const { releaseChoices } = await import('./v2/releases-plan.ts');
const { coordinationTool } = await import('./workspace/coordination.ts');
engine.registerUser('owner', 'test-password');
after(() => {
  engine._resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
function worker(owner: string, id: string) {
  save('worker', owner, {
    id,
    name: id,
    platform: 'linux',
    heartbeat: now(),
    capabilities: ['codex', 'checkpoint-jobs'],
    instanceId: id,
  });
}

test('automatic task placement retains projection gates and also checks SQL and reservations', () => {
  const owner = 'automatic',
    id = 'automatic-worker';
  worker(owner, id);
  assert.equal(onlineTaskWorker(owner), id);
  engine.setComputerRolePreferences(id, { tasks: false });
  assert.ok(
    getComputers(owner)
      .find((c) => c.workerIds.includes(id))!
      .roles.includes('take-tasks'),
  );
  assert.equal(onlineTaskWorker(owner), undefined);
  engine.setComputerRolePreferences(id, { tasks: true });
  assert.equal(onlineTaskWorker(owner), id);
  save('v2-update-reservation', 'system', {
    id: 'automatic-reservation',
    workers: [{ owner, id }],
  });
  assert.equal(onlineTaskWorker(owner), undefined);
  remove('v2-update-reservation', 'system', 'automatic-reservation');
  // A stale record link can deny the worker while the presentation falls back to a
  // standalone computer whose default roles include take-tasks.
  for (const removed of [false, true]) {
    save('v2-computer-roles', owner, {
      id: 'missing-node',
      workerIds: [id],
      roles: removed ? ['take-tasks'] : [],
      removed,
    });
    assert.ok(
      getComputers(owner)
        .find((c) => c.workerIds.includes(id))!
        .roles.includes('take-tasks'),
    );
    assert.equal(onlineTaskWorker(owner), undefined);
    remove('v2-computer-roles', owner, 'missing-node');
  }
  save('v2-computer-roles', owner, { id: `worker:${id}`, workerIds: [id], roles: [] });
  assert.equal(onlineTaskWorker(owner), undefined, 'existing projection denial is preserved');
});

test('explicit checkpoint job dispatch now rejects v2 denial and update reservation', () => {
  const owner = 'dispatch',
    id = 'dispatch-worker';
  worker(owner, id);
  save('task', owner, { id: 'task' });
  save('run', owner, { id: 'run', taskId: 'task', status: 'running' });
  save('checkpoint', owner, { id: 'checkpoint', taskId: 'task', runId: 'run' });
  const scope = { owner, taskId: 'task', runId: 'run' };
  const dispatch = () =>
    coordinationTool(scope, 'deploy_run_job', {
      operationId: randomUUID(),
      checkpointId: 'checkpoint',
      workerId: id,
      command: 'true',
    });
  assert.doesNotThrow(dispatch);
  save('v2-computer-roles', owner, { id, workerIds: [id], roles: [] });
  assert.throws(dispatch, /Choose an online computer with checkpoint-jobs/);
  remove('v2-computer-roles', owner, id);
  save('v2-update-reservation', 'system', { id, workers: [{ owner, id }] });
  assert.throws(dispatch, /Choose an online computer with checkpoint-jobs/);
  remove('v2-update-reservation', 'system', id);
});

test('previously unmapped deploy/browser worker checks reject reservations without coupling their switches', () => {
  const owner = 'browser',
    id = 'browser-worker';
  worker(owner, id);
  engine.setComputerRolePreferences(id, { tasks: false, computer: false });
  save('v2-computer-roles', owner, { id, workerIds: [id], roles: [] });
  assert.equal(policy.workerRoleEnabled(owner, id, 'browser'), true);
  assert.equal(policy.workerRoleEnabled(owner, id, 'deploy'), true);
  save('v2-update-reservation', 'system', { id, workers: [{ owner, id }] });
  assert.equal(policy.workerRoleEnabled(owner, id, 'browser'), false);
  assert.equal(policy.workerRoleEnabled(owner, id, 'deploy'), false);
  remove('v2-update-reservation', 'system', id);
});

test('engine deploy admission is the old SQL permission AND every node record and reservation', () => {
  const id = engine.redeemNodeEnrollment({
    code: engine.createNodeEnrollment('Deploy matrix', 'owner').code,
  }).nodeId!;
  for (const preference of [undefined, false, true]) {
    engine.getSqlite()!.prepare('DELETE FROM computer_role_preferences WHERE id=?').run(id);
    engine.setComputerRolePreferences(id, preference === undefined ? {} : { deploy: preference });
    for (const record of ['absent', 'listed', 'omitted', 'removed']) {
      if (record === 'absent') remove('v2-computer-roles', 'owner', id);
      else
        save('v2-computer-roles', 'owner', {
          id,
          workerIds: [],
          roles: record === 'omitted' ? [] : ['run-apps'],
          removed: record === 'removed',
        });
      for (const reserved of [false, true]) {
        if (reserved) save('v2-update-reservation', 'system', { id, workers: [] });
        else remove('v2-update-reservation', 'system', id);
        const expected =
          preference !== false && !reserved && !['omitted', 'removed'].includes(record);
        assert.equal(engine.deployRoleEnabled(id), expected);
        if (!expected) assert.throws(() => engine.assertDeployRole(id), /The deploy role is off/);
      }
    }
  }
  remove('v2-update-reservation', 'system', id);
  save('v2-computer-roles', 'owner', { id, workerIds: [], roles: ['run-apps'] });
  save('v2-computer-roles', 'other', { id, workerIds: [], roles: [] });
  assert.equal(
    engine.deployRoleEnabled(id),
    false,
    'an ownerless engine call cannot bypass another owner denial',
  );
  remove('v2-computer-roles', 'other', id);
  assert.equal(engine.deployRoleEnabled(id), true);
});

test('release and removal destination choices retain v2 gates and additionally respect SQL and reservations', () => {
  engine.ensureCoordinatorNode();
  const owner = 'owner';
  const project = { apps: [] } as any;
  const node = engine.redeemNodeEnrollment({
    code: engine.createNodeEnrollment('Release target', owner).code,
    agentVersion: 'test',
  }).nodeId!;
  const choices = () => releaseChoices(owner, project).computers.some((c) => c.id === node);
  assert.equal(choices(), true);
  engine
    .getSqlite()!
    .prepare(`INSERT INTO deployments(name, username, status, active_node_id)
    VALUES ('removal-sql-app', ?, 'running', 'coordinator')`)
    .run(owner);
  engine.setComputerRolePreferences(node, { deploy: false });
  assert.equal(choices(), false);
  assert.ok(!removalPlan(owner, 'coordinator').apps[0].destinations.some((c) => c.id === node));
  engine.setComputerRolePreferences(node, { deploy: true });
  save('v2-update-reservation', 'system', { id: node, workers: [] });
  assert.equal(choices(), false);
  // The removal planner uses the same destination predicate, independently of release choices.
  engine
    .getSqlite()!
    .prepare(`INSERT INTO deployments(name, username, status, active_node_id)
    VALUES ('removal-app', ?, 'running', 'coordinator')`)
    .run(owner);
  assert.ok(!removalPlan(owner, 'coordinator').apps[0].destinations.some((c) => c.id === node));
  remove('v2-update-reservation', 'system', node);
  assert.equal(choices(), true);
  assert.ok(removalPlan(owner, 'coordinator').apps[0].destinations.some((c) => c.id === node));
});

test('role dump uses old paths, includes owners and worker kinds, and writes nothing', async () => {
  const { dumpComputerRoles } = await import('../scripts/dump-computer-roles.ts');
  save('managed-worker', 'dump-owner', { id: 'managed-only' });
  db.prepare("INSERT INTO worker VALUES ('local', 1, 'test')").run();
  const changes = () => db.prepare('SELECT total_changes() AS n').get();
  const engineChanges = () => engine.getSqlite()!.prepare('SELECT total_changes() AS n').get();
  const before = changes();
  const engineBefore = engineChanges();
  const output = await dumpComputerRoles(db);
  assert.equal(await dumpComputerRoles(db), output);
  assert.deepEqual(changes(), before);
  assert.deepEqual(engineChanges(), engineBefore);
  const rows = output.split('\n').map((row) => JSON.parse(row));
  assert.ok(
    rows.some(
      (row) =>
        row.owner === 'dump-owner' &&
        row.workerId === 'managed-only' &&
        row.computerId === 'coordinator',
    ),
  );
  assert.ok(rows.some((row) => row.owner === 'dump-owner' && row.workerId === 'local'));
});

test('workspace terminal permission cannot grant a reserved worker new sessions', async () => {
  const { terminalComputer, terminalRelay } = await import('./workspace/terminal-service.ts');
  const owner = 'terminal',
    id = 'terminal-worker';
  save('worker', owner, {
    id,
    name: id,
    heartbeat: now(),
    instanceId: 'instance',
    capabilities: ['terminal'],
  });
  save('terminal-permission', owner, { id, enabled: true });
  assert.equal(terminalComputer(owner, id).enabled, true);
  save('v2-update-reservation', 'system', { id, workers: [{ owner, id }] });
  assert.equal(terminalComputer(owner, id).enabled, false);
  assert.throws(
    () => terminalRelay.start(owner, id, undefined, 80, 24, { ip: '', userAgent: '' }),
    /Terminal access is disabled/,
  );
  remove('v2-update-reservation', 'system', id);
  assert.equal(terminalComputer(owner, id).enabled, true);
  save('terminal-permission', owner, { id, enabled: false });
  assert.equal(terminalComputer(owner, id).enabled, false);
});
