// Temp-only reproducible first-prune measurement. Run: node scripts/benchmark-health-retention.mjs
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pruneHealthEvents } from '../server/workspace/health-event-retention.ts';

const root = mkdtempSync(join(tmpdir(), 'deploy-health-prune-'));
const file = join(root, 'workspace.db');
const db = new Database(file);
try {
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT,taskId TEXT,runId TEXT,type TEXT,payload TEXT,createdAt TEXT);
    CREATE INDEX event_owner_cursor ON events(owner,cursor);
    CREATE INDEX event_task_cursor ON events(owner,taskId,cursor)`);
  const insert = db.prepare(
    'INSERT INTO events(owner,taskId,runId,type,payload,createdAt) VALUES(?,?,?,?,?,?)',
  );
  const seed = db.transaction(() => {
    for (let i = 0; i < 600_000; i++)
      insert.run(
        'fixture-owner',
        '',
        null,
        'v2.health',
        JSON.stringify({
          app: {
            appId: `app-${i % 13}`,
            kind: 'worker',
            state: 'healthy',
            summary: 'Heartbeat 0 s ago',
            heartbeatAt: new Date(i * 16_000).toISOString(),
            fixturePadding: 'x'.repeat(300),
          },
        }),
        '2020-01-01T00:00:00.000Z',
      );
  });
  seed();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const bytes = statSync(file).size;
  const monitor = monitorEventLoopDelay({ resolution: 1 });
  monitor.enable();
  await delay(20);
  let worstBatchMs = 0;
  let firstBatchMs;
  let batches = 0;
  const start = performance.now();
  const deleted = await pruneHealthEvents(db, Date.parse('2026-11-07T12:00:00Z'), (ms) => {
    firstBatchMs ??= ms;
    worstBatchMs = Math.max(worstBatchMs, ms);
    batches++;
  });
  const elapsedMs = performance.now() - start;
  await delay(20);
  monitor.disable();
  console.log(
    JSON.stringify(
      {
        rows: 600_000,
        bytes,
        decimalMB: bytes / 1e6,
        deleted,
        batches,
        firstBatchMs,
        worstBatchMs,
        worstEventLoopDelayMs: monitor.max / 1e6,
        elapsedMs,
        remaining: db.prepare('SELECT count(*) AS n FROM events').get().n,
        integrity: db.pragma('integrity_check', { simple: true }),
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
