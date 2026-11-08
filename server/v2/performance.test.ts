import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'performance-api-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { getRequestsSqlite } = await import('../requests-db.ts');
const { writeEdgeTelemetry } = await import('../telemetry.ts');
const { v2Api } = await import('./api.ts');
store.saveDeployment({ name: 'mine', username: 'owner', type: 'web' });
store.saveDeployment({ name: 'theirs', username: 'other', type: 'web' });
const fetch = routeFetch((req, res) =>
  v2Api(req, res, (request) =>
    request.headers.authorization === 'Bearer owner'
      ? { username: 'owner' }
      : (res.writeHead(401), res.end('{}'), null),
  ),
);
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
test('performance v2 API requires owner auth, validates range and reads rollups', async () => {
  const headers = { authorization: 'Bearer owner' };
  const base = 'http://localhost/api/v2/apps/';
  writeEdgeTelemetry(getRequestsSqlite(), [
    {
      name: 'mine',
      entry: { timestamp: Date.now() - 1000, status: 200, duration: 20, route: '/photos/:id' },
    },
  ]);
  assert.equal((await fetch(base + 'mine/performance')).status, 401);
  assert.equal((await fetch(base + 'theirs/performance', { headers })).status, 404);
  assert.equal((await fetch(base + 'missing/performance', { headers })).status, 404);
  assert.equal((await fetch(base + 'mine/performance?range=30d', { headers })).status, 400);
  assert.equal((await fetch(base + 'mine/performance', { headers, method: 'POST' })).status, 405);
  const response = await fetch(base + 'mine/performance?range=7d', { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.summary.requests, 1);
  assert.equal(body.hasRouteData, true);
  assert.equal(body.routes[0].route, '/photos/:id');
  assert.equal(
    (
      await fetch(base + 'mine/performance', {
        headers: { ...headers, 'x-deploy-agent-token': 'agent' },
      })
    ).status,
    403,
  );
});
test('legacy activation records one release per container and ignores ordinary restarts', () => {
  store.saveDeployment({
    name: 'legacy',
    username: 'owner',
    type: 'web',
    containerId: 'container-one',
  });
  store.updateDeploymentStatus('legacy', 'running');
  store.updateDeploymentStatus('legacy', 'running');
  assert.equal(
    (
      getRequestsSqlite()
        .prepare("SELECT count(*) AS n FROM telemetry_releases WHERE deployment_name='legacy'")
        .get() as { n: number }
    ).n,
    1,
  );
  store.saveDeployment({
    name: 'legacy',
    username: 'owner',
    type: 'web',
    containerId: 'container-two',
  });
  store.updateDeploymentStatus('legacy', 'running');
  assert.equal(
    (
      getRequestsSqlite()
        .prepare("SELECT count(*) AS n FROM telemetry_releases WHERE deployment_name='legacy'")
        .get() as { n: number }
    ).n,
    2,
  );
});
