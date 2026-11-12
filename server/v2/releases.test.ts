import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Project } from '../../shared/v2/contracts.ts';
import type { ReleaseRuntime } from './releases.ts';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-releases-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, list, get, save } = await import('../workspace/store.ts');
const { ProjectReleaseService, projectReleases, projectRollbacks, putApprovalRules } =
  await import('./releases.ts');
const { groupProjects } = await import('./projects.ts');
const { answerInbox, syncInbox } = await import('./inbox.ts');
const { waitForV2Events } = await import('./events.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const project: Project = {
  id: 'gym',
  name: 'home-gym',
  apps: [
    { id: 'web', name: 'web', kind: 'web' },
    { id: 'sync', name: 'sync', kind: 'worker' },
  ],
};
function fixture() {
  const owner = randomUUID();
  let revision = 0;
  const running = new Map(project.apps.map((app) => [app.id, 'original']));
  const calls: string[] = [];
  const runtime: ReleaseRuntime = {
    async plan(p) {
      return {
        apps: p.apps.map((app) => ({
          appId: app.id,
          from: running.get(app.id),
          to: String(revision),
        })),
        migrations: [],
        runtime: { revision: revision++ },
      };
    },
    async prepare() {
      calls.push('prepare');
    },
    async verify() {
      calls.push('verify');
    },
    async backup(plan) {
      calls.push('backup');
      return {
        id: 'backup-1',
        capturedAt: '2026-10-27T14:00:00Z',
        apps: plan.apps.map((app) => app.appId),
        runtime: {},
      };
    },
    async activate(plan) {
      calls.push('activate');
      for (const app of plan.apps) running.set(app.appId, app.to);
    },
    async migrate() {
      calls.push('migrate');
    },
    async watch(_plan, milliseconds) {
      assert.equal(milliseconds, 10);
      calls.push('watch');
    },
    async rollback(_from, to) {
      calls.push('rollback');
      for (const app of to.apps) running.set(app.appId, app.to);
    },
    async dispose() {
      calls.push('dispose');
    },
  };
  const service = new ProjectReleaseService(runtime, { watchMs: 10 });
  const ship = () =>
    service.ship(owner, project, { source: { kind: 'ship', ref: 'main' }, startedBy: 'scout' });
  return { owner, runtime, service, running, calls, ship };
}

