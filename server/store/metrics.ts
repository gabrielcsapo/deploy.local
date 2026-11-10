import { type RawContainerStats } from '../docker.ts';
import { getDb, getSqlite } from './connection.ts';
import { resourceMetrics } from '../schema.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { isCrashLooping } from '../crash-tracker.ts';

// ── Resource metrics ───────────────────────────────────────────────────────

export function logMetrics(name: string, metrics: RawContainerStats) {
  const db = getDb();
  db.insert(resourceMetrics)
    .values({
      deploymentName: name,
      cpuPercent: metrics.cpuPercent,
      memUsageBytes: metrics.memUsageBytes,
      memLimitBytes: metrics.memLimitBytes,
      memPercent: metrics.memPercent,
      netRxBytes: metrics.netRxBytes,
      netTxBytes: metrics.netTxBytes,
      blockReadBytes: metrics.blockReadBytes,
      blockWriteBytes: metrics.blockWriteBytes,
      pids: metrics.pids,
      timestamp: metrics.timestamp,
    })
    .run();
}

export type HealthSeverity = 'healthy' | 'degraded' | 'down' | 'idle' | 'building';

export interface DashboardAppStat {
  resourceMetricsAvailable: boolean;
  name: string;
  status: string;
  severity: HealthSeverity;
  crashLooping: boolean;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
  rps: number;
  errPct: number;
  p95: number;
  requestsLastMin: number;
}

/**
 * Derive a single ordinal health signal from the raw stats. Heroku-like:
 * one color you can read at a glance from across the room.
 *
 *  - migration/build lifecycle states → 'building' (yellow, in-progress)
 *  - crash-looping → 'degraded' (container keeps restarting; not "down"
 *    because Docker has restarted it, but operators need to know)
 *  - stopped/exited/failed → 'down' (red, action needed)
 *  - running + (5xx > 5% OR p95 > 5s OR mem > 90%) → 'degraded' (orange)
 *  - running + no traffic in last 60s → 'idle' (gray, alive but quiet)
 *  - running + traffic + good vitals → 'healthy' (green)
 */
function computeSeverity(args: {
  status: string;
  crashLooping: boolean;
  errPct: number;
  p95: number;
  memPercent: number;
  requestsLastMin: number;
}): HealthSeverity {
  const { status, crashLooping, errPct, p95, memPercent, requestsLastMin } = args;
  if (
    status === 'building' ||
    status === 'uploading' ||
    status === 'backing-up' ||
    status === 'restoring' ||
    status === 'starting'
  )
    return 'building';
  if (crashLooping) return 'degraded';
  if (status !== 'running') return 'down';
  if (errPct > 5 || p95 > 5000 || memPercent > 90) return 'degraded';
  if (requestsLastMin === 0) return 'idle';
  return 'healthy';
}

export interface DashboardAggregate {
  totals: {
    apps: number;
    running: number;
    unhealthy: number;
    totalRps: number;
    totalCpuPercent: number;
    totalMemUsageBytes: number;
    totalMemLimitBytes: number;
    errorRatePct: number;
    requestsLastMin: number;
  };
  perApp: DashboardAppStat[];
}

/**
 * Single roll-up query that powers the global dashboard. Combines:
 *  - deployments table (status, name)
 *  - latest resource_metrics row per app (CPU/mem)
 *  - request_logs in last 60s (RPS, errors, p95)
 *
 * Designed for the dashboard hot path: callable on every WS push without
 * fanning out N queries per app. SQLite handles ~50 apps × 60s of request
 * logs in single-digit ms with the existing indexes.
 */
