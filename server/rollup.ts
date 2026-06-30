/**
 * Shared 1-minute rollup writer for request_logs_1m.
 *
 * Used inside the same SQLite transaction as the raw request_logs INSERTs —
 * by the log-worker thread on its own connection, and by store.ts's
 * in-process fallback path. Keeping the SQL and batch aggregation here means
 * the two writers can't drift.
 */

export const ROLLUP_BUCKET_MS = 60_000;

export interface RollupRow {
  deploymentName: string;
  bucketMs: number;
  count: number;
  errors4xx: number;
  errors5xx: number;
  durationSum: number;
  durationMin: number;
  durationMax: number;
}

interface RequestLike {
  status: number;
  duration: number;
  timestamp: number;
}

/** Collapse a flush batch into per-(deployment, minute) rollup deltas. */
export function buildRollups(items: Array<{ name: string; entry: RequestLike }>): RollupRow[] {
  const map = new Map<string, RollupRow>();
  for (const { name, entry } of items) {
    const bucketMs = Math.floor(entry.timestamp / ROLLUP_BUCKET_MS) * ROLLUP_BUCKET_MS;
    const key = `${name}\0${bucketMs}`;
    let agg = map.get(key);
    if (!agg) {
      agg = {
        deploymentName: name,
        bucketMs,
        count: 0,
        errors4xx: 0,
        errors5xx: 0,
        durationSum: 0,
        durationMin: Number.MAX_SAFE_INTEGER,
        durationMax: 0,
      };
      map.set(key, agg);
    }
    agg.count++;
    if (entry.status >= 500) agg.errors5xx++;
    else if (entry.status >= 400) agg.errors4xx++;
    agg.durationSum += entry.duration;
    if (entry.duration < agg.durationMin) agg.durationMin = entry.duration;
    if (entry.duration > agg.durationMax) agg.durationMax = entry.duration;
  }
  return [...map.values()];
}

export const ROLLUP_UPSERT_SQL = `
INSERT INTO request_logs_1m
  (deployment_name, bucket_ms, count, errors_4xx, errors_5xx, duration_sum, duration_min, duration_max)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(deployment_name, bucket_ms) DO UPDATE SET
  count = count + excluded.count,
  errors_4xx = errors_4xx + excluded.errors_4xx,
  errors_5xx = errors_5xx + excluded.errors_5xx,
  duration_sum = duration_sum + excluded.duration_sum,
  duration_min = MIN(duration_min, excluded.duration_min),
  duration_max = MAX(duration_max, excluded.duration_max)
`;

/** One-time backfill from existing raw rows; idempotent via the empty-table guard in the caller. */
export const ROLLUP_BACKFILL_SQL = `
INSERT INTO request_logs_1m
  (deployment_name, bucket_ms, count, errors_4xx, errors_5xx, duration_sum, duration_min, duration_max)
SELECT deployment_name,
       (timestamp / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS},
       count(*),
       sum(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END),
       sum(CASE WHEN status >= 500 THEN 1 ELSE 0 END),
       sum(duration),
       min(duration),
       max(duration)
FROM request_logs
GROUP BY deployment_name, (timestamp / ${ROLLUP_BUCKET_MS}) * ${ROLLUP_BUCKET_MS}
`;
