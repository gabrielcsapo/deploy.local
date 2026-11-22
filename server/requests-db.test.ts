import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
  openRequestsDb,
  pruneRequests,
  getRequestsSqlite,
  resetRequestsDb,
} from './requests-db.ts';
import {
  compactLegacyRequests,
  copyRequestBatch,
  ensureImportSource,
  readImportState,
} from './requests-migration.ts';
import { ROLLUP_BACKFILL_SQL } from './rollup.ts';
import { logRequest, flushRequestLogs, resetRequestLogWriter } from './request-log.ts';

function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'requests-db-'));
  const source = new Database(join(root, 'deploy.db'));
  source.pragma('journal_mode = WAL');
  migrate(drizzle(source), { migrationsFolder: resolve('drizzle') });
  const sourceId = ensureImportSource(source);
  const target = openRequestsDb(join(root, 'requests.db'));
  const result = { root, source, target, sourceId };
  t.after(() => {
    if (result.target.open) result.target.close();
    if (source.open) source.close();
    rmSync(root, { recursive: true, force: true });
  });
  return result;
}
function seed(db: Database.Database, count = 17) {
  const insert = db.prepare(`INSERT INTO request_logs
    (deployment_name,method,path,status,duration,timestamp,ip,user_agent,referrer,request_size,response_size,query_params,username,capture_id)
    VALUES ('app','GET',?,?,?,?,'127.0.0.1','test','referrer',0,42,'q=1','owner','capture')`);
  db.transaction(() => {
    for (let i = 1; i <= count; i++)
      insert.run(`/row/${i}`, i % 3 === 0 ? 500 : 200, i, 1700000000000 + ((i * 7) % 11) * 60_000);
  })();
}
function finish(f: ReturnType<typeof fixture>, size = 3) {
  for (let i = 0; i < 100; i++) {
    const batch = copyRequestBatch(f.source, f.target, f.sourceId, size);
    if (batch.state.phase === 'done') return batch;
  }
  throw new Error('copy did not finish');
}
const count = (db: Database.Database, table = 'request_logs') =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

