import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  ensureLocalIdentity();
  assert.doesNotThrow(() => assertHomeCoordinator({}));
  assert.deepEqual(ensureLocalIdentity(), home);
  assert.equal(
    (db.prepare('SELECT name FROM deployments').get() as { name: string }).name,
    'preserved',
  );
});
test('unsupported portable mode is rejected without inventory admission', () => {
  assert.throws(() => assertHomeCoordinator({ DEPLOY_SUITCASE: '1' }), /retired/);
  const home = ensureLocalIdentity();
  db.prepare("UPDATE sites SET kind = 'suitcase' WHERE id = ?").run(home.homeSiteId);
  assert.doesNotThrow(() => assertHomeCoordinator({}));
  db.prepare("UPDATE sites SET kind = 'home' WHERE id = ?").run(home.homeSiteId);
});

test('mode admission does not open a database', () => {
  const missing = join(root, 'must-not-be-created');
  const original = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = missing;
  try {
    assert.doesNotThrow(() => assertHomeCoordinator({}));
    assert.doesNotThrow(() => assertHomeCoordinator({ DEPLOY_SUITCASE: '0' }));
    assert.throws(() => assertHomeCoordinator({ DEPLOY_SUITCASE: '1' }), {
      message:
        'Portable coordinators are retired. Export this target before upgrading; enroll computers as execution nodes.',
    });
    assert.equal(existsSync(missing), false);
  } finally {
    process.env.DEPLOY_DATA_DIR = original;
  }
});
