import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'fleet-updates-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save, list } = await import('../workspace/store.ts');
const fleet = await import('./fleet-updates.ts');
const { updateReservation } = await import('./update-admission.ts');
const { workerRole } = await import('../workspace/computer-roles.ts');
const { workerCommand } = await import('../workspace/protocol.ts');
const { createAgentExecSession, closeAgentExecSession, claimAgentExecSession } =
  await import('../agent-exec.ts');
store.registerUser('owner', 'test-password');
store.registerUser('other', 'test-password');
after(() => {
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
const manifest = {
  version: 'new',
  packageVersion: '1',
  commit: 'new',
  commitShort: 'new',
  dirty: false,
  buildTime: '',
  runtime: '',
  targets: { 'linux-x64': { sha256: 'a'.repeat(64), size: 100 } },
};
function node(name: string, capable = true) {
  const enrollment = store.createNodeEnrollment(name, 'owner');
  const result = store.redeemNodeEnrollment({
    code: enrollment.code,
    name,
    platform: 'linux',
    architecture: 'x64',
    agentVersion: 'old',
    capabilities: { selfUpdate: capable ? 1 : 0 },
  });
  if ('error' in result) throw new Error(String(result.error));
  return result.nodeId;
}
function target(state = 'live') {
  save('v2-release', 'owner', {
    id: 'release',
    release: {
      id: 'release',
      projectId: 'project',
      apps: [{ appId: 'deploy.local', to: 'new' }],
      state,
      steps: [],
    },
    plan: { runtime: { kind: 'coordinator-self-release', id: 'activation', version: 'new' } },
  });
  save('v2-project-current', 'owner', { id: 'project', releaseId: 'release' });
  save('v2-coordinator-activation', 'system', {
    id: 'activation',
    state: 'activated',
    version: 'new',
  });
}
test('switch persists, is administrator-only, and only a proven Live coordinator release produces idempotent jobs', () => {
  assert.equal(fleet.UPDATE_INTERVAL_MS, 600000);
  assert.equal(fleet.automaticUpdates(), false);
  assert.throws(() => fleet.setAutomaticUpdates('other', true), /Administrator/);
  assert.throws(() => fleet.setAutomaticUpdates('owner', 'true'), /boolean/);
  fleet.setAutomaticUpdates('owner', true);
  assert.equal(list('v2-update-settings', 'system')[0].automatic, true);
  const supported = node('bazzite');
  const unsupported = node('old worker', false);
  target('running');
  fleet.produceComputerUpdates('owner', manifest);
  assert.equal(store.getRecentAgentJobs(supported).length, 0);
  target();
  save('v2-coordinator-activation', 'system', {
    id: 'activation',
    state: 'aborted',
    version: 'new',
  });
  fleet.produceComputerUpdates('owner', manifest);
  assert.equal(store.getRecentAgentJobs(supported).length, 0);
  target();
  fleet.produceComputerUpdates('owner', { ...manifest, version: 'wrong' });
  assert.equal(store.getRecentAgentJobs(supported).length, 0);
  fleet.produceComputerUpdates('owner', manifest);
  fleet.produceComputerUpdates('owner', manifest);
  assert.equal(store.getRecentAgentJobs(supported).length, 1);
  assert.equal(store.getRecentAgentJobs(unsupported).length, 0);
});
test('task and terminal admission stays reserved through restart; stale or wrong-version reports cannot unlock', () => {
  const id = node('MacBook');
  save('worker', 'owner', {
    id: 'worker',
    instanceId: 'process',
    name: 'MacBook',
    heartbeat: new Date().toISOString(),
  });
  save('v2-computer-roles', 'owner', { id, workerIds: ['worker'], roles: ['take-tasks'] });
  save('task', 'owner', { id: 'task', title: 'Task' });
  save('run', 'owner', { id: 'run', taskId: 'task', workerId: 'worker', status: 'running' });
  fleet.produceComputerUpdates('owner', manifest);
  assert.equal(store.claimAgentJob(id), null);
  save('run', 'owner', { id: 'run', taskId: 'task', workerId: 'worker', status: 'succeeded' });
  createAgentExecSession(id, 'home-gym', 80, 24);
  const terminal = claimAgentExecSession(id)!;
  assert.equal(store.claimAgentJob(id), null);
  closeAgentExecSession(terminal.id, id, { code: 0 });
  const job = store.claimAgentJob(id)!;
  assert.equal(job.type, 'self-update');
  assert.equal(workerRole('owner', 'worker', 'take-tasks'), false);
  save('run', 'owner', { id: 'run', taskId: 'task', workerId: 'worker', status: 'queued' });
  assert.equal(
    workerCommand('owner', '/workers/worker/poll', { instanceId: 'process' })?.run,
    null,
  );
  assert.throws(() => createAgentExecSession(id, 'home-gym', 80, 24), /updating/);
  store.enqueueAgentJob({ nodeId: id, type: 'restart', deploymentName: 'home-gym', payload: {} });
  assert.equal(store.claimAgentJob(id), null);
  const report = { ...JSON.parse(job.payload), jobId: job.id, state: 'complete', version: 'new' };
  fleet.reportComputerUpdate(id, { ...report, nonce: 'stale' }, 'new');
  fleet.reportComputerUpdate(id, report, 'old');
  assert.ok(updateReservation(id));
  fleet.reportComputerUpdate(id, report, 'new');
  assert.equal(updateReservation(id), undefined);
  assert.equal(store.getAgentJob(job.id)?.status, 'complete');
  assert.equal(workerRole('owner', 'worker', 'take-tasks'), true);
  assert.equal(store.claimAgentJob(id)?.type, 'restart');
});
test('rollback reports show failure, retain the old version and do not retry; turning the switch off cancels queued updates', () => {
  const id = node('failed replacement');
  fleet.produceComputerUpdates('owner', manifest);
  const job = store.claimAgentJob(id)!;
  fleet.reportComputerUpdate(
    id,
    {
      ...JSON.parse(job.payload),
      jobId: job.id,
      state: 'failed',
      version: 'old',
      error: 'Replacement failed startup; restored old build.',
    },
    'old',
  );
  assert.equal(updateReservation(id), undefined);
  assert.equal(store.getAgentJob(job.id)?.status, 'failed');
  assert.match(fleet.updateAttempts().find((row) => row.nodeId === id)?.error, /startup/);
  fleet.produceComputerUpdates('owner', manifest);
  assert.equal(store.getRecentAgentJobs(id).length, 1);
  const queued = node('queued');
  fleet.produceComputerUpdates('owner', manifest);
  fleet.setAutomaticUpdates('owner', false);
  assert.equal(store.claimAgentJob(queued), null);
  assert.equal(store.getRecentAgentJobs(queued)[0].status, 'failed');
});

test('a repeated startup report finishes recovery across the two durable databases', () => {
  fleet.setAutomaticUpdates('owner', true);
  const id = node('report interrupted');
  fleet.produceComputerUpdates('owner', manifest);
  const job = store.claimAgentJob(id)!;
  const report = { ...JSON.parse(job.payload), jobId: job.id, state: 'complete', version: 'new' };
  store.completeAgentJob(job.id, id, { success: true, result: { version: 'new' } });
  assert.ok(updateReservation(id));
  fleet.reportComputerUpdate(id, report, 'new');
  assert.equal(updateReservation(id), undefined);
  assert.equal(fleet.updateAttempts().find((row) => row.nodeId === id)?.state, 'complete');
});

test('computers follow the coordinator updating itself once its worker builds match what it serves', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const host = mkdtempSync(join(tmpdir(), 'fleet-self-'));
  mkdirSync(join(host, 'current'));
  writeFileSync(
    join(host, 'current', '.deploy-release.json'),
    JSON.stringify({ revision: 'abc123' }),
  );
  writeFileSync(join(host, 'release.json'), JSON.stringify({ current: join(host, 'current') }));
  process.env.DEPLOY_RELEASE_CONFIG = join(host, 'release.json');
  try {
    assert.deepEqual(
      fleet.fleetTarget('other', { ...manifest, commit: 'abc123', version: 'v-abc' }),
      {
        id: 'self-update-abc123',
        version: 'v-abc',
      },
    );
    // Builds from another commit are not what the coordinator serves.
    assert.equal(fleet.fleetTarget('other', { ...manifest, commit: 'other' }), undefined);
  } finally {
    delete process.env.DEPLOY_RELEASE_CONFIG;
    rmSync(host, { recursive: true, force: true });
  }
});

test('a computer can claim its update when the coordinator updated itself from main', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const host = mkdtempSync(join(tmpdir(), 'fleet-self-claim-'));
  const current = join(host, 'current');
  const serve = (revision: string) =>
    writeFileSync(join(current, '.deploy-release.json'), JSON.stringify({ revision }));
  mkdirSync(current);
  serve('abc123');
  writeFileSync(join(host, 'release.json'), JSON.stringify({ current }));
  mkdirSync(join(root, 'cli'));
  writeFileSync(
    join(root, 'cli', 'build-info.json'),
    JSON.stringify({ ...manifest, commit: 'abc123', version: 'v-abc', buildTime: '2026-11-08' }),
  );
  const cwd = process.cwd();
  process.env.DEPLOY_RELEASE_CONFIG = join(host, 'release.json');
  // Only the builds in the data directory: a checkout may hold its own dist/cli.
  process.chdir(host);
  try {
    fleet.setAutomaticUpdates('owner', true);
    const follows = node('follows main');
    fleet.produceComputerUpdates('other');
    const job = store.claimAgentJob(follows);
    assert.equal(job?.type, 'self-update');
    assert.equal(JSON.parse(job!.payload).targetVersion, 'v-abc');
    assert.ok(updateReservation(follows));

    // Still queued when the coordinator moves on: that build is no longer what it serves.
    const late = node('late');
    fleet.produceComputerUpdates('other');
    serve('def456');
    assert.equal(store.claimAgentJob(late), null);
    assert.match(store.getRecentAgentJobs(late)[0].error ?? '', /release changed/);
  } finally {
    process.chdir(cwd);
    delete process.env.DEPLOY_RELEASE_CONFIG;
    rmSync(host, { recursive: true, force: true });
  }
});