test('live worker writes only requests.db; readers and named indexes work before any history arrives', async (t) => {
  const f = fixture(t);
  const previous = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = f.root;
  t.after(() => {
    resetRequestLogWriter();
    resetRequestsDb();
    if (previous === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = previous;
  });
  logRequest('app', {
    method: 'POST',
    path: '/new',
    route: '/new/:id',
    phases: { render: 8 },
    status: 201,
    duration: 19,
    timestamp: Date.now(),
  });
  flushRequestLogs();
  const until = Date.now() + 5000;
  while (count(f.target) === 0 && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(count(f.target), 1);
  assert.equal(count(f.source), 0);
  assert.equal(count(f.target, 'request_logs_1m'), 1);
  assert.equal(
    (f.target.prepare('SELECT route FROM request_logs').get() as { route: string }).route,
    '/new/:id',
  );
  assert.equal(
    (f.target.prepare('SELECT count FROM telemetry_routes').get() as { count: number }).count,
    1,
  );
  assert.equal(getRequestsSqlite().name, join(f.root, 'requests.db'));
  assert.equal(f.target.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(
    f.target
      .prepare('SELECT * FROM request_logs INDEXED BY idx_request_logs_ts WHERE timestamp > 0')
      .all().length,
    1,
  );
  assert.equal(
    f.target
      .prepare(
        "SELECT * FROM request_logs INDEXED BY idx_request_logs_timestamp WHERE deployment_name='app'",
      )
      .all().length,
    1,
  );
});

test('newest-first copy resumes from disk without gaps, duplicate rows or duplicate rollups', (t) => {
  const f = fixture(t);
  seed(f.source);
  // A row already present in the destination and its rollup must not be counted again.
  const existing = f.source.prepare('SELECT * FROM request_logs WHERE id=1').get() as Record<
    string,
    unknown
  >;
  const keys = Object.keys(existing);
  f.target
    .prepare(
      `INSERT INTO request_logs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    )
    .run(...Object.values(existing));
  f.target.exec(ROLLUP_BACKFILL_SQL);
  const first = copyRequestBatch(f.source, f.target, f.sourceId, 3);
  assert.equal(first.rows, 3);
  assert.equal(first.state.phase, 'raw');
  const newest = f.source
    .prepare('SELECT id FROM request_logs ORDER BY timestamp DESC,id DESC LIMIT 3')
    .all() as { id: number }[];
  for (const row of newest)
    assert.ok(f.target.prepare('SELECT 1 FROM request_logs WHERE id=?').get(row.id));
  f.target.close();
  f.target = openRequestsDb(join(f.root, 'requests.db'));
  assert.deepEqual(readImportState(f.target, f.sourceId), first.state);
  finish(f);
  assert.deepEqual(
    f.target.prepare('SELECT * FROM request_logs ORDER BY id').all(),
    f.source
      .prepare(
        'SELECT *, NULL AS route, NULL AS request_id, NULL AS trace FROM request_logs ORDER BY id',
      )
      .all(),
  );
  f.source.exec(ROLLUP_BACKFILL_SQL);
  assert.deepEqual(
    f.target.prepare('SELECT * FROM request_logs_1m ORDER BY bucket_ms').all(),
    f.source.prepare('SELECT * FROM request_logs_1m ORDER BY bucket_ms').all(),
  );
  assert.ok(readImportState(f.target, f.sourceId)?.completedAt);
  const completed = readImportState(f.target, f.sourceId);
  finish(f);
  assert.deepEqual(readImportState(f.target, f.sourceId), completed);
  assert.equal(count(f.source), 17); // completion never empties the source
  t.diagnostic(`3-row batch: ${first.ms.toFixed(2)}ms (small local fixture)`);
});

test('a failed destination batch rolls back both rows and cursor', (t) => {
  const f = fixture(t);
  seed(f.source, 9);
  f.target.exec(
    "CREATE TRIGGER interrupt_copy BEFORE INSERT ON request_logs WHEN NEW.id=3 BEGIN SELECT RAISE(ABORT,'interrupted'); END",
  );
  assert.throws(() => copyRequestBatch(f.source, f.target, f.sourceId, 9), /interrupted/);
  assert.equal(count(f.target), 0);
  assert.equal(readImportState(f.target, f.sourceId), undefined);
  f.target.exec('DROP TRIGGER interrupt_copy');
  finish(f);
  assert.equal(count(f.target), 9);
  assert.equal(
    (f.target.prepare('SELECT sum(count) AS n FROM request_logs_1m').get() as { n: number }).n,
    9,
  );
});

test('preserves old rollups without double counting raw rows or overlapping new traffic', (t) => {
  const f = fixture(t);
  seed(f.source);
  f.source.exec(ROLLUP_BACKFILL_SQL);
  f.source.exec("INSERT INTO request_logs_1m VALUES ('older',1,100,2,3,400,1,20)");
  // Reopen as an edge writer would: reserve all legacy IDs before inserting.
  f.target.close();
  f.target = openRequestsDb(join(f.root, 'requests.db'));
  const newId = f.target
    .prepare(
      "INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES('app','GET','/new',200,1,1700000000000)",
    )
    .run().lastInsertRowid;
  assert.ok(Number(newId) > 17);
  f.target.exec(ROLLUP_BACKFILL_SQL);
  finish(f, 2);
  assert.equal(count(f.target), 18);
  assert.equal(
    (f.target.prepare('SELECT sum(count) AS n FROM request_logs_1m').get() as { n: number }).n,
    118,
  );
  assert.equal(count(f.source), 17);
});

test('completed copy permits next-start vacuum; space failure and unknown space keep the source', (t) => {
  const f = fixture(t);
  seed(f.source, 40);
  f.source.exec(ROLLUP_BACKFILL_SQL);
  const schema = f.source
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('request_logs','request_logs_1m') ORDER BY name",
    )
    .all();
  assert.equal(compactLegacyRequests(f.source, f.target, f.sourceId), 'not-ready');
  finish(f);
  const messages: string[] = [];
  assert.equal(
    compactLegacyRequests(f.source, f.target, f.sourceId, {
      freeBytes: () => 0,
      log: (m) => messages.push(m),
    }),
    'skipped',
  );
  assert.match(messages.join(' '), /Skipping legacy DELETE\/VACUUM.*required/);
  assert.equal(count(f.source), 40);
  assert.equal(
    compactLegacyRequests(f.source, f.target, f.sourceId, {
      freeBytes: () => {
        throw new Error('statfs');
      },
      log: (m) => messages.push(m),
    }),
    'skipped',
  );
  assert.match(messages.at(-1)!, /cannot check free disk/);
  f.source.pragma('wal_checkpoint(TRUNCATE)');
  const before = statSync(f.source.name).size;
  assert.equal(
    compactLegacyRequests(f.source, f.target, f.sourceId, { freeBytes: () => Infinity }),
    'vacuumed',
  );
  assert.equal(count(f.source), 0);
  assert.equal(count(f.source, 'request_logs_1m'), 0);
  assert.equal(count(f.target), 40);
  assert.ok(statSync(f.source.name).size <= before);
  assert.deepEqual(
    f.source
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE tbl_name IN ('request_logs','request_logs_1m') ORDER BY name",
      )
      .all(),
    schema,
  );
  // New destination traffic and a rolled-back old writer can choose the same ID.
  const liveId = f.target
    .prepare(
      "INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES('live','GET','/live',200,1,1)",
    )
    .run().lastInsertRowid;
  f.target.exec(
    "INSERT INTO request_logs_1m(deployment_name,bucket_ms,count,duration_sum,duration_min,duration_max) VALUES('live',0,1,1,1,1)",
  );
  assert.equal(Number(liveId), 41);
  // Replay this checkout's previous-release Drizzle journal, old INSERT and index hints.
  migrate(drizzle(f.source), { migrationsFolder: resolve('drizzle') });
  f.source
    .prepare(
      "INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES('rollback','GET','/',200,1,1)",
    )
    .run();
  f.source.exec(ROLLUP_BACKFILL_SQL);
  assert.equal(
    f.source.prepare('SELECT * FROM request_logs INDEXED BY idx_request_logs_ts').all().length,
    1,
  );
  assert.equal(compactLegacyRequests(f.source, f.target, f.sourceId), 'not-ready');
  // Re-upgrade imports the rollback row, including its raw-derived rollup.
  finish(f);
  assert.equal(count(f.target), 42);
  finish(f);
  assert.equal(count(f.target), 42);
  assert.equal(
    (f.target.prepare('SELECT path FROM request_logs WHERE id=41').get() as { path: string }).path,
    '/live',
  );
  assert.equal(
    (
      f.target
        .prepare("SELECT count FROM request_logs_1m WHERE deployment_name='rollback'")
        .get() as { count: number }
    ).count,
    1,
  );
});

test('interrupted cleanup retries vacuum even after the old tables are empty', (t) => {
  const f = fixture(t);
  seed(f.source);
  finish(f);
  let checks = 0;
  assert.equal(
    compactLegacyRequests(f.source, f.target, f.sourceId, {
      freeBytes: () => (++checks === 1 ? Infinity : 0),
      log: () => {},
    }),
    'skipped',
  );
  assert.equal(count(f.source), 0);
  assert.equal(
    (
      f.source.prepare('SELECT vacuum_pending FROM request_log_archive').get() as {
        vacuum_pending: number;
      }
    ).vacuum_pending,
    1,
  );
  assert.equal(
    compactLegacyRequests(f.source, f.target, f.sourceId, { freeBytes: () => Infinity }),
    'vacuumed',
  );
  assert.equal(compactLegacyRequests(f.source, f.target, f.sourceId), 'empty');
});

test('retention is 90 days for raw rows and 396 days for rollups, including exact cutoffs', (t) => {
  const f = fixture(t);
  const now = Date.now();
  const day = 86_400_000;
  const insert = f.target.prepare(
    "INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES ('app','GET','/',200,1,?)",
  );
  for (const timestamp of [now - 90 * day - 1, now - 90 * day, now]) insert.run(timestamp);
  const rollup = f.target.prepare(
    "INSERT INTO request_logs_1m(deployment_name,bucket_ms,count) VALUES('app',?,1)",
  );
  for (const timestamp of [now - 396 * day - 1, now - 396 * day, now]) rollup.run(timestamp);
  assert.deepEqual(pruneRequests(f.target, now), { requests: 1, rollups: 1 });
  assert.equal(count(f.target), 2);
  assert.equal(count(f.target, 'request_logs_1m'), 2);
});

test('terminating the background worker after a committed batch resumes in another worker', async (t) => {
  const f = fixture(t);
  seed(f.source, 1101);
  const start = () =>
    new Worker(new URL('./requests-copy-worker.ts', import.meta.url), {
      workerData: { sourceFile: f.source.name, targetFile: f.target.name, sourceId: f.sourceId },
    });
  const first = start();
  t.after(() => first.terminate());
  await new Promise<void>((resolve, reject) => {
    first.once('message', () => resolve());
    first.once('error', reject);
  });
  await first.terminate();
  assert.ok(readImportState(f.target, f.sourceId));
  const second = start();
  t.after(() => second.terminate());
  await new Promise<void>((resolve, reject) => {
    second.once('error', reject);
    second.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
  assert.equal(count(f.target), 1101);
  assert.equal(readImportState(f.target, f.sourceId)?.phase, 'done');
  assert.equal(
    (f.target.prepare('SELECT sum(count) AS n FROM request_logs_1m').get() as { n: number }).n,
    1101,
  );
});

test('only a later startup compacts a completed background copy', async (t) => {
  const f = fixture(t);
  seed(f.source);
  const previous = process.env.DEPLOY_DATA_DIR;
  process.env.DEPLOY_DATA_DIR = f.root;
  const { initializeRequestStorage, resetRequestStorage } = await import('./requests-lifecycle.ts');
  t.after(() => {
    resetRequestStorage();
    if (previous === undefined) delete process.env.DEPLOY_DATA_DIR;
    else process.env.DEPLOY_DATA_DIR = previous;
  });
  initializeRequestStorage(f.source);
  const until = Date.now() + 5000;
  while (readImportState(f.target, f.sourceId)?.phase !== 'done' && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(readImportState(f.target, f.sourceId)?.phase, 'done');
  assert.equal(count(f.source), 17);
  initializeRequestStorage(f.source);
  assert.equal(count(f.source), 17); // re-opening in the same server is not a new startup
  resetRequestStorage();
  initializeRequestStorage(f.source);
  assert.equal(count(f.source), 0);
  assert.equal(count(f.target), 17);
});

test('request schema preserves legacy columns and indexes with an additive nullable route', (t) => {
  const f = fixture(t);
  for (const table of ['request_logs', 'request_logs_1m']) {
    const columns = (db: Database.Database) =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[]).map((row) => ({
        ...row,
        type: String(row.type).toLowerCase(),
        name: String(row.name),
      }));
    assert.deepEqual(
      columns(f.target).filter((row) => !['route', 'request_id', 'trace'].includes(row.name)),
      columns(f.source),
    );
    if (table === 'request_logs')
      assert.deepEqual(
        columns(f.target).find((row) => row.name === 'route'),
        { cid: 15, name: 'route', type: 'text', notnull: 0, dflt_value: null, pk: 0 },
      );
    const indexes = (db: Database.Database) =>
      (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[])
        .map((row) => row.name)
        .sort();
    assert.deepEqual(
      indexes(f.target),
      [
        ...indexes(f.source),
        ...(table === 'request_logs' ? ['request_logs_request_id', 'request_logs_trace'] : []),
      ].sort(),
    );
  }
});
