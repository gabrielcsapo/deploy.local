import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  users,
  sessions,
  deployments,
  history,
  requestLogs,
  resourceMetrics,
  backups,
  buildLogs,
} from './schema.ts';
import type { RawContainerStats } from './docker.ts';

const DATA_DIR = resolve(process.cwd(), '.deploy-data');
const DB_FILE = resolve(DATA_DIR, 'deploy.db');
const UPLOADS_DIR = resolve(DATA_DIR, 'uploads');

let _sqlite: InstanceType<typeof Database> | null = null;
let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (_db) return _db;

  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(UPLOADS_DIR)) mkdirSync(UPLOADS_DIR, { recursive: true });

  _sqlite = new Database(DB_FILE);
  _sqlite.pragma('journal_mode = WAL');

  const db = drizzle(_sqlite);

  // Run migrations before setting _db so a failed migration
  // doesn't leave _db in an un-migrated state
  migrate(db, { migrationsFolder: './drizzle' });

  _db = db;
  return _db;
}

export function getSqlite() {
  getDb(); // Ensure database is initialized
  return _sqlite;
}

export function _resetDb() {
  if (_sqlite) _sqlite.close();
  _sqlite = null;
  _db = null;
}

export function getUploadsDir() {
  return UPLOADS_DIR;
}

function hashPassword(password: string) {
  return createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return randomBytes(32).toString('hex');
}

// ── Users ───────────────────────────────────────────────────────────────────

export function registerUser(username: string, password: string) {
  const db = getDb();
  const existing = db.select().from(users).where(eq(users.username, username)).get();
  if (existing) {
    return { error: 'User already exists' as const, status: 409 as const };
  }
  const now = new Date().toISOString();
  db.insert(users)
    .values({
      username,
      password: hashPassword(password),
      createdAt: now,
    })
    .run();
  const token = generateToken();
  db.insert(sessions).values({ username, token, createdAt: now }).run();
  return { token };
}

export function loginUser(username: string, password: string) {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || user.password !== hashPassword(password)) {
    return { error: 'Invalid credentials' as const, status: 401 as const };
  }
  const token = generateToken();
  db.insert(sessions).values({ username, token, createdAt: new Date().toISOString() }).run();
  return { token };
}

export function authenticate(
  username: string | null | undefined,
  token: string | null | undefined,
) {
  if (!username || !token) return false;
  const db = getDb();
  const session = db
    .select()
    .from(sessions)
    .where(and(eq(sessions.username, username), eq(sessions.token, token)))
    .get();
  return session != null;
}

export function logoutUser(username: string, token: string) {
  const db = getDb();
  db.delete(sessions)
    .where(and(eq(sessions.username, username), eq(sessions.token, token)))
    .run();
}

export function changePassword(username: string, currentPassword: string, newPassword: string) {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || user.password !== hashPassword(currentPassword)) {
    return { error: 'Invalid current password' as const, status: 401 as const };
  }
  db.update(users)
    .set({ password: hashPassword(newPassword) })
    .where(eq(users.username, username))
    .run();
  return { success: true as const };
}

export function getUser(username: string) {
  const db = getDb();
  const user = db
    .select({ username: users.username, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.username, username))
    .get();
  return user || null;
}

// ── Deployments ─────────────────────────────────────────────────────────────

interface DeploymentInput {
  name: string;
  type?: string;
  username: string;
  port?: number;
  containerId?: string;
  containerName?: string;
  directory?: string;
  extraPorts?: string | null;
  createdAt?: string;
}

export function saveDeployment(deployment: DeploymentInput) {
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(deployments)
    .values({
      name: deployment.name,
      type: deployment.type || null,
      username: deployment.username,
      port: deployment.port || null,
      containerId: deployment.containerId || null,
      containerName: deployment.containerName || null,
      directory: deployment.directory || null,
      extraPorts: deployment.extraPorts || null,
      createdAt: deployment.createdAt || now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: deployments.name,
      set: {
        type: deployment.type || null,
        username: deployment.username,
        port: deployment.port || null,
        containerId: deployment.containerId || null,
        containerName: deployment.containerName || null,
        directory: deployment.directory || null,
        extraPorts: deployment.extraPorts || null,
        updatedAt: now,
      },
    })
    .run();
}

