import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { purgeOrphanedDeploymentData } from './orphan-data.ts';

test('deletion cleans dependent rows atomically and orphan cleanup defaults to a read-only preview', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'orphan-data-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('./store.ts');
  const db = store.getSqlite()!;
  t.after(() => {
    store._resetDb();
    delete process.env.DEPLOY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  store.registerUser('owner', 'test-password');
  const populate = (name: string) => {
    store.saveDeployment({ name, username: 'owner' });
    store.addDeployEvent(name, { action: 'deploy' });
    store.addDeployEvent(name, { action: 'delete' });
    store.addDeployEvent(name, { action: 'delete' });
    db.prepare(
      "INSERT INTO build_logs(deployment_name,output,timestamp) VALUES(?,'large','2030-01-01')",
    ).run(name);
    for (const status of ['complete', 'failed', 'queued', 'claimed'])
      db.prepare(
        "INSERT INTO agent_jobs(id,node_id,type,deployment_name,payload,status,created_at) VALUES(?,'coordinator','logs',?,'{}',?,0)",
      ).run(name + status, name, status);
    db.prepare(
      'INSERT INTO resource_metrics(deployment_name,cpu_percent,mem_usage_bytes,mem_limit_bytes,mem_percent,net_rx_bytes,net_tx_bytes,block_read_bytes,block_write_bytes,pids,timestamp) VALUES(?,0,0,0,0,0,0,0,0,0,0)',
    ).run(name);
    for (const filename of ['missing.tar.gz', 'kept.tar.gz', 'kept.graph'])
      store.saveBackup({
        deploymentName: name,
        filename,
        label: null,
        sizeBytes: 1,
        createdBy: 'owner',
        createdAt: '2030-01-01',
        volumePaths: [],
      });
    mkdirSync(join(root, 'backups', name, 'kept.graph'), { recursive: true });
    writeFileSync(join(root, 'backups', name, 'kept.tar.gz'), 'archive');
  };
  populate('app');
  db.exec(
    "CREATE TRIGGER prevent_delete BEFORE DELETE ON deployments BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  assert.throws(
    () => store.deleteDeployment('app', { username: 'owner', source: 'ui' }),
    /test failure/,
  );
  assert.equal(
    (
      db.prepare("SELECT count(*) AS n FROM history WHERE deployment_name='app'").get() as {
        n: number;
      }
    ).n,
    3,
  );
  assert.equal((db.prepare('SELECT count(*) AS n FROM build_logs').get() as { n: number }).n, 1);
  db.exec('DROP TRIGGER prevent_delete');
  store.deleteDeployment('app', { username: 'owner', source: 'ui' });
  assert.deepEqual(
    store.getDeployHistory('app').map((r) => r.action),
    ['delete'],
  );
  assert.deepEqual(db.prepare('SELECT status FROM agent_jobs ORDER BY status').all(), [
    { status: 'claimed' },
    { status: 'queued' },
  ]);
  assert.equal(store.getBackups('app').length, 2);
  assert.ok(existsSync(join(root, 'backups', 'app', 'kept.tar.gz')));
  assert.ok(existsSync(join(root, 'backups', 'app', 'kept.graph')));
  populate('orphan');
  populate('live');
  db.prepare("DELETE FROM deployments WHERE name='orphan'").run();
  const expected = { history: 2, build_logs: 1, agent_jobs: 2, resource_metrics: 1, backups: 1 };
  assert.deepEqual(purgeOrphanedDeploymentData(db, root), expected);
  const script = new URL('../scripts/purge-orphan-data.ts', import.meta.url).pathname;
  const preview = JSON.parse(
    execFileSync(process.execPath, [script], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      encoding: 'utf8',
    }),
  );
  assert.match(preview.mode, /dry-run/);
  assert.deepEqual(purgeOrphanedDeploymentData(db, root), expected);
  assert.throws(() =>
    execFileSync(process.execPath, [script, '--apply', '--dry-run'], {
      env: process.env,
      stdio: 'pipe',
    }),
  );
  const applied = JSON.parse(
    execFileSync(process.execPath, [script, '--apply'], { env: process.env, encoding: 'utf8' }),
  );
  assert.equal(applied.history, 2);
  assert.deepEqual(purgeOrphanedDeploymentData(db, root), {
    history: 0,
    build_logs: 0,
    agent_jobs: 0,
    resource_metrics: 0,
    backups: 0,
  });
  assert.equal(store.getDeployHistory('live').length, 3);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
