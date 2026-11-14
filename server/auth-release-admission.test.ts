import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { routeFetch } from './v2/test-request.ts';
import type { ApiRouteContext } from './api/context.ts';

const root = mkdtempSync(join(tmpdir(), 'auth-admission-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const store = await import('./store.ts');
const workspace = await import('./workspace/store.ts');
const { configureCiFence } = await import('./ci-fence.ts');
const { deploymentsRoutes } = await import('./api/deployments.ts');
const { backupsRoutes } = await import('./api/backups.ts');
const { containersRoutes } = await import('./api/containers.ts');
const { authRoutes } = await import('./api/auth.ts');
const { requireAuth, error } = await import('./api/shared.ts');
const { assertReleaseAdmission } = await import('./api/release-admission.ts');
store.registerUser('admin', 'password');
const person = store.registerUser('member', 'password');
const headers = { 'x-deploy-username': 'member', 'x-deploy-token': person.token! };
let checks: string[] = [];
let refuse = true;
configureCiFence(
  (app) => {
    checks.push(app);
    if (refuse) throw Object.assign(new Error('Admission fixture refused'), { status: 409 });
    return undefined;
  },
  () => undefined,
  () => {},
  () => false,
  () => {},
);
// Execute the actual outer middleware without starting its boot-owned Docker/metrics loops.
const source = readFileSync(new URL('./api.ts', import.meta.url), 'utf8');
const middlewareSource = source.slice(
  source.indexOf('  const middleware = async'),
  source.indexOf('  return Object.assign(middleware'),
);
const middleware = new Function(
  'requireAuth',
  'assertReleaseAdmission',
  'beginApplicationMutation',
  'handle',
  'error',
  stripTypeScriptTypes(middlewareSource) + '\nreturn middleware;',
)(
  requireAuth,
  assertReleaseAdmission,
  () => () => {},
  (_req: unknown, res: any) => {
    res.writeHead(404);
    res.end();
  },
  error,
);
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
const direct = (handler: (ctx: ApiRouteContext) => Promise<boolean>) =>
  routeFetch(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    await handler({
      req,
      res,
      url,
      path: url.pathname,
      workspacePath: url.pathname,
      method: req.method,
    });
  });
const deployment = direct(deploymentsRoutes);
const backup = direct(backupsRoutes);
const container = direct(containersRoutes);
const outer = routeFetch(async (req, res) => {
  await middleware(req, res, () => {
    res.writeHead(404);
    res.end();
  });
});
// Literal inventory of every dispatchable mutation that formerly used requireAuth's fence.
const routes: Array<[ReturnType<typeof direct>, string, string]> = [
  [deployment, 'PUT', '/application-spec'],
  [deployment, 'POST', '/application-rebase'],
  [deployment, 'POST', '/application-plan'],
  [deployment, 'POST', '/application-apply'],
  [deployment, 'PUT', '/configuration'],
  [deployment, 'PUT', '/configuration/KEY'],
  [deployment, 'POST', '/node'],
  [deployment, 'PUT', '/node'],
  ...['POST', 'PUT'].flatMap((method) =>
    ['restart', 'scale', 'instances/one/replace'].map(
      (action) =>
        [deployment, method, '/components/web/' + action] as [typeof deployment, string, string],
    ),
  ),
  [deployment, 'POST', '/components/web/operations/repair'],
  [deployment, 'DELETE', ''],
  [deployment, 'PATCH', ''],
  [container, 'POST', '/restart'],
  [container, 'POST', '/recreate'],
  [backup, 'POST', '/backups'],
  [backup, 'POST', '/backups/one/restore'],
  [backup, 'DELETE', '/backups/one'],
];

test('every previously fenced route still refuses before owner, admin and body checks', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [fetch, method, suffix] of routes) {
    checks = [];
    const response = await fetch('http://localhost/api/deployments/example' + suffix, {
      method,
      headers,
    });
    assert.equal(response.status, 409, `${method} ${suffix}`);
    assert.deepEqual(await response.json(), { error: 'Admission fixture refused' });
    assert.deepEqual(checks, ['example']);
  }
});

test('outer mutation admission still covers unknown deployment paths and runs before dispatch', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    checks = [];
    const response = await outer('http://localhost/api/deployments/example/unknown', {
      method,
      headers,
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Admission fixture refused' });
    assert.deepEqual(checks, ['example']);
  }
});

test('authentication still precedes admission; admission still precedes admin', async (t) => {
  t.mock.method(console, 'error', () => {});
  checks = [];
  const response = await deployment('http://localhost/api/deployments/example/application-apply', {
    method: 'POST',
    headers: { ...headers, 'x-deploy-token': 'wrong' },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Unauthorized' });
  assert.deepEqual(checks, []);
  refuse = false;
  try {
    const denied = await deployment('http://localhost/api/deployments/example/application-apply', {
      method: 'POST',
      headers,
    });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'Administrator access required' });
    assert.deepEqual(checks, ['example']);
  } finally {
    refuse = true;
  }
});

test('unfenced account and read routes remain unaffected', async () => {
  checks = [];
  const response = await direct(authRoutes)('http://localhost/api/user', { headers });
  assert.equal(response.status, 200);
  const read = await deployment('http://localhost/api/deployments/example', { headers });
  assert.equal(read.status, 404);
  assert.deepEqual(checks, []);
});

test('requireAuth now only authenticates even when the request names a fenced application', async () => {
  checks = [];
  const fetch = routeFetch(async (req, res) => {
    const auth = requireAuth(req, res);
    if (auth) {
      res.writeHead(200);
      res.end('authenticated');
    }
  });
  assert.equal(
    (await fetch('http://localhost/api/deployments/example', { method: 'POST', headers })).status,
    200,
  );
  assert.deepEqual(checks, []);
});
