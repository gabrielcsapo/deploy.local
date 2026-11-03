import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-live-test-'));
process.env.DEPLOY_DATA_DIR = root;
const { saveDeployment, updateDeploymentStatus, registerUser, authenticate, getSqlite, _resetDb } =
  await import('../store.ts');
const { issueOwnedCiCredential, revokeCiCredential } = await import('../ci-releases.ts');
const { db, save } = await import('../workspace/store.ts');
const { acceptWorkerReport, getLive } = await import('./live.ts');
const { projectReleaseService, requestWorkerRollback } = await import('./releases-api.ts');
const { putApprovalRules, projectRollbacks, currentProjectReleases } =
  await import('./releases.ts');
const { syncInbox, answerInbox } = await import('./inbox.ts');
const { waitForV2Events } = await import('./events.ts');
const { v2Api } = await import('./api.ts');
const owner = 'gabriel';
const token = registerUser(owner, 'test-password').token!;
const headers = { 'x-deploy-username': owner, 'x-deploy-token': token };
saveDeployment({ name: 'sync', username: owner, type: 'worker' });
updateDeploymentStatus('sync', 'running');
saveDeployment({ name: 'private', username: 'other', type: 'worker' });
const fetch = routeFetch((req, res) =>
  v2Api(req, res, (request, response) => {
    const username = request.headers['x-deploy-username'] as string;
    if (authenticate(username, request.headers['x-deploy-token'] as string)) return { username };
    response.writeHead(401);
    response.end('{}');
    return null;
  }),
);
const origin = 'http://localhost/api/v2';
after(() => {
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

for (const mode of ['ask', 'allow', 'never'] as const) {
  test(`failing worker uses release approval ${mode} and rolls back the whole project`, async (t) => {
    const owner = `health-${mode}`;
    const token = registerUser(owner, 'test-password').token!;
    const headers = { 'x-deploy-username': owner, 'x-deploy-token': token };
    const project = {
      id: `gym-${mode}`,
      name: 'home-gym',
      apps: [
        { id: `sync-${mode}`, name: `sync-${mode}`, kind: 'worker' as const },
        { id: `web-${mode}`, name: `web-${mode}`, kind: 'web' as const },
      ],
    };
    for (const app of project.apps) {
      saveDeployment({ name: app.id, username: owner, type: app.kind });
      updateDeploymentStatus(app.id, 'running');
    }
    const running = new Map<string, string>();
    let revision = 0;
    const runtime = projectReleaseService.runtime;
    t.mock.method(runtime, 'plan', async () => ({
      apps: project.apps.map((app) => ({ appId: app.id, to: String(revision) })),
      migrations: [],
      runtime: { revision: revision++ },
    }));
    for (const method of ['prepare', 'verify', 'migrate', 'watch', 'dispose'] as const)
      t.mock.method(runtime, method, async () => {});
    t.mock.method(runtime, 'activate', async (plan: any) => {
      for (const app of plan.apps) running.set(app.appId, app.to);
    });
    t.mock.method(runtime, 'rollback', async (_from: any, to: any) => {
      for (const app of to.apps) running.set(app.appId, app.to);
    });
    const ship = () =>
      projectReleaseService.ship(owner, project, { source: { kind: 'ship', ref: 'main' } });
    const first = ship();
    await projectReleaseService.settled();
    const second = ship();
    await projectReleaseService.settled();
    const now = Date.now();
    const releasedAt = new Date(now - 300_000).toISOString();
    save('v2-project-current', owner, { id: project.id, releaseId: second.id, releasedAt });
    putApprovalRules(owner, [
      { id: mode, agent: 'warden', action: 'rollback', mode, projectId: project.id },
    ]);
    const body = { ...report, appId: project.apps[0].id };
    const failing = {
      appId: body.appId,
      kind: 'worker' as const,
      state: 'failing' as const,
      summary: 'Jobs fail',
    };
    await requestWorkerRollback(owner, failing, now - 300_001);
    await requestWorkerRollback(owner, failing, now - 300_000 + 3600_000);
    assert.equal(syncInbox(owner).length, 0);
    assert.equal(projectRollbacks(owner, project.id).length, 0);

    for (let minute = 0; minute < 4; minute++)
      await acceptWorkerReport(
        owner,
        { ...body, failures: minute < 2 ? 1 : 40 },
        now - (4 - minute) * 60_000,
      );
    const response = await fetch(origin + '/health/report', {
      headers,
      method: 'POST',
      body: JSON.stringify({ ...body, failures: 40 }),
    });
    assert.equal(response.status, 200);
    const { app } = await response.json();
    assert.equal(app.state, 'failing');
    let items = (await (await fetch(origin + '/inbox', { headers })).json()).items;
    if (mode === 'ask') {
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.id, `rollback:${project.id}:${second.id}`);
      assert.equal(item.title, 'Roll back home-gym?');
      assert.equal(item.context, null);
      const live = await getLive(owner);
      const worker = live.computers.flatMap((c) => c.apps).find((a) => a.appId === body.appId)!;
      assert.equal(worker.release, second.id);
      assert.equal(worker.releasedAt, releasedAt);
      await requestWorkerRollback(owner, app, now);
      assert.equal(syncInbox(owner).length, 1);
      const answer = await fetch(origin + `/inbox/${encodeURIComponent(item.id)}/answer`, {
        headers,
        method: 'POST',
        body: JSON.stringify({ actionId: 'rollback', on: 'web' }),
      });
      assert.equal(answer.status, 200);
      assert.equal((await answer.json()).item.answer.actionId, 'rollback');
      assert.throws(() => answerInbox(owner, item.id, { actionId: 'keep', on: 'cli' }), {
        status: 409,
      });
    } else assert.equal(items.length, 0);
    await projectReleaseService.settled();
    const rollbacks = projectRollbacks(owner, project.id);
    assert.equal(rollbacks.length, mode === 'never' ? 0 : 1);
    assert.deepEqual([...running.values()], mode === 'never' ? ['1', '1'] : ['0', '0']);
    if (mode !== 'never') {
      assert.equal(rollbacks[0].from, second.id);
      assert.equal(rollbacks[0].to, first.id);
      assert.equal(rollbacks[0].approvedBy, mode === 'allow' ? 'rule' : owner);
      assert.equal(currentProjectReleases(owner)[0].id, first.id);
      const live = await getLive(owner);
      assert(live.computers.flatMap((c) => c.apps).every((a) => a.release === first.id));
    }
    const events = await waitForV2Events(owner, 0, 0, new AbortController().signal);
    assert(events.events.some((e) => e.type === 'health'));
    assert(events.events.some((e) => e.type === 'release'));
    if (mode !== 'never') assert(events.events.some((e) => e.type === 'rollback'));
    assert(events.events.every((e) => e.type !== 'inbox' || e.item.context == null));
  });
}

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
  const { createInboxItem, registerInboxAction } = await import('./inbox.ts');
  const item = createInboxItem(
    owner,
    {
      id: 'rollback:available',
      kind: 'rollback',
      from: 'warden',
      title: 'Roll back home-gym?',
      text: 'Jobs fail.',
      projectId: 'home-gym',
      createdAt: new Date().toISOString(),
      state: 'waiting',
      actions: [{ id: 'rollback', label: 'Roll back home-gym' }],
    },
    { secret: 'private project context' },
  );
  let requests = 0;
  const unregister = registerInboxAction('rollback', (_owner, decision, body, context) => {
    assert.equal(body.actionId, 'rollback');
    assert.equal(context.secret, 'private project context');
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
    projectReleaseService.registerInbox();
  }
});

