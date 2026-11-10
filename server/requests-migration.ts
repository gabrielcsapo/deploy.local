import { writeEdgeTelemetry } from './telemetry.ts';
/** Resumable, bounded migration. Called in a worker, never on the serving thread. */
import { randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from './sqlite.ts';
import { buildRollups, ROLLUP_UPSERT_SQL } from './rollup.ts';

export interface ImportState {
  lowerId: number;
  highId: number;
  rawTimestamp: number;
  rawId: number;
  rollupTimestamp: number;
  rollupName: string;
  phase: 'rollups' | 'raw' | 'done';
  useLegacyRollups: boolean;
  rawDone: boolean;
  rollupsDone: boolean;
  completedAt: number | null;
}
const MAX = Number.MAX_SAFE_INTEGER;
export function legacyHighId(source: Database) {
  return (
    source.prepare('SELECT coalesce(max(id),0) AS id FROM request_logs').get() as { id: number }
  ).id;
}
export function ensureImportSource(source: Database): string {
  source.exec(`CREATE TABLE IF NOT EXISTS request_log_archive (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), source TEXT NOT NULL,
    vacuum_pending INTEGER NOT NULL DEFAULT 0
  )`);
  source
    .prepare('INSERT OR IGNORE INTO request_log_archive(singleton,source) VALUES(1,?)')
    .run(randomUUID());
  return (
    source.prepare('SELECT source FROM request_log_archive WHERE singleton=1').get() as {
      source: string;
    }
  ).source;
}
export function readImportState(target: Database, source: string): ImportState | undefined {
  const row = target.prepare('SELECT state FROM request_log_import WHERE source=?').get(source) as
    | { state: string }
    | undefined;
  return row ? JSON.parse(row.state) : undefined;
}
function saveState(target: Database, source: string, state: ImportState) {
  target
    .prepare(
      'INSERT INTO request_log_import VALUES (?,?) ON CONFLICT(source) DO UPDATE SET state=excluded.state',
    )
    .run(source, JSON.stringify(state));
}

interface RawRow {
  route?: string | null;
  id: number;
  deployment_name: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  ip: string | null;
  user_agent: string | null;
  referrer: string | null;
  request_size: number | null;
  response_size: number | null;
  query_params: string | null;
  username: string | null;
  capture_id: string | null;
}
interface RollupRow {
  deployment_name: string;
  bucket_ms: number;
  count: number;
  errors_4xx: number;
  errors_5xx: number;
  duration_sum: number;
  duration_min: number;
  duration_max: number;
}
const columns =
  'id,deployment_name,method,path,status,duration,timestamp,ip,user_agent,referrer,request_size,response_size,query_params,username,capture_id';

/** One destination write transaction containing a short, bounded source read.
 * No ATTACH, no source write lock, no read snapshot retained between batches.
 * Cursor + rows + rollup deltas commit atomically (including completion).
 */
export function copyRequestBatch(
  source: Database,
  target: Database,
  sourceId: string,
  limit = 500,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new Error('Batch size must be 1..5000');
  const copyColumns =
    columns +
    ((source.pragma('table_info(request_logs)') as { name: string }[]).some(
      (row) => row.name === 'route',
    )
      ? ',route'
      : '');
  const started = performance.now();
  let copied = 0;
  // FULL makes the completion receipt durable before a later startup deletes the source.
  target.pragma('synchronous = FULL');
  const result = target
    .transaction(() => {
      let state = readImportState(target, sourceId);
      if (!state || (state.phase === 'done' && legacyHighId(source) > state.highId)) {
        const first = !state;
        const useLegacyRollups =
          first && !!source.prepare('SELECT 1 FROM request_logs_1m LIMIT 1').get();
        state = {
          lowerId: state?.highId ?? 0,
          highId: legacyHighId(source),
          rawTimestamp: MAX,
          rawId: MAX,
          rollupTimestamp: MAX,
          rollupName: '',
          phase: 'raw',
          useLegacyRollups,
          rawDone: false,
          rollupsDone: !useLegacyRollups,
          completedAt: null,
        };
      }
      if (state.phase === 'done') return state;
      const upsert = target.prepare(ROLLUP_UPSERT_SQL);
      if (state.phase === 'rollups') {
        const rows = source
          .prepare(`SELECT * FROM request_logs_1m
        WHERE bucket_ms <= ? AND (bucket_ms < ? OR deployment_name > ?)
        ORDER BY bucket_ms DESC, deployment_name ASC LIMIT ?`)
          .all(
            state.rollupTimestamp,
            state.rollupTimestamp,
            state.rollupName,
            limit,
          ) as RollupRow[];
        for (const r of rows)
          upsert.run(
            r.deployment_name,
            r.bucket_ms,
            r.count,
            r.errors_4xx,
            r.errors_5xx,
            r.duration_sum,
            r.duration_min,
            r.duration_max,
          );
        copied = rows.length;
        const last = rows.at(-1);
        if (last) {
          state.rollupTimestamp = last.bucket_ms;
          state.rollupName = last.deployment_name;
        }
        if (rows.length < limit) state.rollupsDone = true;
        if (!state.rawDone) state.phase = 'raw';
      } else {
        const rows = source
          .prepare(`SELECT ${copyColumns} FROM request_logs INDEXED BY idx_request_logs_ts
        WHERE (timestamp,id) < (?,?)
        ORDER BY timestamp DESC,id DESC LIMIT ?`)
          .all(state.rawTimestamp, state.rawId, limit) as RawRow[];
        const insert = target.prepare(
          `INSERT OR IGNORE INTO request_logs (${copyColumns}) VALUES (${Array(copyColumns.split(',').length).fill('?').join(',')})`,
        );
        const remap = target.prepare(
          `INSERT INTO request_logs (${copyColumns.split(',').slice(1).join(',')}) VALUES (${Array(
            copyColumns.split(',').length - 1,
          )
            .fill('?')
            .join(',')})`,
        );
        const inserted: Array<{ name: string; entry: RawRow }> = [];
        for (const row of rows) {
          // Filter IDs after the bounded index read: a rollback tail with old
          // timestamps must not turn one LIMIT query into a scan of 14M rows.
          if (row.id <= state.lowerId || row.id > state.highId) continue;
          const values = copyColumns.split(',').map((key) => row[key as keyof RawRow]);
          let changed = insert.run(...values).changes > 0;
          if (!changed) {
            const existing = target
              .prepare(`SELECT ${copyColumns} FROM request_logs WHERE id=?`)
              .get(row.id) as RawRow;
            if (
              copyColumns
                .split(',')
                .some((key) => existing[key as keyof RawRow] !== row[key as keyof RawRow])
            ) {
              // A previous release can reuse IDs in deploy.db after rollback.
              // Keep both requests; the atomic cursor prevents remapping twice.
              remap.run(...values.slice(1));
              changed = true;
            }
          }
          if (changed) inserted.push({ name: row.deployment_name, entry: row });
        }
        writeEdgeTelemetry(target, inserted);
        if (!state.useLegacyRollups)
          for (const r of buildRollups(inserted))
            upsert.run(
              r.deploymentName,
              r.bucketMs,
              r.count,
              r.errors4xx,
              r.errors5xx,
              r.durationSum,
              r.durationMin,
              r.durationMax,
            );
        copied = rows.length;
        const last = rows.at(-1);
        if (last) {
          state.rawTimestamp = last.timestamp;
          state.rawId = last.id;
        }
        if (rows.length < limit) state.rawDone = true;
        if (!state.rollupsDone) state.phase = 'rollups';
      }
      // Alternate newest-first raw and rollup batches: both detail and charts
      // gain recent history immediately, without waiting for a whole table.
      if (state.rawDone && state.rollupsDone) {
        state.phase = 'done';
        state.completedAt = Date.now();
      }
      saveState(target, sourceId, state);
      return state;
    })
    .immediate();
  return { rows: copied, ms: performance.now() - started, state: result };
}

/** Run only during control-plane initialization, before accepting traffic.
 * The source schema and sqlite_sequence survive, for old-release compatibility.
 * A pending marker makes a crash after DELETE or VACUUM safe to retry.
 */
export function compactLegacyRequests(
  source: Database,
  target: Database,
  sourceId: string,
  options: {
    freeBytes?: () => number;
    log?: (message: string) => void;
  } = {},
) {
  const log = options.log ?? console.log;
  const state = readImportState(target, sourceId);
  if (!state?.completedAt || state.phase !== 'done' || legacyHighId(source) > state.highId)
    return 'not-ready';
  const pending = (
    source.prepare('SELECT vacuum_pending FROM request_log_archive WHERE singleton=1').get() as {
      vacuum_pending: number;
    }
  ).vacuum_pending;
  if (
    !pending &&
    !source.prepare('SELECT 1 FROM request_logs LIMIT 1').get() &&
    !source.prepare('SELECT 1 FROM request_logs_1m LIMIT 1').get()
  )
    return 'empty';
  const bytes = () =>
    Number(source.pragma('page_count', { simple: true })) *
    Number(source.pragma('page_size', { simple: true }));
  const freeBytes =
    options.freeBytes ??
    (() => {
      const fs = statfsSync(dirname(source.name));
      return fs.bavail * fs.bsize;
    });
  const enoughSpace = () => {
    const required = 2 * bytes() + 64 * 1024 * 1024;
    try {
      const free = freeBytes();
      if (free >= required) return true;
      log(
        `[requests] Skipping legacy DELETE/VACUUM: ${free} bytes free, ${required} required; retry next start`,
      );
    } catch (error) {
      log(
        `[requests] Skipping legacy DELETE/VACUUM: cannot check free disk space (${error}); retry next start`,
      );
    }
    return false;
  };
  if (!enoughSpace()) return 'skipped';
  const start = performance.now();
  try {
    source
      .transaction(() => {
        source.exec('DELETE FROM request_logs; DELETE FROM request_logs_1m');
        source.prepare('UPDATE request_log_archive SET vacuum_pending=1 WHERE singleton=1').run();
      })
      .immediate();
    source.pragma('wal_checkpoint(TRUNCATE)');
    if (!enoughSpace()) return 'skipped';
    source.exec('VACUUM');
    source.pragma('wal_checkpoint(TRUNCATE)');
    source.prepare('UPDATE request_log_archive SET vacuum_pending=0 WHERE singleton=1').run();
    // Copying newest first leaves pages half full. Compacting once now halves the file; on a
    // production-sized copy this took about 6 seconds. It can fail without losing anything.
    try {
      const targetBytes =
        Number(target.pragma('page_count', { simple: true })) *
        Number(target.pragma('page_size', { simple: true }));
      if (freeBytes() >= 2 * targetBytes + 64 * 1024 * 1024) {
        target.exec('VACUUM');
        target.pragma('wal_checkpoint(TRUNCATE)');
      } else log('[requests] Skipping requests.db VACUUM: not enough free disk space');
    } catch (error) {
      log(`[requests] Skipping requests.db VACUUM: ${error}`);
    }
    log(
      `[requests] Legacy DELETE/VACUUM completed in ${(performance.now() - start).toFixed(1)}ms; deploy.db=${bytes()} bytes`,
    );
    return 'vacuumed';
  } catch (error) {
    log(`[requests] Legacy DELETE/VACUUM deferred after error: ${error}; retry next start`);
    return 'skipped';
  }
}
