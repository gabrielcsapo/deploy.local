import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let root: string;
let store: typeof import('./store.ts');
let coordinator: typeof import('./reconciliation-coordinator.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-reconciliation-startup-'));
  process.env.DEPLOY_DATA_DIR = join(root, 'state');
  store = await import(`./store.ts?reconciliation-startup=${Date.now()}`);
  coordinator = await import(
    `./reconciliation-coordinator.ts?reconciliation-startup=${Date.now()}`
  );
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

test('automatic startup reconciliation is a no-op before fleet onboarding', async () => {
  await assert.doesNotReject(coordinator.reconcileAllAutomaticChangesets());
  const count = store.getSqlite()!.prepare('SELECT COUNT(*) AS count FROM sites').get() as {
    count: number;
  };
  assert.equal(count.count, 0);
});