test('rollback outcomes require continuous health and retain rule provenance', async () => {
  const { updateRollbackOutcomes } = await import('./live.ts');
  const { createInboxItem } = await import('./inbox.ts');
  const projectId = 'outcome-project';
  const rollback: import('../../shared/v2/contracts.ts').Rollback = {
    id: 'observed-rollback',
    projectId,
    from: 'bad',
    to: 'good',
    reason: 'Jobs failed',
    approvedBy: 'rule',
    steps: [{ name: 'activate', state: 'done', endedAt: new Date(0).toISOString() }],
  };
  const app: import('../../shared/v2/contracts.ts').LiveApp = {
    appId: 'outcome-app',
    name: 'Worker',
    kind: 'worker',
    state: 'healthy',
    summary: 'Healthy',
    project: projectId,
    release: 'good',
  };
  const outcome = () =>
    syncInbox(owner).find((item) => item.id === `rollback:${projectId}:bad`)?.outcome;
  updateRollbackOutcomes(owner, [rollback], [app], 0);
  assert.deepEqual(outcome(), { text: 'Allowed by rule', tone: 'neutral' });
  updateRollbackOutcomes(owner, [rollback], [app], 600000);
  assert.equal(outcome()?.tone, 'neutral', 'a gap does not prove ten healthy minutes');
  for (let at = 660000; at <= 1200000; at += 60000)
    updateRollbackOutcomes(owner, [rollback], [app], at);
  assert.deepEqual(outcome(), { text: 'Healthy after 10 min', tone: 'ok' });
  updateRollbackOutcomes(owner, [rollback], [app], 2400000);
  assert.deepEqual(
    outcome(),
    { text: 'Healthy after 10 min', tone: 'ok' },
    'history retains the observed result after a polling gap',
  );
  assert.equal(
    syncInbox('other').some((item) => item.id.includes(projectId)),
    false,
  );
  const manual = { ...rollback, id: 'manual-rollback', from: 'manual', approvedBy: owner };
  createInboxItem(
    owner,
    {
      id: `rollback:${projectId}:manual`,
      kind: 'rollback',
      title: 'Rollback',
      text: '',
      from: 'warden',
      projectId,
      createdAt: new Date(0).toISOString(),
      state: 'answered',
      actions: [],
    },
    {},
  );
  updateRollbackOutcomes(owner, [manual], [app], 0);
  for (let at = 60000; at <= 600000; at += 60000)
    updateRollbackOutcomes(
      owner,
      [manual],
      [{ ...app, state: at === 300000 ? 'failing' : 'healthy' }],
      at,
    );
  assert.equal(syncInbox(owner).find((item) => item.id.endsWith(':manual'))?.outcome, undefined);
});