export function getDeployment(name: string) {
  const db = getDb();
  return db.select().from(deployments).where(eq(deployments.name, name)).get() || null;
}

export function getDeployments(username: string) {
  const db = getDb();
  return db.select().from(deployments).where(eq(deployments.username, username)).all();
}

export function deleteDeployment(name: string) {
  const db = getDb();
  db.delete(deployments).where(eq(deployments.name, name)).run();
}

export function updateDeploymentSettings(name: string, settings: { autoBackup?: boolean; discoverable?: boolean; envVars?: Record<string, string> }) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (settings.autoBackup !== undefined) set.autoBackup = settings.autoBackup;
  if (settings.discoverable !== undefined) set.discoverable = settings.discoverable;
  if (settings.envVars !== undefined) set.envVars = JSON.stringify(settings.envVars);
  db.update(deployments)
    .set(set)
    .where(eq(deployments.name, name))
    .run();
}

export function getDeploymentEnvVars(name: string): Record<string, string> {
  const d = getDeployment(name);
  if (!d?.envVars) return {};
  return JSON.parse(d.envVars);
}

export function updateDeploymentStatus(name: string, status: string) {
  const db = getDb();
  db.update(deployments)
    .set({
      status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(deployments.name, name))
    .run();
}

export function getAllDeployments() {
  const db = getDb();
  return db.select().from(deployments).all();
}

export function getDiscoverableDeployments() {
  const db = getDb();
  return db.select().from(deployments).where(eq(deployments.discoverable, true)).all();
}

// ── Deployment history ───────────────────────────────────────────────────────

interface DeployEvent {
  action: string;
  username?: string;
  type?: string;
  port?: number;
  containerId?: string;
}

export function addDeployEvent(name: string, event: DeployEvent) {
  const db = getDb();
  db.insert(history)
    .values({
      deploymentName: name,
      action: event.action,
      username: event.username || null,
      type: event.type || null,
      port: event.port || null,
      containerId: event.containerId || null,
      timestamp: new Date().toISOString(),
    })
    .run();
}

export function getDeployHistory(name: string) {
  const db = getDb();
  return db.select().from(history).where(eq(history.deploymentName, name)).all();
}

// ── Request logs ────────────────────────────────────────────────────────────

interface RequestEntry {
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  requestSize?: number | null;
  responseSize?: number | null;
  queryParams?: string | null;
  username?: string | null;
}

export function logRequest(name: string, entry: RequestEntry) {
  const db = getDb();
  db.insert(requestLogs)
    .values({
      deploymentName: name,
      method: entry.method,
      path: entry.path,
      status: entry.status,
      duration: entry.duration,
      timestamp: entry.timestamp,
      ip: entry.ip || null,
      userAgent: entry.userAgent || null,
      referrer: entry.referrer || null,
      requestSize: entry.requestSize || null,
      responseSize: entry.responseSize || null,
      queryParams: entry.queryParams || null,
      username: entry.username || null,
    })
    .run();
}

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
  const db = getDb();
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
    })
    .from(requestLogs)
    .where(and(...conditions));

  // Sort by timestamp descending (latest first)
  const allLogs = query.orderBy(desc(requestLogs.timestamp)).all();
  const total = allLogs.length;
  const logs = allLogs.slice(offset, offset + limit);

  return {
    logs,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  };
}

export function getPathAnalytics(
  name: string,
  options?: { fromTimestamp?: number; toTimestamp?: number },
) {
  const db = getDb();

  let conditions = [eq(requestLogs.deploymentName, name)];

  // Add time range filtering if provided
  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }

  // Get all logs for this deployment
  const allLogs = db
    .select({
      path: requestLogs.path,
      status: requestLogs.status,
      duration: requestLogs.duration,
    })
    .from(requestLogs)
    .where(and(...conditions))
    .all();

  // Group by path
  const pathMap = new Map<string, { durations: number[]; errors: number }>();

  for (const log of allLogs) {
    if (!pathMap.has(log.path)) {
      pathMap.set(log.path, { durations: [], errors: 0 });
    }
    const stats = pathMap.get(log.path)!;
    stats.durations.push(log.duration);
    if (log.status >= 400) stats.errors++;
  }

  // Convert to array and calculate stats
  return Array.from(pathMap.entries())
    .map(([path, stats]) => ({
      path,
      count: stats.durations.length,
      avgDuration: Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length),
      errorRate: Math.round((stats.errors / stats.durations.length) * 100),
    }))
    .sort((a, b) => b.count - a.count);
}