test('workspace membership, two apps, and one-app fallback use one projection', () => {
  assert.deepEqual(
    groupProjects(
      [{ id: 'gym', name: 'home-gym' }],
      [...project.apps, { id: 'other', name: 'other', kind: 'web' }],
      [
        { projectId: 'gym', application: 'web' },
        { projectId: 'gym', application: 'sync' },
      ],
    ),
    [
      project,
      { id: 'app:other', name: 'other', apps: [{ id: 'other', name: 'other', kind: 'web' }] },
    ],
  );
  assert.throws(
    () =>
      groupProjects(
        [
          { id: 'a', name: 'a' },
          { id: 'b', name: 'b' },
        ],
        project.apps,
        [
          { projectId: 'a', application: 'web' },
          { projectId: 'b', application: 'web' },
        ],
      ),
    { status: 409 },
  );
});
test('failed verify leaves every app untouched, skips activate and watch', async () => {
  const f = fixture();
  f.runtime.verify = async () => {
    throw new Error('copy returned HTTP 500');
  };
  const release = f.ship();
  await f.service.settled();
  const stored = projectReleases(f.owner, project.id)[0];
  assert.equal(release.startedBy, f.owner);
  assert.equal(stored.state, 'failed');
  assert.deepEqual(
    stored.steps.map((step) => step.state),
    ['done', 'failed', 'skipped', 'skipped'],
  );
  assert.deepEqual([...f.running.values()], ['original', 'original']);
  assert(!f.calls.includes('activate'));
  assert.equal(list('v2-project-run', f.owner).length, 0);
});
test('a project locked by a failed cleanup unlocks once the computer can clean up', async () => {
  // The iMac on 2026-11-10: Docker was down, so Verify failed and so did removing the copy.
  const f = fixture();
  let dockerUp = false;
  f.runtime.verify = async () => {
    throw new Error('failed to connect to the docker API');
  };
  f.runtime.dispose = async () => {
    f.calls.push('dispose');
    if (!dockerUp) throw new Error('failed to connect to the docker API');
  };
  f.ship();
  await f.service.settled();
  assert.match(projectReleases(f.owner, project.id)[0].steps.at(-1)!.detail!, /^Cleanup requires/);
  assert.throws(() => f.ship(), { status: 409 });
  // Still down: nothing changes and the project stays locked.
  await f.service.retryCleanup();
  assert.throws(() => f.ship(), { status: 409 });
  dockerUp = true;
  await f.service.retryCleanup();
  assert.equal(list('v2-project-run', f.owner).length, 0);
  assert.equal(projectReleases(f.owner, project.id)[0].state, 'failed');
  f.runtime.verify = async () => {};
  f.runtime.dispose = async () => {};
  f.ship();
  await f.service.settled();
  assert.equal(projectReleases(f.owner, project.id)[0].state, 'live');
  assert.deepEqual([...f.running.values()], ['1', '1']);
});
test('a release whose recovery after a restart could not reach its computer unlocks later', async () => {
  // Forma on 2026-11-11: a release was running when the coordinator restarted, the iMac's
  // Docker was down, and the project stayed locked after Docker came back.
  const f = fixture();
  let dockerUp = false;
  f.runtime.verify = async () => {
    throw new Error('failed to connect to the docker API');
  };
  f.runtime.dispose = async () => {
    if (!dockerUp) throw new Error('Cannot connect to the Docker daemon');
  };
  f.ship();
  await f.service.settled();
  // What recovery wrote before it marked such releases as owing cleanup.
  const record = list('v2-release', f.owner)[0];
  record.cleanupOwed = false;
  const steps = record.release.steps;
  steps[0].state = 'failed';
  steps[0].detail = 'Recovery: Computer release job has not completed; recovery will follow';
  steps[1].state = 'skipped';
  steps[1].detail = undefined;
  steps[2].state = 'failed';
  steps[2].detail =
    'Recovery: Release computer operation failed: Cannot connect to the Docker daemon';
  steps[3].detail = undefined;
  save('v2-release', f.owner, record);
  await f.service.retryCleanup();
  assert.throws(() => f.ship(), { status: 409 });
  dockerUp = true;
  await f.service.retryCleanup();
  assert.equal(list('v2-project-run', f.owner).length, 0);
});
test('cleanup is not retried for a release that got past Verify', async () => {
  const f = fixture();
  f.runtime.activate = async () => {
    throw new Error('activation failed');
  };
  f.runtime.dispose = async () => {
    f.calls.push('dispose');
    if (f.calls.filter((call) => call === 'dispose').length === 1) throw new Error('docker down');
  };
  f.ship();
  await f.service.settled();
  await f.service.retryCleanup();
  assert.equal(f.calls.filter((call) => call === 'dispose').length, 1);
  assert.equal(list('v2-project-run', f.owner).length, 1);
  db.prepare("DELETE FROM records WHERE kind='v2-project-run' AND owner=?").run(f.owner);
});
test('rollback moves all apps and reverses the crossed migrations', async () => {
  const f = fixture();
  const first = f.ship();
  await f.service.settled();
  const plan = f.runtime.plan;
  f.runtime.plan = async (p) => ({
    ...(await plan(p)),
    migrations: [{ id: '0042', title: 'Add sync column', reversible: true }],
  });
  const second = f.ship();
  await f.service.settled();
  f.runtime.rollback = async (from, to) => {
    assert.deepEqual(
      from.migrations.map((m) => m.id),
      ['0042'],
    );
    for (const app of to.apps) f.running.set(app.appId, app.to);
  };
  const { rollback } = f.service.rollback(f.owner, project, { from: second.id, to: first.id });
  await f.service.settled();
  assert.deepEqual([...f.running.values()], ['0', '0']);
  assert.equal(projectRollbacks(f.owner, project.id)[0].steps.at(-1)!.state, 'done');
  assert.equal(rollback.approvedBy, f.owner);
  assert.equal(
    projectReleases(f.owner, project.id).find((r) => r.id === second.id)!.state,
    'rolled-back',
  );
});
test('durable project reservation refuses concurrent ship and rollback', async () => {
  const f = fixture();
  const release = f.ship();
  const other = new ProjectReleaseService(f.runtime, { watchMs: 10 });
  assert.throws(() => other.ship(f.owner, project, { source: { kind: 'ship', ref: 'main' } }), {
    status: 409,
  });
  assert.throws(() => other.rollback(f.owner, project, {}), { status: 409 });
  assert.equal(get('v2-project-run', f.owner, project.id).operationId, release.id);
  await f.service.settled();
});
test('irreversible migration takes a backup before activate, requires exact restore consent', async () => {
  const f = fixture();
  const first = f.ship();
  await f.service.settled();
  const originalPlan = f.runtime.plan;
  f.runtime.plan = async (p) => ({
    ...(await originalPlan(p)),
    migrations: [{ id: '0042', title: 'Drop column', reversible: false }],
  });
  f.calls.length = 0;
  const second = f.ship();
  await f.service.settled();
  assert(f.calls.indexOf('backup') < f.calls.indexOf('activate'));
  assert.throws(
    () => f.service.rollback(f.owner, project, { to: first.id }),
    (error: any) =>
      error.status === 409 &&
      error.dataLoss.capturedAt === '2026-10-27T14:00:00Z' &&
      error.dataLoss.summary.includes('all data written after'),
  );
  assert.throws(
    () => f.service.rollback(f.owner, project, { to: first.id, confirmBackupId: 'wrong' }),
    { status: 409 },
  );
  f.runtime.rollback = async (_from, to, backup) => {
    assert.equal(backup!.id, 'backup-1');
    for (const app of to.apps) f.running.set(app.appId, app.to);
  };
  const response = f.service.rollback(f.owner, project, {
    from: second.id,
    to: first.id,
    confirmBackupId: 'backup-1',
  });
  assert(response.dataLoss!.summary.includes('web, sync'));
  await f.service.settled();
});
test('missing or incomplete backup never activates or restores', async () => {
  const f = fixture();
  f.ship();
  await f.service.settled();
  const originalPlan = f.runtime.plan;
  f.runtime.plan = async (p) => ({
    ...(await originalPlan(p)),
    migrations: [{ id: '42', title: 'Drop column', reversible: false }],
  });
  f.runtime.backup = async () => ({ id: 'bad', apps: ['web'], capturedAt: 'now', runtime: {} });
  f.calls.length = 0;
  f.ship();
  await f.service.settled();
  assert(!f.calls.includes('activate'));
  assert.deepEqual([...f.running.values()], ['0', '0']);
});
test('Warden defaults to one shared decision; first answer starts the whole rollback', async (t) => {
  const f = fixture();
  t.after(f.service.registerInbox());
  f.ship();
  await f.service.settled();
  f.ship();
  await f.service.settled();
  f.service.requestAutoRollback(f.owner, project, '38% of jobs fail');
  f.service.requestAutoRollback(f.owner, project, '38% of jobs fail');
  assert.equal(syncInbox(f.owner).length, 1);
  assert.deepEqual([...f.running.values()], ['1', '1']);
  const item = syncInbox(f.owner)[0];
  const answer = answerInbox(f.owner, item.id, { actionId: 'rollback', on: 'cli' });
  assert.equal(answer.state, 'answered');
  assert.throws(() => answerInbox(f.owner, item.id, { actionId: 'keep', on: 'web' }), {
    status: 409,
  });
  await f.service.settled();
  assert.deepEqual([...f.running.values()], ['0', '0']);
});
test('only an explicit, matching allow rule permits auto-rollback', async () => {
  const f = fixture();
  f.ship();
  await f.service.settled();
  f.ship();
  await f.service.settled();
  assert.throws(() => f.service.rollback(f.owner, project, {}, 'rule', 'invented'), {
    status: 403,
  });
  putApprovalRules(f.owner, [
    { id: 'a', agent: 'warden', action: 'rollback', mode: 'allow', projectId: 'other' },
  ]);
  assert('item' in f.service.requestAutoRollback(f.owner, project, 'health failed'));
  putApprovalRules(f.owner, [
    { id: 'a', agent: 'warden', action: 'rollback', mode: 'allow', projectId: project.id },
  ]);
  const response = f.service.requestAutoRollback(f.owner, project, 'health failed');
  assert('rollback' in response && response.rollback.approvedBy === 'rule');
  await f.service.settled();
  assert.deepEqual([...f.running.values()], ['0', '0']);
});
test('project never overrides global allow; unsupported limits fail closed', async () => {
  const f = fixture();
  f.ship();
  await f.service.settled();
  f.ship();
  await f.service.settled();
  putApprovalRules(f.owner, [
    { id: 'global', agent: 'warden', action: 'rollback', mode: 'allow' },
    { id: 'local', agent: 'warden', action: 'rollback', mode: 'never', projectId: project.id },
  ]);
  assert.deepEqual(f.service.requestAutoRollback(f.owner, project, 'failure'), { allowed: false });
  assert.equal(syncInbox(f.owner).length, 0);
  putApprovalRules(f.owner, [
    { id: 'limited', agent: 'warden', action: 'rollback', mode: 'allow', limit: 'once a day' },
  ]);
  assert('item' in f.service.requestAutoRollback(f.owner, project, 'failure'));
});
test('an allow rule cannot silently discard data', async () => {
  const f = fixture();
  f.ship();
  await f.service.settled();
  const plan = f.runtime.plan;
  f.runtime.plan = async (p) => ({
    ...(await plan(p)),
    migrations: [{ id: '42', title: 'Drop column', reversible: false }],
  });
  f.ship();
  await f.service.settled();
  putApprovalRules(f.owner, [{ id: 'allow', agent: 'warden', action: 'rollback', mode: 'allow' }]);
  assert('item' in f.service.requestAutoRollback(f.owner, project, 'failed'));
  assert.deepEqual([...f.running.values()], ['1', '1']);
});
test('migration failure retains the correct current release for rollback', async () => {
  const f = fixture();
  const first = f.ship();
  await f.service.settled();
  f.runtime.migrate = async () => {
    throw new Error('migration failed');
  };
  const second = f.ship();
  await f.service.settled();
  assert.equal(projectReleases(f.owner, project.id)[0].state, 'failed');
  f.service.rollback(f.owner, project, { from: second.id, to: first.id });
  await f.service.settled();
  assert.deepEqual([...f.running.values()], ['0', '0']);
});
test('rollback ancestry excludes unsuccessful and already rolled back branches', async () => {
  const f = fixture();
  const first = f.ship();
  await f.service.settled();
  f.ship();
  await f.service.settled();
  f.service.rollback(f.owner, project, { to: first.id });
  await f.service.settled();
  const third = f.ship();
  await f.service.settled();
  f.service.rollback(f.owner, project, { from: third.id, to: first.id });
  await f.service.settled();
  assert.deepEqual([...f.running.values()], ['0', '0']);
});
test('every step is emitted with owner isolation and monotonic cursors', async () => {
  const f = fixture();
  f.ship();
  await f.service.settled();
  const result = await waitForV2Events(f.owner, 0, 0, new AbortController().signal);
  const events = result.events.filter((row) => row.type === 'release');
  assert(events.some((row) => row.release.steps[1].state === 'running'));
  assert.equal(events.at(-1)!.release.state, 'live');
  assert(events.every((row, index) => index === 0 || row.cursor > events[index - 1].cursor));
  assert.equal(
    (await waitForV2Events('different-owner', 0, 0, new AbortController().signal)).events.length,
    0,
  );
});
test('interrupted durable reservation is not silently stolen by a new process', async () => {
  const f = fixture();
  save('v2-project-run', f.owner, {
    id: project.id,
    apps: ['web', 'sync'],
    operationId: 'interrupted',
  });
  assert.throws(() => f.ship(), { status: 409 });
  const restoring = fixture();
  const first = restoring.ship();
  await restoring.service.settled();
  restoring.ship();
  await restoring.service.settled();
  restoring.runtime.rollback = async () => {
    throw Object.assign(new Error('restore interrupted'), { requiresRecovery: true });
  };
  restoring.service.rollback(restoring.owner, project, { to: first.id });
  await restoring.service.settled();
  assert.throws(() => restoring.ship(), { status: 409 });
  assert.match(
    projectRollbacks(restoring.owner, project.id)[0].steps.find((step) => step.state === 'failed')!
      .detail!,
    /locked for recovery/,
  );
});
test('invalid approval updates are atomic', () => {
  const f = fixture();
  putApprovalRules(f.owner, [{ id: 'a', agent: 'warden', action: 'rollback', mode: 'ask' }]);
  assert.throws(() =>
    putApprovalRules(f.owner, [{ id: 'b', agent: 'warden', action: 'rollback', mode: 'unknown' }]),
  );
  assert.equal(list('v2-approval', f.owner)[0].id, 'a');
});

