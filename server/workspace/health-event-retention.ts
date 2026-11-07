import type Database from 'better-sqlite3';
import { setTimeout as delay } from 'node:timers/promises';

export const HEALTH_EVENT_RETENTION_MS = 60 * 60_000;
export const HEALTH_EVENT_BATCH_SIZE = 250;

/** Scan at most one small page, including non-health rows. No unbounded index build or scan. */
export function pruneHealthEventBatch(
  db: Database.Database,
  after: number,
  through: number,
  cutoff: string,
) {
  const timeout = db.pragma('busy_timeout', { simple: true }) as number;
  db.pragma('busy_timeout = 25');
  try {
    return db
      .transaction(() => {
        const rows = db
          .prepare(
            'SELECT cursor FROM events WHERE cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?',
          )
          .all(after, through, HEALTH_EVENT_BATCH_SIZE) as { cursor: number }[];
        if (!rows.length) return { cursor: through, deleted: 0 };
        const end = rows.at(-1)!.cursor;
        const result = db
          .prepare(`DELETE FROM events WHERE cursor > ? AND cursor <= ?
        AND type = 'v2.health' AND createdAt < ?
        AND cursor < (SELECT MAX(head.cursor) FROM events head WHERE head.owner = events.owner)`)
          .run(after, end, cutoff);
        // Preserve each owner's head: MAX(cursor) must never regress or disappear,
        // including when every event for an owner was a heartbeat. AUTOINCREMENT is untouched.
        return { cursor: end, deleted: result.changes };
      })
      .immediate();
  } finally {
    db.pragma(`busy_timeout = ${timeout}`);
  }
}

/** Called by maintenance; yield between every batch so requests and writers can run. */
export async function pruneHealthEvents(
  db: Database.Database,
  now = Date.now(),
  onBatch?: (ms: number) => void,
) {
  const through = (
    db.prepare('SELECT COALESCE(MAX(cursor),0) AS n FROM events').get() as { n: number }
  ).n;
  const cutoff = new Date(now - HEALTH_EVENT_RETENTION_MS).toISOString();
  let cursor = 0;
  let deleted = 0;
  while (cursor < through) {
    const start = performance.now();
    const batch = pruneHealthEventBatch(db, cursor, through, cutoff);
    onBatch?.(performance.now() - start);
    cursor = batch.cursor;
    deleted += batch.deleted;
    if (cursor < through) await delay(10);
  }
  return deleted;
}
