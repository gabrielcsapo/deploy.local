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

test('retention and vacuum follow a stored schedule, not process uptime', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'maintenance-schedule-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('./store.ts');
  const { maintenanceDue, runDueMaintenance } = await import('./maintenance.ts');
  t.after(() => {
    store._resetDb();
    delete process.env.DEPLOY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  const hour = 3_600_000;
  // Retention cuts off from the real clock, so the rows are placed relative to it.
  const now = Date.now();
  assert.equal(maintenanceDue(null, now), true);
  assert.equal(maintenanceDue('not a date', now), true);
  assert.equal(maintenanceDue(new Date(now - 5 * hour).toISOString(), now), false);
  assert.equal(maintenanceDue(new Date(now - 6 * hour).toISOString(), now), true);
  // A clock that was set back must not postpone maintenance.
  assert.equal(maintenanceDue(new Date(now + 48 * hour).toISOString(), now), true);

  const sqlite = store.getSqlite()!;
  const insert = sqlite.prepare(
    `INSERT INTO resource_metrics(deployment_name,cpu_percent,mem_usage_bytes,mem_limit_bytes,mem_percent,net_rx_bytes,net_tx_bytes,block_read_bytes,block_write_bytes,pids,timestamp) VALUES('app',0,0,0,0,0,0,0,0,0,?)`,
  );
  const count = () =>
    (sqlite.prepare('SELECT count(*) AS n FROM resource_metrics').get() as { n: number }).n;
  insert.run(now - 40 * 24 * hour);
  insert.run(now - hour);
  // First run on a server that has never recorded one: the old row goes.
  assert.equal(runDueMaintenance(now), true);
  assert.equal(count(), 1);
  // A restart an hour later finds the stored time and does nothing.
  insert.run(now - 40 * 24 * hour);
  assert.equal(runDueMaintenance(now + hour), false);
  assert.equal(count(), 2);
  assert.equal(runDueMaintenance(now + 6 * hour), true);
  assert.equal(count(), 1);
});
