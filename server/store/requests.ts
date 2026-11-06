import { getRequestsDb } from '../requests-db.ts';
import { eq, sql, and, desc, gte } from 'drizzle-orm';
import { requestLogs } from '../schema.ts';

// ── Request logs ────────────────────────────────────────────────────────────
// Write path (buffer + worker thread + rollups) lives in request-log.ts so
// the edge process can use it without importing this module (store runs
// migrations on open; only the control plane may do that). Re-exported here
// for existing callers.

export { logRequest, flushRequestLogs } from '../request-log.ts';

export function getRequestLogs(
  name: string,
  options?: {
    page?: number;
    limit?: number;
    pathFilter?: string;
    statusFilter?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
  },
) {
  const db = getRequestsDb();
  const page = options?.page || 1;
  const limit = options?.limit || 100;
  const offset = (page - 1) * limit;

  let conditions = [eq(requestLogs.deploymentName, name)];

  // Add path filtering if provided
  if (options?.pathFilter) {
    conditions.push(sql`${requestLogs.path} LIKE ${options.pathFilter}`);
  }

  // Add status code filtering if provided (e.g., "2xx", "4xx", "5xx")
  if (options?.statusFilter) {
    const statusRangeStart = parseInt(options.statusFilter[0]) * 100;
    const statusRangeEnd = statusRangeStart + 99;
    conditions.push(
      sql`${requestLogs.status} >= ${statusRangeStart} AND ${requestLogs.status} <= ${statusRangeEnd}`,
    );
  }

  // Add time range filtering if provided
  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }

  const query = db
    .select({
      method: requestLogs.method,
      path: requestLogs.path,
      status: requestLogs.status,
      duration: requestLogs.duration,
      timestamp: requestLogs.timestamp,
      ip: requestLogs.ip,
      userAgent: requestLogs.userAgent,
      referrer: requestLogs.referrer,
      requestSize: requestLogs.requestSize,
      responseSize: requestLogs.responseSize,
      queryParams: requestLogs.queryParams,
      username: requestLogs.username,
      captureId: requestLogs.captureId,
    })
    .from(requestLogs)
    .where(and(...conditions));

  // Count total matching rows
  const [{ count: total }] = db
    .select({ count: sql<number>`count(*)` })
    .from(requestLogs)
    .where(and(...conditions))
    .all();

  // Fetch only the requested page
  const logs = query.orderBy(desc(requestLogs.timestamp)).limit(limit).offset(offset).all();

  return {
    logs,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export function getRequestSummary(
  name: string,
  options?: { fromTimestamp?: number; toTimestamp?: number },
) {
  const db = getRequestsDb();

  let conditions = [eq(requestLogs.deploymentName, name)];

  // Add time range filtering if provided
  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }

  // Use SQL aggregates for summary stats
  const oneMinAgo = Date.now() - 60_000;
  const agg = db
    .select({
      total: sql<number>`count(*)`,
      avgDuration: sql<number>`round(avg(${requestLogs.duration}))`,
      s2xx: sql<number>`sum(case when ${requestLogs.status} >= 200 and ${requestLogs.status} < 300 then 1 else 0 end)`,
      s3xx: sql<number>`sum(case when ${requestLogs.status} >= 300 and ${requestLogs.status} < 400 then 1 else 0 end)`,
      s4xx: sql<number>`sum(case when ${requestLogs.status} >= 400 and ${requestLogs.status} < 500 then 1 else 0 end)`,
      s5xx: sql<number>`sum(case when ${requestLogs.status} >= 500 then 1 else 0 end)`,
      recentCount: sql<number>`sum(case when ${requestLogs.timestamp} >= ${oneMinAgo} then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(and(...conditions))
    .get();

  if (!agg || agg.total === 0)
    return {
      total: 0,
      statusCodes: {} as Record<string, number>,
      avgDuration: 0,
      recentRpm: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    };

  const statusCodes: Record<string, number> = {};
  if (agg.s2xx) statusCodes['2xx'] = agg.s2xx;
  if (agg.s3xx) statusCodes['3xx'] = agg.s3xx;
  if (agg.s4xx) statusCodes['4xx'] = agg.s4xx;
  if (agg.s5xx) statusCodes['5xx'] = agg.s5xx;

  // Percentiles via ORDER BY + OFFSET — one row per percentile instead of
  // materializing every duration into JS (an unbounded time range over a
  // busy app used to pull hundreds of thousands of rows per dashboard view).
  const percentile = (p: number) =>
    db
      .select({ duration: requestLogs.duration })
      .from(requestLogs)
      .where(and(...conditions))
      .orderBy(requestLogs.duration)
      .limit(1)
      .offset(Math.min(Math.floor(agg.total * p), agg.total - 1))
      .get()?.duration ?? 0;

  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  const p99 = percentile(0.99);

  return {
    total: agg.total,
    statusCodes,
    avgDuration: agg.avgDuration || 0,
    recentRpm: agg.recentCount || 0,
    p50,
    p95,
    p99,
  };
}

function pickBucketMs(rangeMs: number): number {
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (rangeMs <= HOUR) return MIN; // 1m
  if (rangeMs <= 6 * HOUR) return 5 * MIN; // 5m
  if (rangeMs <= DAY) return 15 * MIN; // 15m
  if (rangeMs <= 7 * DAY) return HOUR; // 1h
  if (rangeMs <= 30 * DAY) return 6 * HOUR; // 6h
  return DAY; // 1d
}

export interface RequestSeriesPoint {
  bucket: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  p50: number;
  p95: number;
  p99: number;
  count: number;
}

export function getRequestSeries(
  name: string,
  fromMs: number,
  toMs: number,
): { bucketMs: number; series: RequestSeriesPoint[] } {
  const db = getRequestsDb();
  const bucketMs = pickBucketMs(toMs - fromMs);

  // Aggregate counts by bucket + status class in a single query.
  // CAST to INTEGER forces integer division — without it, SQLite treats
  // parameter-bound bucketMs as REAL and the division becomes floating-point,
  // which makes every row hash to its own bucket.
  const bucketExpr = sql`CAST(${requestLogs.timestamp} / ${bucketMs} AS INTEGER) * ${bucketMs}`;
  const rows = db
    .select({
      bucket: sql<number>`${bucketExpr}`.as('bucket'),
      s2xx: sql<number>`sum(case when ${requestLogs.status} >= 200 and ${requestLogs.status} < 300 then 1 else 0 end)`,
      s3xx: sql<number>`sum(case when ${requestLogs.status} >= 300 and ${requestLogs.status} < 400 then 1 else 0 end)`,
      s4xx: sql<number>`sum(case when ${requestLogs.status} >= 400 and ${requestLogs.status} < 500 then 1 else 0 end)`,
      s5xx: sql<number>`sum(case when ${requestLogs.status} >= 500 then 1 else 0 end)`,
      count: sql<number>`count(*)`,
    })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.deploymentName, name),
        gte(requestLogs.timestamp, fromMs),
        sql`${requestLogs.timestamp} <= ${toMs}`,
      ),
    )
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
    .all();

  // For each non-empty bucket, fetch durations to compute percentiles.
  // We do this in a second pass to keep the aggregate query simple/fast,
  // and only for buckets that actually have data.
  const bucketByKey = new Map<number, RequestSeriesPoint>();
  for (const r of rows) {
    bucketByKey.set(r.bucket, {
      bucket: r.bucket,
      s2xx: r.s2xx ?? 0,
      s3xx: r.s3xx ?? 0,
      s4xx: r.s4xx ?? 0,
      s5xx: r.s5xx ?? 0,
      p50: 0,
      p95: 0,
      p99: 0,
      count: r.count ?? 0,
    });
  }

  // Compute percentiles per bucket — single query, sort + index in JS
  if (rows.length > 0) {
    const durations = db
      .select({
        bucket: sql<number>`${bucketExpr}`.as('bucket'),
        duration: requestLogs.duration,
      })
      .from(requestLogs)
      .where(
        and(
          eq(requestLogs.deploymentName, name),
          gte(requestLogs.timestamp, fromMs),
          sql`${requestLogs.timestamp} <= ${toMs}`,
        ),
      )
      .all();

    const byBucket = new Map<number, number[]>();
    for (const d of durations) {
      const arr = byBucket.get(d.bucket) ?? [];
      arr.push(d.duration);
      byBucket.set(d.bucket, arr);
    }
    for (const [bucket, arr] of byBucket) {
      const point = bucketByKey.get(bucket);
      if (!point) continue;
      arr.sort((a, b) => a - b);
      point.p50 = arr[Math.floor(arr.length * 0.5)] ?? 0;
      point.p95 = arr[Math.floor(arr.length * 0.95)] ?? 0;
      point.p99 = arr[Math.floor(arr.length * 0.99)] ?? 0;
    }
  }

  // Fill empty buckets across the full range for continuous chart lines
  const startBucket = Math.floor(fromMs / bucketMs) * bucketMs;
  const endBucket = Math.floor(toMs / bucketMs) * bucketMs;
  const maxBuckets = 500;
  const stride = Math.max(1, Math.ceil((endBucket - startBucket) / bucketMs / maxBuckets));
  const series: RequestSeriesPoint[] = [];
  for (let t = startBucket; t <= endBucket; t += bucketMs * stride) {
    const existing = bucketByKey.get(t);
    series.push(
      existing ?? {
        bucket: t,
        s2xx: 0,
        s3xx: 0,
        s4xx: 0,
        s5xx: 0,
        p50: 0,
        p95: 0,
        p99: 0,
        count: 0,
      },
    );
  }

  return { bucketMs: bucketMs * stride, series };
}
