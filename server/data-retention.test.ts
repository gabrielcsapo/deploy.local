import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneDeploymentData, RETENTION_BATCH_SIZE } from './data-retention.ts';

test('retention batches preserve recent data, active jobs, newest builds and every retained reference', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'retention-'));
  process.env.DEPLOY_DATA_DIR = root;
  const store = await import('./store.ts');
  const db = store.getSqlite()!;
  t.after(() => {
    store._resetDb();
    delete process.env.DEPLOY_DATA_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.UTC(2030, 6, 1);
  const at = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const event = db.prepare(
    'INSERT INTO history(deployment_name,action,timestamp,build_log_id) VALUES(?,?,?,?)',
  );
  for (let n = 0; n < RETENTION_BATCH_SIZE * 3; n++)
    event.run('app', 'graph:recovered', at(15), null);
  event.run('app', 'graph:recovered', at(13), null);
  event.run('app', 'deploy', at(364), 1);
  event.run('app', 'deploy', at(366), 4);
  const job = db.prepare(
    "INSERT INTO agent_jobs(id,node_id,type,deployment_name,payload,status,created_at,completed_at) VALUES(?,'coordinator',?,'app','{}',?,?,?)",
  );
  for (const [id, type, status, age] of [
    ['old-log', 'logs', 'complete', 3],
    ['failed-log', 'logs', 'failed', 3],
    ['fresh-log', 'logs', 'complete', 1],
    ['queued', 'logs', 'queued', 200],
    ['claimed', 'logs', 'claimed', 200],
    ['old-deploy', 'deploy', 'complete', 91],
    ['deploy', 'deploy', 'failed', 89],
  ] as const) {
    job.run(id, type, status, now - 200 * 86_400_000, now - age * 86_400_000);
  }
  const build = db.prepare(
    "INSERT INTO build_logs(id,deployment_name,output,timestamp) VALUES(?,'app','large output',?)",
  );
  for (let n = 1; n <= 60; n++) build.run(n, at(200 - n));
  build.run(61, at(1));
  db.prepare(
    "INSERT INTO users(username,password,created_at) VALUES('owner','test','2030-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO deployments(name,username,current_build_log_id,created_at,updated_at) VALUES('app','owner',2,'2030-01-01','2030-01-01')",
  ).run();
  db.prepare(
    "INSERT INTO backups(deployment_name,filename,size_bytes,created_by,created_at,volume_paths,related_build_log_id) VALUES('app','kept.tar',1,'owner',?,'[]',3)",
  ).run(at(200));
  let batches = 0;
  const counts = await pruneDeploymentData(db, now, () => batches++);
  assert.deepEqual(counts, { history: 301, agent_jobs: 3, build_logs: 8 });
  assert.ok(batches >= 6);
  assert.deepEqual(
    db.prepare("SELECT id FROM build_logs WHERE id <= 12 AND output != '' ORDER BY id").all(),
    [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 12 }],
  );
  assert.deepEqual(
    db.prepare('SELECT id FROM agent_jobs ORDER BY id').all(),
    ['claimed', 'deploy', 'fresh-log', 'queued'].map((id) => ({ id })),
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(await pruneDeploymentData(db, now), {
    history: 0,
    agent_jobs: 0,
    build_logs: 0,
  });
  const { finishGraphReconciliation } = await import('./application-graph-supervisor.ts');
  const recoveredCount = () =>
    (
      db.prepare("SELECT count(*) AS n FROM history WHERE action='graph:recovered'").get() as {
        n: number;
      }
    ).n;
  const before = recoveredCount();
  for (let pass = 0; pass < 3; pass++) {
    store.updateDeploymentStatus('app', 'stopped');
    finishGraphReconciliation('app', false);
    assert.equal(store.getDeployment('app')!.status, 'running');
  }
  assert.equal(recoveredCount(), before, 'status drift does not manufacture recovery history');
  finishGraphReconciliation('app', true);
  finishGraphReconciliation('app', false);
  assert.equal(recoveredCount(), before + 1);
});
