import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('the control database enforces its declared foreign keys', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'foreign-keys-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('../store.ts');
  t.after(() => {
    store._resetDb();
    delete process.env.DEPLOY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  const sqlite = store.getSqlite()!;
  assert.equal(sqlite.pragma('foreign_keys', { simple: true }), 1);
  assert.deepEqual(sqlite.pragma('foreign_key_check'), []);

  const now = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO users(username,password,role,created_at) VALUES('owner','x','admin',?)")
    .run(now);
  const session = sqlite
    .prepare("INSERT INTO sessions(username,token,created_at) VALUES('owner','token',?)")
    .run(now).lastInsertRowid;
  sqlite
    .prepare('INSERT INTO v2_devices VALUES(?,?,?,?,?)')
    .run('d1', 'owner', session, 'Mac', now);

  // A child row needs its parent.
  assert.throws(
    () =>
      sqlite
        .prepare('INSERT INTO v2_devices VALUES(?,?,?,?,?)')
        .run('d2', 'nobody', session, 'x', now),
    /FOREIGN KEY constraint failed/,
  );
  // A signed-out or expired session takes its device with it, as the schema declares.
  sqlite.prepare('DELETE FROM sessions WHERE id=?').run(session);
  assert.equal(
    (sqlite.prepare('SELECT count(*) AS n FROM v2_devices').get() as { n: number }).n,
    0,
  );
});