export function getRequestSummary(
  name: string,
  options?: { fromTimestamp?: number; toTimestamp?: number },
) {
  const db = getDb();

  let conditions = [eq(requestLogs.deploymentName, name)];

  // Add time range filtering if provided
  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }

  // Get ALL logs for this deployment (not paginated) for accurate summary
  const logs = db
    .select({
      status: requestLogs.status,
      duration: requestLogs.duration,
      timestamp: requestLogs.timestamp,
    })
    .from(requestLogs)
    .where(and(...conditions))
    .all();

  if (logs.length === 0)
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
  let totalDuration = 0;
  const durations: number[] = [];

  for (const log of logs) {
    const group = `${Math.floor(log.status / 100)}xx`;
    statusCodes[group] = (statusCodes[group] || 0) + 1;
    totalDuration += log.duration;
    durations.push(log.duration);
  }

  // Calculate percentiles
  durations.sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

  const oneMinAgo = Date.now() - 60_000;
  const recentCount = logs.filter((l) => l.timestamp > oneMinAgo).length;

  return {
    total: logs.length,
    statusCodes,
    avgDuration: Math.round(totalDuration / logs.length),
    recentRpm: recentCount,
    p50,
    p95,
    p99,
  };
}

// ── Endpoint detail ──────────────────────────────────────────────────────

function chooseBucketInterval(fromTs: number, toTs: number): number {
  const rangeMs = toTs - fromTs;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  if (rangeMs <= 6 * HOUR) return 5 * 60_000; // 5-minute buckets
  if (rangeMs <= 2 * DAY) return HOUR; // hourly
  if (rangeMs <= 14 * DAY) return 6 * HOUR; // 6-hour
  if (rangeMs <= 60 * DAY) return DAY; // daily
  if (rangeMs <= 365 * DAY) return 7 * DAY; // weekly
  return 30 * DAY; // monthly
}

