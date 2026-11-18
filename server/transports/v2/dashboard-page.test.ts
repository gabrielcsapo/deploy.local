import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const root = mkdtempSync(join(tmpdir(), 'dashboard-seeds-'));
process.env.DEPLOY_DATA_DIR = root;
// A cold dashboard render must not accidentally start Git, Docker, or a CLI probe.
const originals = new Map<string, unknown>();
const processes: string[] = [];
for (const method of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
] as const) {
  originals.set(method, childProcess[method]);
  (childProcess as any)[method] = (...args: unknown[]) => {
    processes.push(String(args[0]));
    throw new Error(`Unexpected child process: ${args[0]}`);
  };
}
syncBuiltinESMExports();
const store = await import('../../store.ts');
const workspace = await import('../../workspace/store.ts');
const { loadDashboardPage, loadProjectPage, dashboardPageURL } = await import('./project-page.ts');
const { buildAuthCookie } = await import('../../auth-cookie.ts');
const { routeFetch } = await import('../../v2/test-request.ts');
const { v2Api } = await import('../../v2/api.ts');
const { apiRoutes } = await import('../../api/registry.ts');
const { createAgent } = await import('../../v2/agents.ts');
const { updatePreferences } = await import('../../v2/auth-store.ts');
store.registerUser('admin', 'test-password');
const alice = store.registerUser('alice', 'test-password');
const bob = store.registerUser('bob', 'test-password');
store.ensureCoordinatorNode();
store.saveDeployment({ name: 'standalone.app', username: 'alice', type: 'web' });
const agent = createAgent('alice', {
  name: 'Alice private agent',
  looksAfter: [
    {
      id: 'weekly',
      what: 'Check the project',
      where: 'all-active',
      when: { every: 'week', day: 1, time: '08:00', timezone: 'UTC' },
      brings: 'message',
    },
  ],
});
createAgent('bob', { name: 'Bob private agent' });
workspace.save('task', 'alice', {
  id: 'unlinked',
  title: 'A standalone task',
  status: 'completed',
  revision: 1,
  baseRevision: 'fixture-revision',
  workerId: 'fixture-worker',
});
const request = (path = '/dashboard', owner = 'alice', token = alice.token) =>
  new Request(`https://deploy.test${path}`, {
    headers: token ? { cookie: buildAuthCookie(owner, token) } : {},
  });
