import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { routeFetch } from './test-request.ts';
import {
  projectDocumentUrl,
  projectPath,
  projectTabs,
} from '../../app/routes/dashboard/v2/projects/routing.ts';

const root = mkdtempSync(join(tmpdir(), 'v2-projects-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { projectsForOwner, resolveProject, addProjectApplication } = await import('./projects.ts');
const { readProjectSettings, putProjectSettings, putProjectSecret } = await import('./settings.ts');
const configuration = await import('../application-configuration.ts');
const { projectLogSources } = await import('./logs.ts');
const { v2Api } = await import('./api.ts');
const repo = join(root, 'repo');
mkdirSync(repo);
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
git('init', '-b', 'main');
writeFileSync(
  join(repo, 'deploy.yaml'),
  'apiVersion: deploy.local/v1\nkind: Application\nmetadata:\n  name: web\ncomponents:\n  web:\n    image: example/web\n',
);
git('add', '.');
git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', 'fixture');
workspace.save('project', 'owner', {
  id: 'gym',
  name: 'deploy.local',
  repositoryPath: repo,
  sourcePath: repo,
  defaultBranch: 'main',
});
store.saveDeployment({ name: 'web', username: 'owner' });
store.saveDeployment({ name: 'sync', username: 'owner' });
store.saveDeployment({ name: 'private', username: 'other' });
const fetch = routeFetch((req, res) =>
  v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') })),
);
const origin = 'http://127.0.0.1:5180';
async function api(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${origin}/api/v2${path}`, {
    method,
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
after(async () => {
  store._resetDb();
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('migrates repository membership, adds a second app, persists links and isolates owners', async () => {
  assert.deepEqual(
    (await resolveProject('owner', 'deploy.local')).apps.map((app) => app.id),
    ['web'],
  );
  assert.equal(
    store
      .getSqlite()!
      .prepare('SELECT project_id FROM project_applications WHERE application=?')
      .get('web') && true,
    true,
  );
  const added = await api('/projects/gym/apps', 'POST', { app: 'sync' });
  assert.equal(added.status, 200);
  assert.equal(added.body.project.apps.length, 2);
  assert.equal((await resolveProject('owner', 'gym')).apps.length, 2);
  assert.equal((await api('/projects/gym/apps', 'POST', { app: 'private' })).status, 404);
  assert.equal(
    (await api('/projects/gym/settings', 'GET', undefined, { 'x-test-owner': 'other' })).status,
    404,
  );
  assert.equal(
    (await api('/projects')).body.projects.find((project: any) => project.id === 'gym').apps.length,
    2,
  );
  assert.equal(
    (await projectsForOwner('other')).some((project) =>
      project.apps.some((app) => app.name === 'web'),
    ),
    false,
  );
});

test('a standalone app that was deleted leaves no empty project behind', async () => {
  const database = store.getSqlite()!;
  database
    .prepare('INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?)')
    .run('gone', 'owner', 'app:gone');
  assert.equal(
    (await projectsForOwner('owner')).some((project) => project.id === 'app:gone'),
    false,
  );
  assert.equal(
    database.prepare('SELECT 1 FROM project_applications WHERE application=?').get('gone'),
    undefined,
  );
  // A removal that can still be retried keeps its row.
  database
    .prepare('INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?)')
    .run('leaving', 'owner', 'app:leaving');
  workspace.save('v2-project-removal', 'owner', { id: 'app:leaving', project: { apps: [] } });
  await projectsForOwner('owner');
  assert.ok(
    database.prepare('SELECT 1 FROM project_applications WHERE application=?').get('leaving'),
  );
  workspace.remove('v2-project-removal', 'owner', 'app:leaving');
  await projectsForOwner('owner');
});

test('migrates configuration once without plaintext secrets and applies shared values with app overrides', async () => {
  const declarations = {
    TOKEN: { type: 'secret' as const, required: true, scope: 'application' as const },
    MODE: { type: 'string' as const, required: true, scope: 'application' as const },
  };
  store
    .getSqlite()!
    .prepare('UPDATE deployments SET active_spec_digest=? WHERE name=?')
    .run('sha256:test', 'web');
  for (const [key, value] of Object.entries({ TOKEN: 'never-return-this', MODE: 'production' }))
    configuration.setDeclaredConfigurationValue({
      deploymentName: 'web',
      specDigest: 'sha256:test',
      declarations,
      key,
      value,
      updatedBy: 'owner',
    });
  const project = await resolveProject('owner', 'gym');
  const settings = readProjectSettings('owner', project);
  assert.equal(JSON.stringify(settings).includes('never-return-this'), false);
  assert.equal(settings.values.find((row) => row.key === 'TOKEN')?.set, true);
  assert.equal(settings.values.find((row) => row.key === 'TOKEN')?.value, undefined);
  assert.equal(settings.values.find((row) => row.key === 'MODE')?.value, 'production');
  putProjectSettings('owner', project, {
    values: [
      { key: 'MODE', value: 'shared' },
      { key: 'MODE', app: 'web', value: 'override' },
    ],
  });
  const resolved = configuration.resolveApplicationConfiguration({
    deploymentName: 'web',
    specDigest: 'sha256:test',
    declarations,
  });
  assert.equal(resolved.values.TOKEN, 'never-return-this');
  assert.equal(resolved.values.MODE, 'override');
  assert.equal(
    configuration.resolveApplicationConfiguration({
      deploymentName: 'sync',
      specDigest: 'sha256:other',
      declarations,
    }).values.MODE,
    'shared',
  );
  readProjectSettings('owner', project);
  assert.equal(
    configuration.resolveApplicationConfiguration({
      deploymentName: 'web',
      specDigest: 'sha256:test',
      declarations,
    }).values.MODE,
    'override',
  );
  assert.equal(
    store
      .getSqlite()!
      .prepare('SELECT value FROM project_configuration WHERE key=?')
      .get('TOKEN') &&
      JSON.stringify(
        store
          .getSqlite()!
          .prepare('SELECT value FROM project_configuration WHERE key=?')
          .get('TOKEN'),
      ).includes('never-return-this'),
    false,
  );
});

test('a configured standalone app carries its encrypted overrides when it joins a project', async () => {
  store.saveDeployment({ name: 'extra', username: 'owner' });
  const standalone = await resolveProject('owner', 'app:extra');
  putProjectSecret('owner', standalone, 'EXTRA_TOKEN', { value: 'move-me' });
  putProjectSettings('owner', standalone, { values: [{ key: 'MODE', value: 'standalone' }] });
  const joined = await addProjectApplication('owner', 'gym', 'extra');
  assert.equal(joined.apps.length, 3);
  const resolved = configuration.resolveApplicationConfiguration({
    deploymentName: 'extra',
    specDigest: 'sha256:extra',
    declarations: {
      EXTRA_TOKEN: { type: 'secret', required: true, scope: 'application' },
      MODE: { type: 'string', required: true, scope: 'application' },
    },
  });
  assert.equal(resolved.values.EXTRA_TOKEN, 'move-me');
  assert.equal(resolved.values.MODE, 'standalone');
  assert.equal(
    readProjectSettings('owner', joined).values.find((row) => row.key === 'EXTRA_TOKEN')?.value,
    undefined,
  );
});

test('settings and secrets API is write-only, validates scope, rejects agents, and deletion cannot resurrect migrated secrets', async () => {
  let result = await api('/projects/deploy.local/secrets/TOKEN?app=sync', 'PUT', {
    value: 'new-secret',
  });
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result.body).includes('new-secret'), false);
  result = await api('/projects/gym/settings');
  assert.equal(JSON.stringify(result.body).includes('new-secret'), false);
  assert.equal(
    (
      await api('/projects/gym/settings', 'PUT', {
        values: [{ key: 'TOKEN', app: 'sync', value: 'leak' }],
      })
    ).status,
    409,
  );
  assert.equal(
    (await api('/projects/gym/secrets/TOKEN', 'PUT', { value: 'no', app: 'private' })).status,
    404,
  );
  assert.equal(
    (
      await api(
        '/projects/gym/settings',
        'PUT',
        { values: [{ key: 'MODE', value: 'no' }] },
        { 'x-deploy-agent-token': 'agent' },
      )
    ).status,
    403,
  );
  assert.equal((await api('/projects/gym/secrets/TOKEN?app=web', 'DELETE')).status, 200);
  const project = await resolveProject('owner', 'gym');
  readProjectSettings('owner', project);
  const resolved = configuration.resolveApplicationConfiguration({
    deploymentName: 'web',
    specDigest: 'sha256:test',
    declarations: { TOKEN: { type: 'secret', required: true, scope: 'application' } },
  });
  assert.deepEqual(resolved.missing, ['TOKEN']);
  assert.throws(() => putProjectSecret('owner', project, 'MODE', {}, true), { status: 409 });
  putProjectSecret('owner', project, 'SHARED_TOKEN', { value: 'shared-secret' });
  putProjectSecret('owner', project, 'SHARED_TOKEN', { app: 'web', value: 'override-secret' });
  putProjectSecret('owner', project, 'SHARED_TOKEN', { app: 'web' }, true);
  assert.equal(
    configuration.resolveApplicationConfiguration({
      deploymentName: 'web',
      specDigest: 'sha256:test',
      declarations: { SHARED_TOKEN: { type: 'secret', required: true, scope: 'application' } },
    }).values.SHARED_TOKEN,
    'shared-secret',
  );
  assert.equal(
    (
      await api('/projects/gym/settings', 'PUT', {
        values: [
          { key: 'GOOD', value: 'first' },
          { key: 'bad key', value: 'last' },
        ],
      })
    ).status,
    400,
  );
  assert.equal(
    readProjectSettings('owner', project).values.some((row) => row.key === 'GOOD'),
    false,
  );
});

test('membership is fenced during releases and cannot move an app between repository projects', async () => {
  workspace.save('project', 'owner', {
    id: 'other-project',
    name: 'other',
    repositoryStatus: 'preparing',
    sourcePath: '',
  });
  await assert.rejects(addProjectApplication('owner', 'other-project', 'web'), { status: 409 });
  workspace.save('v2-project-run', 'owner', { id: 'gym', apps: ['web'] });
  await assert.rejects(addProjectApplication('owner', 'gym', 'sync'), { status: 409 });
  assert.throws(
    () =>
      putProjectSettings(
        'owner',
        { id: 'gym', name: 'gym', apps: [] },
        { values: [{ key: 'MODE', value: 'during-release' }] },
      ),
    { status: 409 },
  );
  workspace.db.prepare("DELETE FROM records WHERE kind='v2-project-run'").run();
});

test('dotted project paths preserve resource identity, query strings and route suffixes', () => {
  for (const suffix of [
    '',
    '/code',
    '/issues',
    '/logs?app=deploy.local',
    '/apps/deploy.local/settings',
  ]) {
    const rewritten = projectDocumentUrl(`/dashboard/projects/deploy.local${suffix}`);
    assert.equal(new URL(rewritten, origin).pathname.includes('.'), false);
    assert.equal(
      decodeURIComponent(new URL(rewritten, origin).pathname),
      `/dashboard/projects/deploy.local${suffix.split('?')[0]}`,
    );
  }
  assert.equal(projectPath('deploy.local'), '/dashboard/projects/deploy%2Elocal');
  assert.equal(projectDocumentUrl('/assets/app.js'), '/assets/app.js');
  assert.deepEqual(projectTabs({ code: true, pulls: 0, issues: 0, apps: 1, releases: 2 }), [
    'Overview',
    'Code',
    'Releases',
    'Logs',
    'Settings',
  ]);
  // A one-app project is its own app page: a web app's requests and performance are project tabs.
  assert.deepEqual(
    projectTabs({ code: true, pulls: 0, issues: 0, apps: 1, releases: 2, requests: true }),
    ['Overview', 'Code', 'Releases', 'Requests', 'Performance', 'Logs', 'Settings'],
  );
  assert.equal(
    projectTabs({
      code: false,
      pulls: 0,
      issues: 0,
      apps: 2,
      releases: 0,
      requests: true,
    }).includes('Requests'),
    false,
  );
});

test('project logs filter membership before returning existing stream endpoints', async () => {
  const project = await resolveProject('owner', 'gym');
  assert.equal(projectLogSources(project, null).length, 3);
  assert.deepEqual(projectLogSources(project, 'sync'), [
    { app: 'sync', url: '/api/deployments/sync/logs?tail=1000' },
  ]);
  assert.throws(() => projectLogSources(project, 'private'), { status: 404 });
  assert.equal((await api('/projects/gym/logs?app=sync')).body.sources.length, 1);
  assert.equal((await api('/projects/gym/logs?app=private')).status, 404);
});

test('project release preferences validate, persist, isolate owners and refuse active releases', async () => {
  const path = '/projects/gym/settings';
  assert.equal((await api(path)).body.keepReleases, 5);
  assert.equal(
    (
      await api(path, 'PATCH', {
        keepReleases: 3,
        verifyMigrations: false,
        installThroughDeploy: false,
      })
    ).status,
    200,
  );
  const saved = (await api(path)).body;
  assert.equal(saved.keepReleases, 3);
  assert.equal(saved.verifyMigrations, false);
  assert.equal(saved.installThroughDeploy, false);
  for (const body of [
    { keepReleases: 0 },
    { keepReleases: 1.5 },
    { keepReleases: 101 },
    { verifyMigrations: 'false' },
    { installThroughDeploy: 'false' },
    { unknown: true },
  ])
    assert.equal((await api(path, 'PATCH', body)).status, 400);
  assert.equal(
    (await api(path, 'PATCH', { keepReleases: 5 }, { 'x-test-owner': 'other' })).status,
    404,
  );
  workspace.save('v2-project-run', 'owner', { id: 'gym', apps: ['web'], operationId: 'busy' });
  assert.equal((await api(path, 'PATCH', { keepReleases: 5 })).status, 409);
  assert.equal((await api('/projects/gym', 'DELETE', { confirm: 'deploy.local' })).status, 409);
  workspace.db
    .prepare("DELETE FROM records WHERE kind='v2-project-run' AND owner='owner' AND id='gym'")
    .run();
});

test('project removal confirms, stops every app before freeing addresses, and preserves backups for 30 days', async () => {
  const { removeProject, purgeRemovedProjects } = await import('./project-removal.ts');
  const { getBackupDir } = await import('../volumes.ts');
  const { existsSync, readFileSync } = await import('node:fs');
  workspace.save('project', 'remover', {
    id: 'remove',
    name: 'home-gym',
    repositoryPath: repo,
    sourcePath: repo,
    defaultBranch: 'main',
  });
  for (const name of ['remove-web', 'remove-sync']) {
    store.saveDeployment({ name, username: 'remover' });
    store
      .getSqlite()!
      .prepare('INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?)')
      .run(name, 'remover', 'remove');
    writeFileSync(join(getBackupDir(name), 'nightly.tar.gz'), 'backup data');
  }
  const project = await resolveProject('remover', 'remove');
  let stops = 0;
  const runtime = {
    async stopApp(app: any) {
      assert.equal(app.username, 'remover');
      assert.ok(store.getDeployment('remove-web'));
      stops++;
    },
  };
  await assert.rejects(removeProject('remover', project, false, runtime), /Confirm/);
  assert.equal(stops, 0);
  const before = Date.now();
  const result = await removeProject('remover', project, 'home-gym', runtime);
  assert.equal(stops, 2);
  assert.equal(store.getDeployment('remove-web'), null);
  assert.equal(store.getDeployment('remove-sync'), null);
  assert.ok(Date.parse(result.retainUntil) >= before + 30 * 86400_000);
  await assert.rejects(resolveProject('remover', 'remove'), /not found/);
  const receipt = workspace.list('v2-removed-project', 'remover')[0];
  assert.equal(readFileSync(join(receipt.archive, '0/nightly.tar.gz'), 'utf8'), 'backup data');
  const retained = await api('/projects/removed', 'GET', undefined, { 'x-test-owner': 'remover' });
  assert.equal(retained.body.projects[0].name, 'home-gym');
  const download = await fetch(origin + retained.body.projects[0].backupUrl, {
    headers: { 'x-test-owner': 'remover' },
  });
  assert.equal(download.status, 200);
  assert.equal(
    Buffer.from(await download.arrayBuffer())
      .subarray(0, 2)
      .toString('hex'),
    '1f8b',
  );
  assert.equal((await fetch(origin + retained.body.projects[0].backupUrl)).status, 404);

  await purgeRemovedProjects('remover', Date.parse(result.retainUntil) - 1);
  assert.ok(existsSync(receipt.archive));
  await purgeRemovedProjects('remover', Date.parse(result.retainUntil));
  assert.equal(existsSync(receipt.archive), false);
});

test('failed removal keeps membership, addresses and a durable retry receipt', async () => {
  const { removeProject, removeProjectContainer } = await import('./project-removal.ts');
  const { DockerApiError } = await import('../docker-api.ts');
  await removeProjectContainer('missing', async () => {
    throw new DockerApiError(404, 'missing');
  });
  await assert.rejects(
    removeProjectContainer('running', async () => {
      throw new DockerApiError(500, 'Docker unavailable');
    }),
    /Docker unavailable/,
  );
  store.saveDeployment({ name: 'cannot-stop', username: 'stop-owner' });
  const project = await resolveProject('stop-owner', 'app:cannot-stop');
  await assert.rejects(
    removeProject('stop-owner', project, project.name, {
      async stopApp() {
        throw new Error('offline');
      },
    }),
    /offline/,
  );
  assert.ok(store.getDeployment('cannot-stop'));
  assert.equal(workspace.list('v2-project-removal', 'stop-owner').length, 1);
  store.saveDeployment({ name: 'move-target', username: 'stop-owner' });
  await assert.rejects(
    addProjectApplication('stop-owner', 'app:move-target', 'cannot-stop'),
    /being removed/,
  );
  assert.equal((await resolveProject('stop-owner', project.id)).apps.length, 1);
  await removeProject('stop-owner', project, project.name, { async stopApp() {} });
  assert.equal(workspace.list('v2-project-removal', 'stop-owner').length, 0);
});

test('Add repository keeps configuration, encrypted secrets, releases, package references and old links', async () => {
  const owner = 'joining';
  store.saveDeployment({ name: 'pantry', username: owner, port: 5188 });
  const old = await resolveProject(owner, 'app:pantry');
  putProjectSettings(owner, old, {
    values: [
      { key: 'MODE', value: 'folder' },
      { app: 'pantry', key: 'MODE', value: 'override' },
    ],
  });
  putProjectSecret(owner, old, 'TOKEN', { value: 'keep-this-secret' });
  workspace.save('v2-project-policy', owner, { id: old.id, keepReleases: 3 });
  workspace.save('v2-release', owner, {
    id: 'pantry-release',
    project: old,
    release: {
      id: 'pantry-release',
      projectId: old.id,
      state: 'live',
      apps: [{ appId: 'pantry', to: 'same-artifact' }],
      source: { kind: 'ship', ref: 'main' },
      steps: [],
      migrations: [],
    },
  });
  workspace.save('v2-project-current', owner, { id: old.id, releaseId: 'pantry-release' });
  workspace.save('v2-rollback', owner, {
    id: 'pantry-rollback',
    rollback: { projectId: old.id, steps: [], from: 'old', to: 'new' },
  });
  workspace.save('v2-approval', owner, { id: 'pantry-rule', projectId: old.id });
  workspace.save('v2-inbox-native', owner, { id: 'pantry-inbox', item: { projectId: old.id } });
  const database = store.getSqlite()!;
  database
    .prepare('INSERT INTO package_pins VALUES(?,?,?,?,?)')
    .run('npm', 'pkg@1', old.id, 'pantry-release', 'release');
  database
    .prepare('INSERT INTO package_project_copies VALUES(?,?,?,?)')
    .run(owner, old.id, 'abc', 'today');
  database
    .prepare('INSERT INTO package_project_requirements VALUES(?,?,?,?,?)')
    .run(owner, old.id, 'pkg@1', 'pkg', '1');
  const before = store.getDeployment('pantry');
  const headers = { 'x-test-owner': owner };
  const body = { operationId: 'add-pantry', sourcePath: '' };
  const added = await api('/projects/app%3Apantry/repository', 'POST', body, headers);
  assert.equal(added.status, 202, JSON.stringify(added.body));
  const project = added.body;
  assert.equal(project.name, 'pantry');
  assert.notEqual(project.id, old.id);
  assert.deepEqual(
    project.apps.map((app: any) => app.name),
    ['pantry'],
  );
  assert.deepEqual(store.getDeployment('pantry'), before, 'the running app is not mutated');
  assert.equal((await resolveProject(owner, old.id)).id, project.id);
  assert.equal((await projectsForOwner(owner)).length, 1);
  assert.equal(
    (await api('/projects/app%3Apantry/overview', 'GET', undefined, headers)).body.project.id,
    project.id,
  );
  const retry = await api('/projects/app%3Apantry/repository', 'POST', body, headers);
  assert.equal(retry.body.id, project.id);
  const resolved = configuration.resolveApplicationConfiguration({
    deploymentName: 'pantry',
    specDigest: 'sha256:pantry',
    declarations: {
      TOKEN: { type: 'secret', required: true, scope: 'application' },
      MODE: { type: 'string', required: true, scope: 'application' },
    },
  });
  assert.equal(resolved.values.TOKEN, 'keep-this-secret');
  assert.equal(resolved.values.MODE, 'override');
  assert.equal(
    JSON.stringify(readProjectSettings(owner, project)).includes('keep-this-secret'),
    false,
  );
  assert.equal(workspace.list('v2-project-policy', owner)[0].id, project.id);
  assert.equal(workspace.list('v2-project-policy', owner)[0].keepReleases, 3);
  const release = workspace.list('v2-release', owner)[0];
  assert.equal(release.release.projectId, project.id);
  assert.equal(release.project.id, project.id);
  assert.equal(workspace.list('v2-rollback', owner)[0].rollback.projectId, project.id);
  assert.equal(workspace.list('v2-approval', owner)[0].projectId, project.id);
  assert.equal(workspace.list('v2-inbox-native', owner)[0].item.projectId, project.id);
  for (const table of [
    'project_applications',
    'project_configuration',
    'packages',
    'package_pins',
    'package_project_copies',
    'package_project_requirements',
  ])
    assert.equal(
      database.prepare(`SELECT 1 FROM ${table} WHERE project_id=?`).get(old.id),
      undefined,
      table,
    );
  assert.equal(
    (
      database.prepare('SELECT project_id FROM package_pins WHERE key=?').get('pkg@1') as {
        project_id: string;
      }
    ).project_id,
    project.id,
  );
  const { getLive } = await import('./live.ts');
  assert.equal(
    (await getLive(owner)).computers.flatMap((computer) => computer.apps)[0].project,
    project.id,
  );
  assert.equal(
    (await api(`/projects/${project.id}/repository`, 'POST', { operationId: 'again' }, headers))
      .status,
    409,
  );
  assert.equal(
    (await api('/projects/app%3Apantry/repository', 'POST', { operationId: 'private' })).status,
    404,
  );
});

test('New project attaches a matching folder app, leaves other names alone and refuses conflicting membership', async () => {
  const owner = 'new-project-owner';
  const headers = { 'x-test-owner': owner };
  store.saveDeployment({ name: 'recipes', username: owner });
  const list = await api('/projects/unlinked-apps', 'GET', undefined, headers);
  assert.deepEqual(
    list.body.apps.map((app: any) => app.name),
    ['recipes'],
  );
  const result = await api(
    '/projects',
    'POST',
    { name: ' recipes ', operationId: 'new-recipes' },
    headers,
  );
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.deepEqual(
    result.body.apps.map((app: any) => app.name),
    ['recipes'],
  );
  assert.equal((await projectsForOwner(owner)).length, 1);
  assert.deepEqual((await api('/projects/unlinked-apps', 'GET', undefined, headers)).body.apps, []);
  const other = await api(
    '/projects',
    'POST',
    { name: 'other-recipe', operationId: 'new-other' },
    headers,
  );
  assert.equal(other.status, 202);
  assert.deepEqual(other.body.apps, []);
  assert.equal(
    (await api(`/projects/${other.body.id}/apps`, 'POST', { app: 'recipes' }, headers)).status,
    409,
  );
  assert.equal(
    (await api(`/projects/${result.body.id}/apps`, 'POST', { app: 'recipes' }, headers)).status,
    409,
  );
  assert.equal(
    (await api('/projects', 'POST', { name: 'recipes', operationId: 'duplicate' }, headers)).status,
    400,
  );
});

test('legacy New project API also joins matching apps and replays creation safely', async () => {
  const { workspaceApi } = await import('../workspace/api.ts');
  const legacy = routeFetch((req, res) => workspaceApi(req, res, 'legacy-create'));
  store.saveDeployment({ name: 'legacy-pantry', username: 'legacy-create' });
  const init = {
    method: 'POST',
    body: JSON.stringify({ name: 'legacy-pantry', operationId: 'legacy-create' }),
  };
  const response = await legacy(`${origin}/api/workspace/projects`, init);
  assert.equal(response.status, 202);
  const project = await response.json();
  assert.equal((await resolveProject('legacy-create', project.id)).apps[0].name, 'legacy-pantry');
  assert.equal(
    (await (await legacy(`${origin}/api/workspace/projects`, init)).json()).id,
    project.id,
  );
  assert.equal((await projectsForOwner('legacy-create')).length, 1);
});

test('joining an app preserves both current releases when the destination already runs an app', async () => {
  const owner = 'two-releases';
  workspace.save('project', owner, {
    id: 'two-project',
    name: 'two',
    repositoryStatus: 'preparing',
  });
  for (const name of ['first-current', 'second-current']) {
    store.saveDeployment({ name, username: owner });
    const project = await resolveProject(owner, `app:${name}`);
    workspace.save('v2-release', owner, {
      id: name,
      release: {
        id: name,
        projectId: project.id,
        apps: [{ appId: name }],
        steps: [],
        state: 'live',
      },
    });
    workspace.save('v2-project-current', owner, { id: project.id, releaseId: name });
    await addProjectApplication(owner, 'two-project', name);
  }
  const { currentProjectReleases, projectReleases } = await import('./releases.ts');
  assert.equal(currentProjectReleases(owner).length, 2);
  assert.equal(projectReleases(owner, 'two-project').length, 2);
  assert.deepEqual(
    workspace.list('v2-project-current', owner).map((row) => row.id),
    ['two-project'],
  );
});

test('failed and racing repository additions leave one project and do not orphan the app', async () => {
  const owner = 'racing';
  store.saveDeployment({ name: 'racing-app', username: owner });
  const headers = { 'x-test-owner': owner };
  workspace.save('v2-project-run', owner, { id: 'app:racing-app', apps: ['racing-app'] });
  assert.equal(
    (
      await api(
        '/projects/app%3Aracing-app/repository',
        'POST',
        { operationId: 'blocked' },
        headers,
      )
    ).status,
    409,
  );
  assert.equal(workspace.list('project', owner).length, 0);
  workspace.remove('v2-project-run', owner, 'app:racing-app');
  const results = await Promise.all(
    ['race-one', 'race-two'].map((operationId) =>
      api('/projects', 'POST', { name: 'racing-app', operationId }, headers),
    ),
  );
  assert.equal(results.filter((result) => result.status === 202).length, 1);
  assert.equal((await projectsForOwner(owner)).length, 1);
});
