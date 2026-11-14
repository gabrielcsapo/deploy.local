import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'computer-kernel-'));
process.env.DEPLOY_DATA_DIR = root;
const old = await import('./workspace/computer-role-policy.ts');
const kernel = await import('./kernel/computers/policy.ts');
const store = await import('./workspace/store.ts');
const nodes = await import('./store/nodes.ts');
const engine = await import('./store.ts');
after(() => {
  engine._resetDb();
  store.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('compatibility exports are identical kernel objects, including node and reservation readers', async () => {
  for (const name of Object.keys(kernel) as (keyof typeof kernel)[])
    assert.equal(old[name], kernel[name], name);
  assert.equal((await import('./workspace/computer-roles.ts')).workerRole, kernel.workerRole);
  assert.equal(nodes.deployRoleEnabled, kernel.deployRoleEnabled);
  assert.equal(nodes.assertDeployRole, kernel.assertDeployRole);
  const updates = await import('./v2/update-admission.ts');
  const reservations = await import('./kernel/computers/reservations.ts');
  assert.equal(updates.workerUpdateReserved, reservations.workerUpdateReserved);
  assert.equal(updates.updateReservation, reservations.updateReservation);
  assert.equal(
    (await import('./workspace/computer-view.ts')).computerView,
    (await import('./kernel/computers/computer-view.ts')).computerView,
  );
});

test('old/new callers share the policy inventory, cadence and write invalidation', (t) => {
  const owner = 'cache';
  store.save('worker', owner, { id: 'remote' });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const prepare = t.mock.method(store.db, 'prepare');
  assert.equal(old.workerComputerId(owner, 'remote'), 'remote');
  const reads = prepare.mock.callCount();
  for (let i = 0; i < 20; i++) assert.equal(kernel.workerComputerId(owner, 'remote'), 'remote');
  assert.equal(prepare.mock.callCount(), reads);
  t.mock.timers.tick(1999);
  old.workerComputerId(owner, 'remote');
  assert.equal(prepare.mock.callCount(), reads);
  t.mock.timers.tick(1);
  kernel.workerComputerId(owner, 'remote');
  assert.ok(prepare.mock.callCount() > reads);
  store.save('managed-worker', owner, { id: 'remote' });
  assert.equal(old.workerComputerId(owner, 'remote'), 'coordinator');
  assert.equal(kernel.workerComputerId(owner, 'remote'), 'coordinator');
  nodes.setComputerRolePreferences('coordinator', { tasks: false });
  assert.equal(kernel.workerRole(owner, 'remote', 'take-tasks'), false);
  nodes.setComputerRolePreferences('coordinator', { tasks: true });
  assert.equal(old.workerRole(owner, 'remote', 'take-tasks'), true);
});

test('compatibility bootstrap and kernel dependency scan cover computers in every process', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  // Existing boundary test walks kernel recursively, so adding the folder requires no edits.
  assert.match(source('./kernel-imports.test.ts'), /walk\(kernel\)/);
  assert.match(source('./workspace/computer-role-policy.ts'), /import '\.\.\/store.ts'/);
  assert.match(source('./workspace/computer-role-policy.ts'), /import '\.\/store.ts'/);
  assert.match(
    source('./store/nodes.ts'),
    /configureComputerNodes\(\{ node: getNode, preferences: getComputerRolePreferences \}\)/,
  );
  assert.match(source('./workspace/store.ts'), /registerDatabase\('workspace', db\)/);
  // All process bodies execute only after these static dependency graphs have evaluated.
  for (const entry of [
    'boot',
    'workspace/repository-worker',
    'workspace/pipeline-worker',
    'workspace/worker',
    'workspace/preview',
  ]) {
    const seen = new Set<string>();
    function visit(path: string) {
      if (seen.has(path)) return;
      seen.add(path);
      const url = new URL(path, import.meta.url);
      for (const match of readFileSync(url, 'utf8').matchAll(
        /(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g,
      )) {
        const target = new URL(match[1], url);
        if (target.pathname.endsWith('.ts') && target.pathname.includes('/server/'))
          visit('./' + target.pathname.split('/server/')[1]);
      }
    }
    visit(`./${entry}.ts`);
    assert.ok(seen.has('./store/nodes.ts'), `${entry}: engine registration`);
    assert.ok(seen.has('./workspace/store.ts'), `${entry}: workspace registration`);
  }
});