export function getDashboardAggregate(): DashboardAggregate {
  const sqlite = getSqlite();
  if (!sqlite) {
    return {
      totals: {
        apps: 0,
        running: 0,
        unhealthy: 0,
        totalRps: 0,
        totalCpuPercent: 0,
        totalMemUsageBytes: 0,
        totalMemLimitBytes: 0,
        errorRatePct: 0,
        requestsLastMin: 0,
      },
      perApp: [],
    };
  }

  const metricsCutoff = Date.now() - 120_000;
  const oneMinAgo = Date.now() - 60_000;

  const deploymentRows = sqlite.prepare(`SELECT name, status FROM deployments`).all() as Array<{
    name: string;
    status: string | null;
  }>;

  // Latest metric snapshot per app within the last 2 minutes.
  const metricsRows = sqlite
    .prepare(
      `SELECT rm.deployment_name as deploymentName,
              rm.cpu_percent as cpuPercent,
              rm.mem_usage_bytes as memUsageBytes,
              rm.mem_limit_bytes as memLimitBytes,
              rm.mem_percent as memPercent
       FROM resource_metrics rm
       INNER JOIN (
         SELECT deployment_name, MAX(timestamp) as max_ts
         FROM resource_metrics
         WHERE timestamp >= ?
         GROUP BY deployment_name
       ) latest ON rm.deployment_name = latest.deployment_name AND rm.timestamp = latest.max_ts`,
    )
    .all(metricsCutoff) as Array<{
    deploymentName: string;
    cpuPercent: number;
    memUsageBytes: number;
    memLimitBytes: number;
    memPercent: number;
  }>;
  const metricsByApp = new Map(metricsRows.map((m) => [m.deploymentName, m]));

  // Requests per app over the last 60s: count, server errors and p95 from one
  // read of that app's rows on the (deployment_name, timestamp) index. This
  // is synchronous and runs for every dashboard load and every 5s broadcast,
  // so it reads each row once, as arrays, instead of a GROUP BY over every
  // app's rows followed by a sorted re-read per app for the p95.
  const requestRows = getRequestsSqlite()
    .prepare(
      `SELECT status, duration FROM request_logs INDEXED BY idx_request_logs_timestamp
       WHERE deployment_name = ? AND timestamp >= ?`,
    )
    .raw();
  const requestStats = (name: string) => {
    const rows = requestRows.all(name, oneMinAgo) as Array<[number, number]>;
    let errors = 0;
    const durations = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] >= 500) errors++;
      durations[i] = rows[i][1];
    }
    // Numeric sort; p95 is sorted[floor(n * 0.95)], as before.
    durations.sort();
    const p95 = rows.length > 0 ? durations[Math.floor(rows.length * 0.95)] : 0;
    return { total: rows.length, errors, p95 };
  };

  const perApp: DashboardAppStat[] = [];
  const totals = {
    apps: 0,
    running: 0,
    unhealthy: 0,
    totalRps: 0,
    totalCpuPercent: 0,
    totalMemUsageBytes: 0,
    totalMemLimitBytes: 0,
    errorRatePct: 0,
    requestsLastMin: 0,
  };
  let aggErrors = 0;

  for (const d of deploymentRows) {
    const m = metricsByApp.get(d.name);
    const status = d.status ?? 'stopped';
    const { total, errors, p95 } = requestStats(d.name);
    const rps = total > 0 ? total / 60 : 0;
    const errPct = total > 0 ? (errors / total) * 100 : 0;

    const crashLooping = isCrashLooping(d.name);
    const stat: DashboardAppStat = {
      resourceMetricsAvailable: Boolean(m),
      name: d.name,
      status,
      crashLooping,
      severity: computeSeverity({
        status,
        crashLooping,
        errPct,
        p95,
        memPercent: m?.memPercent ?? 0,
        requestsLastMin: total,
      }),
      cpuPercent: m?.cpuPercent ?? 0,
      memUsageBytes: m?.memUsageBytes ?? 0,
      memLimitBytes: m?.memLimitBytes ?? 0,
      memPercent: m?.memPercent ?? 0,
      rps,
      errPct,
      p95,
      requestsLastMin: total,
    };
    perApp.push(stat);

    totals.apps++;
    if (status === 'running') totals.running++;
    if (stat.severity === 'degraded' || stat.severity === 'down') totals.unhealthy++;
    totals.totalRps += rps;
    totals.totalCpuPercent += stat.cpuPercent;
    totals.totalMemUsageBytes += stat.memUsageBytes;
    totals.totalMemLimitBytes += stat.memLimitBytes;
    totals.requestsLastMin += total;
    aggErrors += errors;
  }

  totals.errorRatePct = totals.requestsLastMin > 0 ? (aggErrors / totals.requestsLastMin) * 100 : 0;

  return { totals, perApp };
}

export function getLatestMetricsAll() {
  const cutoff = Date.now() - 120_000;

  // Use a subquery to get only the latest row per deployment within the cutoff window
  const sqlite = getSqlite();
  if (!sqlite) return [];

  const rows = sqlite
    .prepare(
      `SELECT rm.deployment_name as deploymentName, rm.cpu_percent as cpuPercent,
              rm.mem_usage_bytes as memUsageBytes, rm.mem_limit_bytes as memLimitBytes,
              rm.mem_percent as memPercent, rm.timestamp
       FROM resource_metrics rm
       INNER JOIN (
         SELECT deployment_name, MAX(timestamp) as max_ts
         FROM resource_metrics
         WHERE timestamp >= ?
         GROUP BY deployment_name
       ) latest ON rm.deployment_name = latest.deployment_name AND rm.timestamp = latest.max_ts`,
    )
    .all(cutoff) as Array<{
    deploymentName: string;
    cpuPercent: number;
    memUsageBytes: number;
    memLimitBytes: number;
    memPercent: number;
    timestamp: number;
  }>;

  return rows;
}
