import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
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
const server = createServer(
  (req, res) =>
    void v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') })),
);
for (let port = 5180; port <= 5199; port++) {
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once('error', failed);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      });
    });
    break;
  } catch (error: any) {
    if (error.code !== 'EADDRINUSE' || port === 5199) throw error;
  }
}
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 5187}`;
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
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
    (await api(path, 'PATCH', { keepReleases: 3, verifyMigrations: false })).status,
    200,
  );
  const saved = (await api(path)).body;
  assert.equal(saved.keepReleases, 3);
  assert.equal(saved.verifyMigrations, false);
  for (const body of [
    { keepReleases: 0 },
    { keepReleases: 1.5 },
    { keepReleases: 101 },
    { verifyMigrations: 'false' },
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
