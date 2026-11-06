import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';

test('index migration preserves rows, composite lookup, and the dashboard timestamp hint', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE request_logs (deployment_name TEXT, timestamp INTEGER);
      CREATE INDEX idx_request_logs_deployment ON request_logs(deployment_name);
      CREATE INDEX idx_request_logs_timestamp ON request_logs(deployment_name, timestamp);
      CREATE INDEX idx_request_logs_ts ON request_logs(timestamp);
      INSERT INTO request_logs VALUES ('app', 1), ('app', 2), ('other', 3);`);
    const journal = JSON.parse(
      readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
    );
    assert.equal(journal.entries.at(-1).tag, '0043_drop_request_logs_deployment');
    db.exec(
      readFileSync(
        new URL('../drizzle/0043_drop_request_logs_deployment.sql', import.meta.url),
        'utf8',
      ),
    );
    const indexes = db.prepare('PRAGMA index_list(request_logs)').all() as { name: string }[];
    assert.deepEqual(indexes.map((i) => i.name).sort(), [
      'idx_request_logs_timestamp',
      'idx_request_logs_ts',
    ]);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM request_logs').get() as { n: number }).n,
      3,
    );
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM request_logs WHERE deployment_name=?')
      .all('app') as { detail: string }[];
    assert.match(plan[0].detail, /idx_request_logs_timestamp/);
    assert.equal(
      db
        .prepare('SELECT * FROM request_logs INDEXED BY idx_request_logs_ts WHERE timestamp > ?')
        .all(1).length,
      2,
    );
  } finally {
    db.close();
  }
});