test('Live exposes project membership, catalog origin and immutable source metadata without leaking other owners', async () => {
  const username = 'live-provenance';
  const provenanceToken = registerUser(username, 'test-password').token!;
  const provenanceHeaders = { 'x-deploy-username': username, 'x-deploy-token': provenanceToken };
  const database = getSqlite()!;
  save('project', username, { id: 'forma-project', name: 'forma' });
  for (const name of ['forma-web', 'forma-jobs', 'photos', 'unlinked']) {
    saveDeployment({ name, username, type: 'worker' });
    updateDeploymentStatus(name, 'running');
  }
  database
    .prepare('INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?)')
    .run('forma-jobs', username, 'forma-project');
  const at = new Date().toISOString();
  database
    .prepare(`INSERT INTO catalog_installations(id,application_name,blueprint_id,release,blueprint_digest,installed_spec_digest,current_spec_digest,site_id,mode,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      'photos-install',
      'photos',
      'immich',
      '1',
      'd',
      'd',
      'd',
      's',
      'native',
      'installed',
      at,
      at,
    );
  const source = {
    kind: 'ship',
    ref: 'main',
    gitRef: 'main',
    commit: 'a1b2c3d' + '0'.repeat(33),
    message: 'Fix the sign-in redirect loop',
  };
  const release = {
    id: 'stable-release-id',
    projectId: 'forma-project',
    source,
    startedBy: username,
    apps: [{ appId: 'forma-web', to: 'artifact' }],
    migrations: [],
    steps: [],
    state: 'live',
  };
  save('v2-release', username, { id: release.id, release });
  save('v2-project-current', username, {
    id: 'forma-project',
    releaseId: release.id,
    releasedAt: at,
  });
  const response = await fetch(origin + '/live', { headers: provenanceHeaders });
  assert.equal(response.status, 200);
  const live = await response.json();
  const apps = live.computers.flatMap((computer: any) => computer.apps);
  assert.deepEqual(apps.find((app: any) => app.appId === 'forma-web').source, source);
  assert.equal(apps.find((app: any) => app.appId === 'forma-web').release, release.id);
  assert.equal(apps.find((app: any) => app.appId === 'forma-jobs').project, 'forma-project');
  assert.equal(apps.find((app: any) => app.appId === 'photos').fromDiscover, true);
  assert.equal(apps.find((app: any) => app.appId === 'unlinked').project, undefined);
  assert.equal(apps.find((app: any) => app.appId === 'unlinked').fromDiscover, undefined);
  const detail = await (
    await fetch(origin + '/live/forma-web', { headers: provenanceHeaders })
  ).json();
  assert.deepEqual(detail.release.source, source);
  assert.equal((await fetch(origin + '/live/private', { headers: provenanceHeaders })).status, 404);
});
