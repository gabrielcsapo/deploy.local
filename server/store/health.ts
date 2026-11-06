import { getDb } from './connection.ts';
import { getDeployment } from './deployments.ts';
import { resourceMetrics, requestLogs, history, buildLogs } from '../schema.ts';
import { and, eq, gte, desc, sql } from 'drizzle-orm';
import { getRequestsDb } from '../requests-db.ts';

// ── Composite health + time-series for dashboard ───────────────────────────

export interface CurrentHealth {
  status: string;
  uptimeMs: number | null;
  cpu: number | null;
  memPct: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  rps: number | null;
  errPct: number | null;
  p95Ms: number | null;
  lastDeploy: {
    at: string;
    status: 'success' | 'failed' | 'unknown';
    durationMs: number | null;
  } | null;
  build: { status: string | null; at: string | null } | null;
}

export function getCurrentHealth(name: string): CurrentHealth {
  const db = getDb();
  const d = getDeployment(name);
  const status = d?.status ?? 'unknown';
  const uptimeMs = d?.containerStartedAt ? Date.now() - d.containerStartedAt : null;

  // Latest metrics row in the last 2 minutes
  const cutoff = Date.now() - 120_000;
  const latest = db
    .select({
      cpuPercent: resourceMetrics.cpuPercent,
      memPercent: resourceMetrics.memPercent,
      memUsageBytes: resourceMetrics.memUsageBytes,
      memLimitBytes: resourceMetrics.memLimitBytes,
    })
    .from(resourceMetrics)
    .where(and(eq(resourceMetrics.deploymentName, name), gte(resourceMetrics.timestamp, cutoff)))
    .orderBy(desc(resourceMetrics.timestamp))
    .limit(1)
    .get();

  // Requests in the last minute → rps + err pct
  const oneMinAgo = Date.now() - 60_000;
  const reqAgg = getRequestsDb()
    .select({
      total: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${requestLogs.status} >= 500 then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(and(eq(requestLogs.deploymentName, name), gte(requestLogs.timestamp, oneMinAgo)))
    .get();
  const total = reqAgg?.total ?? 0;
  const errors = reqAgg?.errors ?? 0;
  const rps = total > 0 ? total / 60 : 0;
  const errPct = total > 0 ? (errors / total) * 100 : 0;

  // p95 over the same 60s window. Fetch sorted durations and pick the index.
  // Bounded by 60s of traffic — cheap; for huge volumes we'd want a t-digest.
  let p95Ms: number | null = null;
  if (total > 0) {
    const durations = getRequestsDb()
      .select({ duration: requestLogs.duration })
      .from(requestLogs)
      .where(and(eq(requestLogs.deploymentName, name), gte(requestLogs.timestamp, oneMinAgo)))
      .orderBy(requestLogs.duration)
      .all();
    if (durations.length > 0) {
      p95Ms = durations[Math.floor(durations.length * 0.95)]?.duration ?? null;
    }
  }

  // Last deploy event + linked build log (if any)
  const lastDeployEvent = db
    .select()
    .from(history)
    .where(and(eq(history.deploymentName, name), eq(history.action, 'deploy')))
    .orderBy(desc(history.timestamp))
    .limit(1)
    .get();

  let lastDeploy: CurrentHealth['lastDeploy'] = null;
  if (lastDeployEvent) {
    let deployStatus: 'success' | 'failed' | 'unknown' = 'unknown';
    let durationMs = lastDeployEvent.durationMs ?? null;
    if (lastDeployEvent.buildLogId) {
      const bl = db
        .select({ success: buildLogs.success, duration: buildLogs.duration })
        .from(buildLogs)
        .where(eq(buildLogs.id, lastDeployEvent.buildLogId))
        .get();
      if (bl) {
        deployStatus =
          bl.success === true ? 'success' : bl.success === false ? 'failed' : 'unknown';
        if (durationMs == null && bl.duration != null) durationMs = bl.duration;
      }
    } else {
      // Pre-migration history rows: assume success if container is running
      deployStatus = status === 'running' ? 'success' : 'unknown';
    }
    lastDeploy = { at: lastDeployEvent.timestamp, status: deployStatus, durationMs };
  }

  // Latest build
  const latestBuild = db
    .select({ status: buildLogs.status, timestamp: buildLogs.timestamp })
    .from(buildLogs)
    .where(eq(buildLogs.deploymentName, name))
    .orderBy(desc(buildLogs.timestamp))
    .limit(1)
    .get();

  return {
    status,
    uptimeMs,
    cpu: latest?.cpuPercent ?? null,
    memPct: latest?.memPercent ?? null,
    memUsageBytes: latest?.memUsageBytes ?? null,
    memLimitBytes: latest?.memLimitBytes ?? null,
    rps,
    errPct,
    p95Ms,
    lastDeploy,
    build: latestBuild
      ? { status: latestBuild.status, at: latestBuild.timestamp }
      : { status: null, at: null },
  };
}