after(() => {
  for (const [method, original] of originals) (childProcess as any)[method] = original;
  syncBuiltinESMExports();
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('dashboard seeds use only cookie identity and are deduplicated only within one Request', async () => {
  const req = request('/dashboard/agents');
  req.headers.set('x-deploy-username', 'bob');
  req.headers.set('x-deploy-token', bob.token!);
  const first = loadDashboardPage(req);
  assert.equal(first, loadDashboardPage(req));
  const page = (await first)!;
  assert.match(JSON.stringify(page.seed), /Alice private agent/);
  assert.doesNotMatch(JSON.stringify(page.seed), /Bob private agent/);
  assert.equal(page.seed.origin, 'https://deploy.test');
  assert.equal(page.seed.errors['/api/nodes'], 'Administrator access required');
  assert.equal(page.seed.data['/api/nodes'], undefined);
  updatePreferences('alice', { welcomed: true });
  const fresh = (await loadDashboardPage(request('/dashboard/agents')))!;
  assert.notEqual(fresh.seed, page.seed);
  assert.equal((fresh.seed.data['/api/auth/account'] as any).welcomed, true);
  assert.equal((page.seed.data['/api/auth/account'] as any).welcomed, false);
  const other = await loadDashboardPage(request('/dashboard/agents', 'bob', bob.token));
  assert.doesNotMatch(JSON.stringify(other!.seed), /Alice private agent/);
});

test('missing, malformed, expired, revoked and header-only credentials retain client loading', async () => {
  const headerOnly = request('/dashboard', 'alice', '');
  headerOnly.headers.set('x-deploy-username', 'alice');
  headerOnly.headers.set('x-deploy-token', alice.token!);
  assert.equal(await loadDashboardPage(headerOnly), undefined);
  const malformed = request();
  malformed.headers.set('cookie', 'deploy-sh-auth=%oops');
  assert.equal(await loadDashboardPage(malformed), undefined);
  assert.equal(await loadDashboardPage(request('/dashboard', 'alice', 'invalid')), undefined);
  const expired = store.loginUser('alice', 'test-password');
  store.getSqlite()!.prepare('UPDATE sessions SET expires_at=1 WHERE token=?').run(expired.token);
  assert.equal(await loadDashboardPage(request('/dashboard', 'alice', expired.token)), undefined);
  const revoked = store.loginUser('alice', 'test-password');
  store.logoutUser('alice', revoked.token!);
  assert.equal(await loadDashboardPage(request('/dashboard', 'alice', revoked.token)), undefined);
  assert.equal(await loadDashboardPage(request('/signin')), undefined);
  assert.equal(await loadDashboardPage(undefined), undefined);
  assert.equal(await loadProjectPage(request('/dashboard/live')), undefined);
  assert.equal(
    dashboardPageURL(request('/__rsc?url=%2Fdashboard%2Fcomputers%2Fmodels'))?.pathname,
    '/dashboard/computers/models',
  );
});

test('every seeded v2 value is the API wire response, including permissions and encoded identifiers', async () => {
  const api = routeFetch((req, res) => {
    const url = new URL(req.url!, 'https://deploy.test');
    return apiRoutes({
      req,
      res,
      url,
      path: url.pathname,
      workspacePath: url.pathname,
      method: req.method,
    });
  });
  for (const path of [
    '/dashboard',
    '/dashboard/live',
    '/dashboard/live/standalone.app',
    '/dashboard/inbox',
    '/dashboard/inbox?tab=answered',
    '/dashboard/computers',
    '/dashboard/computers/models',
    '/dashboard/computers/add',
    '/dashboard/agents',
    `/dashboard/agents/${agent.id}`,
    `/dashboard/agents/${agent.id}/tune`,
    `/dashboard/agents/${agent.id}/items/weekly/history`,
    '/dashboard/agents/new',
    '/dashboard/settings',
    '/dashboard/settings/approvals',
    '/dashboard/settings/account',
    '/dashboard/settings/devices',
    '/dashboard/settings/backups',
    '/dashboard/design',
    '/dashboard/design?project=ready&view=canvas',
    '/dashboard/packages',
    '/dashboard/packages?tab=copies',
    '/dashboard/tasks/unlinked',
    '/dashboard/start',
    '/dashboard/start/project',
    '/dashboard/start/apps',
    '/dashboard/discover',
  ]) {
    const page = (await loadDashboardPage(request(path)))!;
    if (path === '/dashboard/live/standalone.app') {
      assert.ok(page.seed.data['/api/live/standalone.app']);
      assert.ok(page.seed.data['/api/projects/app%3Astandalone.app/overview']);
    }
    for (const [key, value] of Object.entries(page.seed.data)) {
      if (!key.startsWith('/api/')) continue;
      const response = await api(`https://deploy.test${key}`, {
        headers: { cookie: buildAuthCookie('alice', alice.token!) },
      });
      assert.equal(response.status, 200, `${path}: ${key}`);
      assert.deepEqual(JSON.parse(JSON.stringify(value)), await response.json(), `${path}: ${key}`);
    }
    assert.ok(
      '/api/state' in page.seed.data || '/api/state' in page.seed.errors,
      'the sidebar task list is read with the page',
    );
    assert.ok(!('/api/self-update' in page.seed.data));
    assert.ok(!('/api/updates' in page.seed.data));
  }
  const catalog = (await loadDashboardPage(request('/dashboard/discover')))!.seed;
  assert.equal(catalog.data['/api/catalog'], undefined);
  assert.equal(catalog.errors['/api/catalog'], 'Administrator access required');
});

test('repository-backed task, design and package reads stay in the browser', async () => {
  workspace.save('project', 'alice', {
    id: 'ready',
    name: 'Ready project',
    repositoryPath: join(root, 'missing.git'),
    repositoryStatus: 'ready',
  });
  workspace.save('task', 'alice', {
    id: 'linked',
    projectId: 'ready',
    title: 'Linked task',
    status: 'completed',
  });
  for (const path of [
    '/dashboard/live',
    '/dashboard/tasks/linked',
    '/dashboard/design',
    '/dashboard/design?project=ready&view=canvas',
    '/dashboard/packages',
    '/dashboard/settings/backups',
  ]) {
    const page = (await loadDashboardPage(request(path)))!;
    for (const resource of ['/api/task-snapshots/linked', '/api/design/projects', '/api/packages'])
      assert.ok(!(resource in page.seed.data), `${path} must not await ${resource}`);
    if (path.includes('view=canvas')) {
      const api = routeFetch((req, res) => v2Api(req, res, () => ({ username: 'alice' })));
      for (const suffix of ['/asks?v=0', '/comments', '/presence', '/proposals?v=0']) {
        const resource = `/api/projects/ready/design${suffix}`;
        assert.deepEqual(
          page.seed.data[resource],
          await (await api(`https://deploy.test${resource}`)).json(),
        );
      }
    }
  }
});
