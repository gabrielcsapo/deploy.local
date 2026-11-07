import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

test('scheduled backup snapshots every database, including requests still in WAL', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'request-backup-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('./store.ts');
  const { getRequestsSqlite } = await import('./requests-db.ts');
  const { snapshotDatabase } = await import('./maintenance.ts');
  t.after(() => {
    store._resetDb();
    delete process.env.DEPLOY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  store.getDb();
  getRequestsSqlite()
    .prepare(
      `INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES('app','GET','/snapshot',200,5,?)`,
    )
    .run(Date.now());
  const workspace = await import('./workspace/store.ts');
  workspace.save('task', 'admin', { id: 'in-the-wal' });
  await snapshotDatabase();
  const control = new Database(join(root, 'deploy.db.snapshot'), { readonly: true });
  const requests = new Database(join(root, 'requests.db.snapshot'), { readonly: true });
  const tasks = new Database(join(root, 'workspace', 'workspace.db.snapshot'), { readonly: true });
  try {
    assert.deepEqual(tasks.prepare("SELECT id FROM records WHERE kind='task'").all(), [
      { id: 'in-the-wal' },
    ]);
    assert.equal(
      (control.prepare('SELECT count(*) AS n FROM request_logs').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (requests.prepare('SELECT path FROM request_logs').get() as { path: string }).path,
      '/snapshot',
    );
    assert.equal(requests.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    tasks.close();
    requests.close();
    control.close();
  }
});