test('agent and worker tokens cannot Ship through the actual v2 router', async () => {
  const { v2Api } = await import('./api.ts');
  const fetch = routeFetch((req, res) => v2Api(req, res, () => ({ username: 'owner' })));
  for (const header of ['x-deploy-agent-token', 'x-deploy-worker-token']) {
    const response = await fetch(`http://localhost/api/v2/projects/home-gym/releases`, {
      method: 'POST',
      headers: { [header]: 'credential', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'ship', ref: 'main' } }),
    });
    assert.equal(response.status, 403);
  }
  const put = await fetch(`http://localhost/api/v2/approvals`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rules: [{ id: 'rule', agent: 'warden', action: 'rollback', mode: 'ask' }],
    }),
  });
  assert.equal(put.status, 200);
  const response = await fetch(`http://localhost/api/v2/approvals`);
  assert.equal((await response.json()).rules[0].mode, 'ask');
  const projects = await fetch(`http://localhost/api/v2/projects`);
  assert.deepEqual(await projects.json(), { projects: [] });
});

test('retention keeps the current release plus N prior releases and leaves backup audit records', async () => {
  const { putProjectReleasePolicy } = await import('./project-policy.ts');
  const f = fixture();
  putProjectReleasePolicy(f.owner, project, { keepReleases: 1, verifyMigrations: false });
  const verified: boolean[] = [];
  f.runtime.verify = async (plan) => {
    verified.push(plan.verifyMigrations!);
  };
  const first = f.ship();
  await f.service.settled();
  const second = f.ship();
  await f.service.settled();
  const third = f.ship();
  await f.service.settled();
  assert.deepEqual(verified, [false, false, false]);
  assert.equal(get('v2-release', f.owner, first.id).plan, undefined);
  assert.ok(get('v2-release', f.owner, first.id).release);
  assert.ok(get('v2-release', f.owner, second.id).plan);
  assert.ok(get('v2-release', f.owner, third.id).plan);
  assert.throws(
    () => f.service.rollback(f.owner, project, { to: first.id }, f.owner),
    /prior release/,
  );
});

test('releases retain verified commit metadata while keeping their stable identity and source label', async () => {
  const f = fixture();
  const plan = f.runtime.plan;
  const source = {
    commit: '9c3e1fa' + '0'.repeat(33),
    message: 'Rename workouts.started to started_at',
    gitRef: 'main',
  };
  f.runtime.plan = async (...args) => ({ ...(await plan(...args)), source });
  const accepted = f.ship();
  await f.service.settled();
  const stored = projectReleases(f.owner, project.id)[0];
  assert.equal(stored.id, accepted.id);
  assert.notEqual(stored.id, source.commit);
  assert.deepEqual(stored.source, { kind: 'ship', ref: 'main', ...source });
});