export function getEndpointDetail(
  name: string,
  path: string,
  options?: {
    fromTimestamp?: number;
    toTimestamp?: number;
    page?: number;
    limit?: number;
  },
) {
  const db = getDb();

  const conditions = [eq(requestLogs.deploymentName, name), eq(requestLogs.path, path)];
  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }
  const where = and(...conditions);

  // ── Summary ──
  const allLogs = db
    .select({
      status: requestLogs.status,
      duration: requestLogs.duration,
      requestSize: requestLogs.requestSize,
      responseSize: requestLogs.responseSize,
    })
    .from(requestLogs)
    .where(where)
    .all();

  const durations = allLogs.map((l) => l.duration).sort((a, b) => a - b);
  const totalDuration = durations.reduce((a, b) => a + b, 0);
  const statusCodes: Record<string, number> = {};
  let errors = 0;
  let totalRequestBytes = 0;
  let totalResponseBytes = 0;
  for (const log of allLogs) {
    const group = `${Math.floor(log.status / 100)}xx`;
    statusCodes[group] = (statusCodes[group] || 0) + 1;
    if (log.status >= 400) errors++;
    totalRequestBytes += log.requestSize || 0;
    totalResponseBytes += log.responseSize || 0;
  }

  const summary = {
    totalRequests: allLogs.length,
    avgDuration: allLogs.length ? Math.round(totalDuration / allLogs.length) : 0,
    p50: durations[Math.floor(durations.length * 0.5)] || 0,
    p95: durations[Math.floor(durations.length * 0.95)] || 0,
    p99: durations[Math.floor(durations.length * 0.99)] || 0,
    errorRate: allLogs.length ? Math.round((errors / allLogs.length) * 100) : 0,
    statusCodes,
    totalRequestBytes,
    totalResponseBytes,
  };

  // ── Time series ──
  let fromTs = options?.fromTimestamp;
  let toTs = options?.toTimestamp ?? Date.now();
  if (!fromTs) {
    const range = db
      .select({
        minTs: sql<number>`min(${requestLogs.timestamp})`,
        maxTs: sql<number>`max(${requestLogs.timestamp})`,
      })
      .from(requestLogs)
      .where(where)
      .get();
    fromTs = range?.minTs ?? toTs;
    toTs = range?.maxTs ?? toTs;
  }

  const intervalMs = chooseBucketInterval(fromTs, toTs);

  const rawBuckets = db
    .select({
      bucket: sql<number>`(${requestLogs.timestamp} / ${intervalMs}) * ${intervalMs}`,
      count: sql<number>`count(*)`,
      avgDuration: sql<number>`round(avg(${requestLogs.duration}))`,
      errorCount: sql<number>`sum(case when ${requestLogs.status} >= 400 then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(where)
    .groupBy(sql`(${requestLogs.timestamp} / ${intervalMs}) * ${intervalMs}`)
    .orderBy(sql`(${requestLogs.timestamp} / ${intervalMs}) * ${intervalMs}`)
    .all();

  // Fill gaps
  const bucketMap = new Map(rawBuckets.map((b) => [b.bucket, b]));
  const timeSeries: Array<{ bucket: number; count: number; avgDuration: number; errorCount: number }> = [];
  const startBucket = Math.floor(fromTs / intervalMs) * intervalMs;
  const endBucket = Math.floor(toTs / intervalMs) * intervalMs;
  for (let b = startBucket; b <= endBucket; b += intervalMs) {
    const existing = bucketMap.get(b);
    timeSeries.push(existing ?? { bucket: b, count: 0, avgDuration: 0, errorCount: 0 });
  }

  // ── Recent requests (paginated) ──
  const page = options?.page || 1;
  const limit = options?.limit || 20;
  const offset = (page - 1) * limit;

  const recentAll = db
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
    })
    .from(requestLogs)
    .where(where)
    .orderBy(desc(requestLogs.timestamp))
    .all();

  const total = recentAll.length;
  const logs = recentAll.slice(offset, offset + limit);

  return {
    summary,
    timeSeries,
    recentRequests: { logs, total, page, totalPages: Math.ceil(total / limit) },
    bucketIntervalMs: intervalMs,
  };
}

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

export function getMetricsHistory(name: string, since: number) {
  const db = getDb();
  return db
    .select({
      cpuPercent: resourceMetrics.cpuPercent,
      memUsageBytes: resourceMetrics.memUsageBytes,
      memLimitBytes: resourceMetrics.memLimitBytes,
      memPercent: resourceMetrics.memPercent,
      netRxBytes: resourceMetrics.netRxBytes,
      netTxBytes: resourceMetrics.netTxBytes,
      blockReadBytes: resourceMetrics.blockReadBytes,
      blockWriteBytes: resourceMetrics.blockWriteBytes,
      pids: resourceMetrics.pids,
      timestamp: resourceMetrics.timestamp,
    })
    .from(resourceMetrics)
    .where(eq(resourceMetrics.deploymentName, name))
    .all()
    .filter((r) => r.timestamp >= since);
}

// ── Request rate & punchcard ──────────────────────────────────────────────

export function getRequestRateBuckets(
  name: string,
  since: number,
  bucketSizeMs: number,
): { timestamp: number; count: number }[] {
  const db = getDb();
  const now = Date.now();

  const rows = db
    .select({
      bucket: sql<number>`(${requestLogs.timestamp} / ${bucketSizeMs}) * ${bucketSizeMs}`,
      count: sql<number>`count(*)`,
    })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.deploymentName, name),
        sql`${requestLogs.timestamp} >= ${since}`,
      ),
    )
    .groupBy(sql`(${requestLogs.timestamp} / ${bucketSizeMs}) * ${bucketSizeMs}`)
    .orderBy(sql`(${requestLogs.timestamp} / ${bucketSizeMs}) * ${bucketSizeMs}`)
    .all();

  // Fill in empty buckets so the sparkline has continuous data
  const bucketMap = new Map(rows.map((r) => [r.bucket, r.count]));
  const result: { timestamp: number; count: number }[] = [];
  const startBucket = Math.floor(since / bucketSizeMs) * bucketSizeMs;
  const endBucket = Math.floor(now / bucketSizeMs) * bucketSizeMs;
  for (let t = startBucket; t <= endBucket; t += bucketSizeMs) {
    result.push({ timestamp: t, count: bucketMap.get(t) || 0 });
  }
  return result;
}

export function getRequestPunchcard(
  name: string,
): { day: number; hour: number; count: number }[] {
  const db = getDb();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const rows = db
    .select({ timestamp: requestLogs.timestamp })
    .from(requestLogs)
    .where(
      and(
        eq(requestLogs.deploymentName, name),
        sql`${requestLogs.timestamp} >= ${sevenDaysAgo}`,
      ),
    )
    .all();

  // 7x24 grid: day 0=Sunday through 6=Saturday, hours 0-23
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const row of rows) {
    const d = new Date(row.timestamp);
    grid[d.getDay()][d.getHours()]++;
  }

  const result: { day: number; hour: number; count: number }[] = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      result.push({ day, hour, count: grid[day][hour] });
    }
  }
  return result;
}

// ── Backups ─────────────────────────────────────────────────────────────────

export function saveBackup(backup: {
  deploymentName: string;
  filename: string;
  label: string | null;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
  volumePaths: string[];
}) {
  const db = getDb();
  db.insert(backups)
    .values({
      deploymentName: backup.deploymentName,
      filename: backup.filename,
      label: backup.label,
      sizeBytes: backup.sizeBytes,
      createdBy: backup.createdBy,
      createdAt: backup.createdAt,
      volumePaths: JSON.stringify(backup.volumePaths),
    })
    .run();
}

export function getBackups(deploymentName: string) {
  const db = getDb();
  return db
    .select()
    .from(backups)
    .where(eq(backups.deploymentName, deploymentName))
    .all()
    .map((b) => ({
      ...b,
      volumePaths: JSON.parse(b.volumePaths) as string[],
    }));
}

export function deleteBackupRecord(deploymentName: string, filename: string) {
  const db = getDb();
  db.delete(backups)
    .where(and(eq(backups.deploymentName, deploymentName), eq(backups.filename, filename)))
    .run();
}

// ── Build Logs ──────────────────────────────────────────────────────────────

export function createBuildLog(deploymentName: string): number {
  const db = getDb();
  const result = db.insert(buildLogs)
    .values({
      deploymentName,
      output: '',
      success: null,
      duration: null,
      status: 'building',
      timestamp: new Date().toISOString(),
    })
    .returning({ id: buildLogs.id })
    .get();
  return result.id;
}

export function updateBuildOutput(id: number, output: string) {
  const db = getDb();
  db.update(buildLogs)
    .set({ output })
    .where(eq(buildLogs.id, id))
    .run();
}

export function completeBuildLog(id: number, log: { output: string; success: boolean; duration: number }) {
  const db = getDb();
  db.update(buildLogs)
    .set({
      output: log.output,
      success: log.success,
      duration: log.duration,
      status: log.success ? 'complete' : 'failed',
    })
    .where(eq(buildLogs.id, id))
    .run();
}

export function getActiveBuildLog(deploymentName: string) {
  const db = getDb();
  return db
    .select()
    .from(buildLogs)
    .where(and(eq(buildLogs.deploymentName, deploymentName), eq(buildLogs.status, 'building')))
    .orderBy(desc(buildLogs.timestamp))
    .limit(1)
    .get() ?? null;
}

export function getBuildLogs(
  deploymentName: string,
  page = 1,
  pageSize = 20,
) {
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const rows = db
    .select()
    .from(buildLogs)
    .where(eq(buildLogs.deploymentName, deploymentName))
    .orderBy(desc(buildLogs.timestamp))
    .limit(pageSize)
    .offset(offset)
    .all();
  const [{ count: total }] = db
    .select({ count: sql<number>`count(*)` })
    .from(buildLogs)
    .where(eq(buildLogs.deploymentName, deploymentName))
    .all();
  return { rows, total, page, pageSize };
}

export function getLatestBuildLog(deploymentName: string) {
  const db = getDb();
  return db
    .select()
    .from(buildLogs)
    .where(eq(buildLogs.deploymentName, deploymentName))
    .orderBy(desc(buildLogs.timestamp))
    .limit(1)
    .get();
}

export function saveRuntimeLogs(buildLogId: number, logs: string) {
  const db = getDb();
  db.update(buildLogs)
    .set({ runtimeLogs: logs })
    .where(eq(buildLogs.id, buildLogId))
    .run();
}

export function updateCurrentBuildLogId(name: string, buildLogId: number) {
  const db = getDb();
  db.update(deployments)
    .set({ currentBuildLogId: buildLogId, updatedAt: new Date().toISOString() })
    .where(eq(deployments.name, name))
    .run();
}
