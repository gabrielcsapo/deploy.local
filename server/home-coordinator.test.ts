import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'home-coordinator-'));
process.env.DEPLOY_DATA_DIR = root;
const { getSqlite, saveDeployment } = await import('./store.ts');
const { ensureLocalIdentity } = await import('./local-site.ts');
const { assertHomeCoordinator } = await import('./home-coordinator.ts');
const db = getSqlite()!;
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});
test('a single-home upgrade preserves application identity and home runtime records', () => {
  saveDeployment({
    name: 'preserved',
    username: 'owner',
    type: 'node',
    port: 3010,
    directory: root,
  });
  const home = ensureLocalIdentity();
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM app_replicas').get() as { count: number }).count,
    0,
  );
  db.prepare(`INSERT INTO app_replicas
    (id, app_id, site_id, runtime_status, data_mode, sync_policy, shared_lineage, readiness, created_at, updated_at)
    SELECT 'historical', app_id, ?, 'running', 'single-site', 'automatic', 1, '{}', created_at, updated_at FROM deployments LIMIT 1`).run(
    home.homeSiteId,
  );
  const before = db.prepare('SELECT * FROM app_replicas').all();
  assert.equal(before.length, 1);
  ensureLocalIdentity();
  assert.doesNotThrow(() => assertHomeCoordinator(db, {}));
  assert.deepEqual(db.prepare('SELECT * FROM app_replicas').all(), before);
  assert.equal(
    (db.prepare('SELECT name FROM deployments').get() as { name: string }).name,
    'preserved',
  );
});
test('portable installation and orphaned data cannot silently upgrade', () => {
  assert.throws(() => assertHomeCoordinator(db, { DEPLOY_SUITCASE: '1' }), /retired/);
  const home = ensureLocalIdentity();
  db.prepare("UPDATE sites SET kind = 'suitcase' WHERE id = ?").run(home.homeSiteId);
  assert.throws(() => assertHomeCoordinator(db, {}), /export and migration/);
  db.prepare("UPDATE sites SET kind = 'home' WHERE id = ?").run(home.homeSiteId);
  db.pragma('foreign_keys = OFF');
  db.prepare("UPDATE app_replicas SET site_id = 'missing-site'").run();
  assert.throws(() => assertHomeCoordinator(db, {}), /export and migration/);
  db.prepare('UPDATE app_replicas SET site_id = ?').run(home.homeSiteId);
  db.pragma('foreign_keys = ON');
});
