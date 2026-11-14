import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'project-pages-test-'));
process.env.DEPLOY_DATA_DIR = root;
const seeded = JSON.parse(
  execFileSync(process.execPath, ['--import', 'tsx', 'docs/evidence/project-pages/seed.mts'], {
    encoding: 'utf8',
    env: { ...process.env, DEPLOY_DATA_DIR: root },
  }),
);
const store = await import('../../../server/store.ts');
const workspace = await import('../../../server/workspace/store.ts');
const { repositoryInfo } = await import('../../../server/workspace/repositories.ts');
const { collaborationRead } = await import('../../../server/workspace/project-collaboration.ts');
const { pipelineRead } = await import('../../../server/workspace/pipelines.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { routeFetch } = await import('../../../server/v2/test-request.ts');
const fetch = routeFetch((req, res) => v2Api(req, res, () => ({ username: 'owner' })));
const api = async (path: string) => {
  const response = await fetch(`http://localhost/api${path}`);
  assert.equal(response.status, 200, path);
  return response.json();
};
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
test('seed uses the real API records for every project page state', async () => {
  assert.ok(store.authenticate('owner', seeded.token));
  const many = await api('/projects/many-tabs/overview');
  assert.equal(many.project.apps.length, 2);
  assert.equal(many.repository.deployment.pipeline, true);
  assert.equal(many.pulls.length, 1);
  assert.equal(many.issues.length, 1);
  const pulls = await collaborationRead('owner', 'many-tabs', 'pulls');
  assert.equal(pulls.items.length, 1);
  assert.equal(pipelineRead('owner', 'many-tabs').runs.length, 5);
  assert.equal(pipelineRead('owner', 'many-tabs', 'run-1').jobs.length, 3);
  assert.equal((await api('/projects/many-tabs/releases')).releases.length, 2);
  const pantry = await api('/projects/pantry/overview');
  assert.equal(pantry.project.apps.length, 1);
  assert.equal((await api('/projects/pantry/settings')).values.length, 4);
  const quiet = await api('/live/pantry');
  assert.equal(quiet.app.traffic.state, 'measured');
  assert.equal(quiet.app.traffic.requests, 0);
  assert.equal(quiet.app.traffic.p95ms, null);
  assert.equal((await api('/live/unmeasured')).app.traffic.state, 'not-measured');
  assert.ok(!store.getDeployment('pantry')?.memoryLimit);
  const preparing = await repositoryInfo('owner', 'preparing');
  assert.equal(preparing.status, 'preparing');
  assert.ok(!('refs' in preparing));
});
