import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import {
  users,
  sessions,
  deployments,
  history,
  requestLogs,
  resourceMetrics,
  backups,
  buildLogs,
  systemSettings,
} from './schema.ts';
import { parseMemoryLimit, type RawContainerStats } from './docker.ts';
import { isCrashLooping } from './crash-tracker.ts';

const DATA_DIR = process.env.DEPLOY_DATA_DIR || resolve(process.cwd(), '.deploy-data');
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
  // Incremental auto-vacuum reclaims space without the multi-second global lock
  // that a full VACUUM holds. Combined with PRAGMA incremental_vacuum in
  // maintenance, this avoids the periodic freeze the previous full-VACUUM loop
  // caused. The pragma is a no-op if already set; it only takes effect at DB
  // creation, so existing DBs keep their previous mode but won't freeze
  // because maintenance no longer runs full VACUUM.
  _sqlite.pragma('auto_vacuum = INCREMENTAL');

  const db = drizzle(_sqlite);

  // Run migrations before setting _db so a failed migration
  // doesn't leave _db in an un-migrated state
  migrate(db, { migrationsFolder: resolve(process.cwd(), 'drizzle') });

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
  _deploymentsCache = null;
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

// ── In-memory deployments cache ──────────────────────────────────────────────
// `getDeployment(name)` is called once for every request the reverse proxy
// handles (api.ts mDNS branch). At 100 req/s that's 100 synchronous SQLite
// queries on the main event loop — drizzle adds non-trivial dispatch overhead
// even though sqlite itself is fast. The cache makes each lookup an O(1) Map
// hit; writes invalidate or update individual rows.
type DeploymentRow = typeof deployments.$inferSelect;
let _deploymentsCache: Map<string, DeploymentRow> | null = null;

function loadDeploymentsCache(): Map<string, DeploymentRow> {
  if (_deploymentsCache) return _deploymentsCache;
  const db = getDb();
  const rows = db.select().from(deployments).all();
  const map = new Map<string, DeploymentRow>();
  for (const r of rows) map.set(r.name, r);
  _deploymentsCache = map;
  return map;
}

function refreshDeploymentInCache(name: string) {
  if (!_deploymentsCache) return; // not yet loaded — next read seeds it from DB
  const db = getDb();
  const row = db.select().from(deployments).where(eq(deployments.name, name)).get();
  if (row) {
    _deploymentsCache.set(name, row);
  } else {
    _deploymentsCache.delete(name);
  }
}

/** Drop the cache. Useful in tests; production code should prefer refreshDeploymentInCache. */
export function _invalidateDeploymentsCache() {
  _deploymentsCache = null;
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
  refreshDeploymentInCache(deployment.name);
}

export function getDeployment(name: string) {
  return loadDeploymentsCache().get(name) ?? null;
}

export function getDeployments(username: string) {
  const all = Array.from(loadDeploymentsCache().values());
  return all.filter((d) => d.username === username);
}

export function deleteDeployment(name: string) {
  const db = getDb();
  db.delete(deployments).where(eq(deployments.name, name)).run();
  _deploymentsCache?.delete(name);
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export function updateDeploymentSettings(
  name: string,
  settings: {
    autoBackup?: boolean;
    discoverable?: boolean;
    envVars?: Record<string, string>;
    memoryLimit?: string;
    cpuLimit?: string;
    volumes?: VolumeMount[];
    gpuEnabled?: boolean;
    privilegedDocker?: boolean;
  },
) {
  const db = getDb();
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (settings.autoBackup !== undefined) set.autoBackup = settings.autoBackup;
  if (settings.discoverable !== undefined) set.discoverable = settings.discoverable;
  if (settings.envVars !== undefined) set.envVars = JSON.stringify(settings.envVars);
  if (settings.memoryLimit !== undefined) set.memoryLimit = settings.memoryLimit;
  if (settings.cpuLimit !== undefined) set.cpuLimit = settings.cpuLimit;
  if (settings.volumes !== undefined) set.volumes = JSON.stringify(settings.volumes);
  if (settings.gpuEnabled !== undefined) set.gpuEnabled = settings.gpuEnabled;
  if (settings.privilegedDocker !== undefined) set.privilegedDocker = settings.privilegedDocker;
  db.update(deployments).set(set).where(eq(deployments.name, name)).run();
  refreshDeploymentInCache(name);
}

export function getDeploymentEnvVars(name: string): Record<string, string> {
  const d = getDeployment(name);
  if (!d?.envVars) return {};
  return JSON.parse(d.envVars);
}

export function getDeploymentVolumes(name: string): VolumeMount[] {
  const d = getDeployment(name);
  if (!d?.volumes) return [];
  return JSON.parse(d.volumes);
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
  refreshDeploymentInCache(name);
}

export function recordContainerStart(name: string) {
  const db = getDb();
  db.update(deployments)
    .set({ containerStartedAt: Date.now() })
    .where(eq(deployments.name, name))
    .run();
  refreshDeploymentInCache(name);
}

export function getAllDeployments() {
  return Array.from(loadDeploymentsCache().values());
}

export function getAllocatedMemory() {
  const db = getDb();
  const all = db
    .select({
      name: deployments.name,
      memoryLimit: deployments.memoryLimit,
      status: deployments.status,
    })
    .from(deployments)
    .all();

  let totalBytes = 0;
  const perDeployment: Array<{ name: string; memoryLimit: string; bytes: number; status: string }> =
    [];

  for (const d of all) {
    const limit = d.memoryLimit || '4g';
    const bytes = parseMemoryLimit(limit) || 0;
    totalBytes += bytes;
    perDeployment.push({
      name: d.name,
      memoryLimit: limit,
      bytes,
      status: d.status || 'stopped',
    });
  }

  return { totalBytes, perDeployment };
}

export function getDiscoverableDeployments() {
  return Array.from(loadDeploymentsCache().values()).filter((d) => d.discoverable === true);
}

// ── Deployment history ───────────────────────────────────────────────────────

interface DeployEvent {
  action: string;
  username?: string;
  type?: string;
  port?: number;
  containerId?: string;
  buildLogId?: number;
  durationMs?: number;
  source?: 'cli' | 'ui' | 'auto';
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
      buildLogId: event.buildLogId ?? null,
      durationMs: event.durationMs ?? null,
      source: event.source || null,
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

const REQUEST_LOG_BUFFER: Array<{ name: string; entry: RequestEntry }> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 2000;
// 500 vs the old 100: under sustained load the smaller batch forced a flush
// every few hundred ms, which dominated SQLite write throughput. 500 still
// fits comfortably in one transaction; the 2s timer keeps low-traffic apps
// from waiting.
const FLUSH_BATCH_SIZE = 500;

// Cached prepared transaction. The INSERT statement is compiled once on first
// flush; previously the planner re-ran on every flush because `prepare` was
// inside `flushRequestLogs`.
let _requestLogTx: ((items: Array<{ name: string; entry: RequestEntry }>) => void) | null = null;

function ensureRequestLogTx() {
  if (_requestLogTx) return _requestLogTx;
  const sqlite = getSqlite();
  if (!sqlite) return null;
  const insert = sqlite.prepare<
    [
      string,
      string,
      string,
      number,
      number,
      number,
      string | null,
      string | null,
      string | null,
      number | null,
      number | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO request_logs (deployment_name, method, path, status, duration, timestamp, ip, user_agent, referrer, request_size, response_size, query_params, username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  _requestLogTx = sqlite.transaction((items: Array<{ name: string; entry: RequestEntry }>) => {
    for (const { name, entry } of items) {
      insert.run(
        name,
        entry.method,
        entry.path,
        entry.status,
        entry.duration,
        entry.timestamp,
        entry.ip || null,
        entry.userAgent || null,
        entry.referrer || null,
        entry.requestSize || null,
        entry.responseSize || null,
        entry.queryParams || null,
        entry.username || null,
      );
    }
  });
  return _requestLogTx;
}

export function logRequest(name: string, entry: RequestEntry) {
  REQUEST_LOG_BUFFER.push({ name, entry });
  if (REQUEST_LOG_BUFFER.length >= FLUSH_BATCH_SIZE) {
    flushRequestLogs();
  } else if (!flushTimer) {
    flushTimer = setTimeout(flushRequestLogs, FLUSH_INTERVAL_MS);
  }
}

// Worker thread that owns its own SQLite connection and runs the INSERT
// transaction off the main event loop. Lazily started on first flush; falls
// back to in-process write if the worker can't be spawned (e.g. test runner,
// missing dist file). `logWorkerDisabled` becomes true after a fallback so we
// don't retry the spawn on every flush.
let logWorker: Worker | null = null;
let logWorkerDisabled = false;

function getLogWorker(): Worker | null {
  if (logWorker) return logWorker;
  if (logWorkerDisabled) return null;
  try {
    const workerUrl = new URL('./log-worker.ts', import.meta.url);
    logWorker = new Worker(workerUrl, {
      workerData: { dbFile: DB_FILE },
      // Inherit the parent's execArgv so tsx/native TS stripping flows into
      // the worker — without this, .ts file URLs fail to load under tsx.
      execArgv: process.execArgv,
    });
    logWorker.on('error', (err) => {
      console.error('[store] log-worker errored, falling back to in-process flush:', err);
      logWorker = null;
      logWorkerDisabled = true;
    });
    logWorker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[store] log-worker exited with code ${code}`);
      }
      logWorker = null;
    });
    return logWorker;
  } catch (err) {
    console.warn(
      '[store] could not start log-worker, falling back to in-process flush:',
      (err as Error).message,
    );
    logWorkerDisabled = true;
    return null;
  }
}

export function flushRequestLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (REQUEST_LOG_BUFFER.length === 0) return;

  const batch = REQUEST_LOG_BUFFER.splice(0);

  // Preferred path: ship the batch to the worker and return immediately.
  // The actual transaction runs off the main thread.
  const worker = getLogWorker();
  if (worker) {
    try {
      worker.postMessage({ type: 'flush', items: batch });
      return;
    } catch (err) {
      // postMessage can throw if the worker terminated mid-send; fall through
      // to in-process flush so we don't drop the batch.
      console.warn('[store] worker postMessage failed, falling back:', err);
    }
  }

  // Fallback: run the transaction inline on the main thread (legacy path).
  const tx = ensureRequestLogTx();
  if (!tx) return;
  try {
    tx(batch);
  } catch (err) {
    // A single bad row used to abort the whole batch; rather than lose it,
    // log the failure but keep serving traffic. Losing some request_logs is
    // acceptable; pinning the event loop on a failing transaction is not.
    console.error('flushRequestLogs failed:', err);
  }
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

export function getPathAnalytics(
  name: string,
  options?: { fromTimestamp?: number; toTimestamp?: number; limit?: number },
) {
  const db = getDb();

  let conditions = [eq(requestLogs.deploymentName, name)];

  if (options?.fromTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} >= ${options.fromTimestamp}`);
  }
  if (options?.toTimestamp) {
    conditions.push(sql`${requestLogs.timestamp} <= ${options.toTimestamp}`);
  }

  // Strip ?query strings at GROUP BY time so /foo?a=1 and /foo?a=2 collapse.
  const normalizedPath = sql<string>`CASE WHEN instr(${requestLogs.path}, '?') > 0 THEN substr(${requestLogs.path}, 1, instr(${requestLogs.path}, '?') - 1) ELSE ${requestLogs.path} END`;
  const limit = Math.min(options?.limit ?? 50, 200);

  return db
    .select({
      path: sql<string>`${normalizedPath}`.as('path'),
      count: sql<number>`count(*)`,
      avgDuration: sql<number>`round(avg(${requestLogs.duration}))`,
      errorRate: sql<number>`round(sum(case when ${requestLogs.status} >= 400 then 1.0 else 0.0 end) / count(*) * 100)`,
    })
    .from(requestLogs)
    .where(and(...conditions))
    .groupBy(normalizedPath)
    .orderBy(sql`count(*) desc`)
    .limit(limit)
    .all();
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

  // Fetch only durations for percentile calculation
  const durations = db
    .select({ duration: requestLogs.duration })
    .from(requestLogs)
    .where(and(...conditions))
    .orderBy(requestLogs.duration)
    .all()
    .map((r) => r.duration);

  const p50 = durations[Math.floor(durations.length * 0.5)] || 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] || 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] || 0;

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
  const timeSeries: Array<{
    bucket: number;
    count: number;
    avgDuration: number;
    errorCount: number;
  }> = [];
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

  const [{ count: total }] = db
    .select({ count: sql<number>`count(*)` })
    .from(requestLogs)
    .where(where)
    .all();

  const logs = db
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
    .limit(limit)
    .offset(offset)
    .all();

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
    .where(and(eq(resourceMetrics.deploymentName, name), gte(resourceMetrics.timestamp, since)))
    .all();
}

export type HealthSeverity = 'healthy' | 'degraded' | 'down' | 'idle' | 'building';

export interface DashboardAppStat {
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
 *  - building/uploading/starting → 'building' (yellow, in-progress)
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
  if (status === 'building' || status === 'uploading' || status === 'starting') return 'building';
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

  // Request aggregates per app over last 60s. Single query, GROUP BY app.
  const reqRows = sqlite
    .prepare(
      `SELECT deployment_name as deploymentName,
              count(*) as total,
              sum(CASE WHEN status >= 500 THEN 1 ELSE 0 END) as errors
       FROM request_logs
       WHERE timestamp >= ?
       GROUP BY deployment_name`,
    )
    .all(oneMinAgo) as Array<{ deploymentName: string; total: number; errors: number }>;
  const reqByApp = new Map(reqRows.map((r) => [r.deploymentName, r]));

  // p95 per app — separate query (fetch durations, sort in JS). Bounded by
  // 60s of data; cheap for typical deployments. For huge volumes we'd switch
  // to a t-digest, but at home-PaaS scale this is fine.
  const p95Stmt = sqlite.prepare(
    `SELECT duration FROM request_logs
     WHERE deployment_name = ? AND timestamp >= ?
     ORDER BY duration`,
  );

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
    const r = reqByApp.get(d.name);
    const status = d.status ?? 'stopped';
    const total = r?.total ?? 0;
    const errors = r?.errors ?? 0;
    const rps = total > 0 ? total / 60 : 0;
    const errPct = total > 0 ? (errors / total) * 100 : 0;

    let p95 = 0;
    if (total > 0) {
      const durations = p95Stmt.all(d.name, oneMinAgo) as Array<{ duration: number }>;
      if (durations.length > 0) {
        p95 = durations[Math.floor(durations.length * 0.95)]?.duration ?? 0;
      }
    }

    const crashLooping = isCrashLooping(d.name);
    const stat: DashboardAppStat = {
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

// ── Fleet-wide series & activity ────────────────────────────────────────────
// Powers the global dashboard's "command center" panel. Sums across every
// deployment so the dashboard can show one timeline of total traffic and one
// timeline of fleet-wide errors. Pure read paths; no caching needed at this
// scale (SQLite query on indexed timestamp column completes in single-digit
// ms for ~24h of request logs).

export interface FleetSeriesPoint {
  bucket: number;
  total: number;
  errors: number;
}

export function getFleetSeries(
  fromMs: number,
  toMs: number,
): { bucketMs: number; series: FleetSeriesPoint[] } {
  const db = getDb();
  const bucketMs = pickBucketMs(toMs - fromMs);

  const bucketExpr = sql`CAST(${requestLogs.timestamp} / ${bucketMs} AS INTEGER) * ${bucketMs}`;
  const rows = db
    .select({
      bucket: sql<number>`${bucketExpr}`.as('bucket'),
      total: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${requestLogs.status} >= 500 then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(and(gte(requestLogs.timestamp, fromMs), sql`${requestLogs.timestamp} <= ${toMs}`))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
    .all();

  const byBucket = new Map(rows.map((r) => [r.bucket, r]));
  const startBucket = Math.floor(fromMs / bucketMs) * bucketMs;
  const endBucket = Math.floor(toMs / bucketMs) * bucketMs;
  const maxBuckets = 500;
  const stride = Math.max(1, Math.ceil((endBucket - startBucket) / bucketMs / maxBuckets));
  const series: FleetSeriesPoint[] = [];
  for (let t = startBucket; t <= endBucket; t += bucketMs * stride) {
    const existing = byBucket.get(t);
    series.push({
      bucket: t,
      total: existing?.total ?? 0,
      errors: existing?.errors ?? 0,
    });
  }
  return { bucketMs: bucketMs * stride, series };
}

export interface FleetActivityRow {
  id: number;
  deploymentName: string;
  action: string;
  source: string | null;
  durationMs: number | null;
  timestamp: string;
}

export function getRecentFleetActivity(limit = 20): FleetActivityRow[] {
  const db = getDb();
  return db
    .select({
      id: history.id,
      deploymentName: history.deploymentName,
      action: history.action,
      source: history.source,
      durationMs: history.durationMs,
      timestamp: history.timestamp,
    })
    .from(history)
    .orderBy(desc(history.timestamp))
    .limit(Math.min(limit, 100))
    .all();
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

// ── Request rate & punchcard ──────────────────────────────────────────────

export function getRequestRateBuckets(
  name: string,
  since: number,
  bucketSizeMs: number,
): { timestamp: number; count: number }[] {
  const db = getDb();
  const now = Date.now();

  // CAST to INTEGER — parameter-bound bucketSizeMs would otherwise trigger
  // floating-point division, hashing every row to its own bucket.
  const bucketExpr = sql`CAST(${requestLogs.timestamp} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`;
  const rows = db
    .select({
      bucket: sql<number>`${bucketExpr}`,
      count: sql<number>`count(*)`,
    })
    .from(requestLogs)
    .where(and(eq(requestLogs.deploymentName, name), sql`${requestLogs.timestamp} >= ${since}`))
    .groupBy(bucketExpr)
    .orderBy(bucketExpr)
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

export function getRequestPunchcard(name: string): { day: number; hour: number; count: number }[] {
  const db = getDb();
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  const rows = db
    .select({ timestamp: requestLogs.timestamp })
    .from(requestLogs)
    .where(
      and(eq(requestLogs.deploymentName, name), sql`${requestLogs.timestamp} >= ${sevenDaysAgo}`),
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
  relatedBuildLogId?: number | null;
  auto?: boolean;
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
      relatedBuildLogId: backup.relatedBuildLogId ?? null,
      auto: backup.auto ?? false,
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
  const result = db
    .insert(buildLogs)
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
  db.update(buildLogs).set({ output }).where(eq(buildLogs.id, id)).run();
}

export function completeBuildLog(
  id: number,
  log: { output: string; success: boolean; duration: number },
) {
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
  return (
    db
      .select()
      .from(buildLogs)
      .where(and(eq(buildLogs.deploymentName, deploymentName), eq(buildLogs.status, 'building')))
      .orderBy(desc(buildLogs.timestamp))
      .limit(1)
      .get() ?? null
  );
}

export function getBuildLogs(deploymentName: string, page = 1, pageSize = 20) {
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
  db.update(buildLogs).set({ runtimeLogs: logs }).where(eq(buildLogs.id, buildLogId)).run();
}

export function updateCurrentBuildLogId(name: string, buildLogId: number) {
  const db = getDb();
  db.update(deployments)
    .set({ currentBuildLogId: buildLogId, updatedAt: new Date().toISOString() })
    .where(eq(deployments.name, name))
    .run();
}

/** Mark any build logs stuck in 'building' as failed (e.g. after a crash/restart). */
export function cleanupStaleBuildLogs() {
  const db = getDb();
  const stale = db
    .select({
      id: buildLogs.id,
      deploymentName: buildLogs.deploymentName,
      output: buildLogs.output,
    })
    .from(buildLogs)
    .where(eq(buildLogs.status, 'building'))
    .all();
  for (const row of stale) {
    db.update(buildLogs)
      .set({
        status: 'failed',
        success: false,
        output: (row.output || '') + '\n[Build interrupted — server restarted]',
      })
      .where(eq(buildLogs.id, row.id))
      .run();
    console.log(`Cleaned up stale build log #${row.id} for ${row.deploymentName}`);
  }
  // Also reset any deployments stuck in pre-container states
  db.update(deployments)
    .set({ status: 'unknown', updatedAt: new Date().toISOString() })
    .where(sql`${deployments.status} IN ('building', 'starting', 'uploading')`)
    .run();
}

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
  const reqAgg = db
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
    const durations = db
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
  const db = getDb();
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

export function getTopErrorPaths(
  name: string,
  fromMs: number,
  limit = 10,
): Array<{ path: string; total: number; errors: number; errorRate: number }> {
  const db = getDb();
  const normalizedPath = sql<string>`CASE WHEN instr(${requestLogs.path}, '?') > 0 THEN substr(${requestLogs.path}, 1, instr(${requestLogs.path}, '?') - 1) ELSE ${requestLogs.path} END`;
  const rows = db
    .select({
      path: sql<string>`${normalizedPath}`.as('path'),
      total: sql<number>`count(*)`,
      errors: sql<number>`sum(case when ${requestLogs.status} >= 400 then 1 else 0 end)`,
    })
    .from(requestLogs)
    .where(and(eq(requestLogs.deploymentName, name), gte(requestLogs.timestamp, fromMs)))
    .groupBy(normalizedPath)
    .having(sql`sum(case when ${requestLogs.status} >= 400 then 1 else 0 end) > 0`)
    .orderBy(sql`sum(case when ${requestLogs.status} >= 400 then 1 else 0 end) desc`)
    .limit(Math.min(limit, 50))
    .all();

  return rows.map((r) => ({
    path: r.path,
    total: r.total ?? 0,
    errors: r.errors ?? 0,
    errorRate: r.total ? Math.round(((r.errors ?? 0) / r.total) * 100) : 0,
  }));
}

// ── System Settings ─────────────────────────────────────────────────────────

export function getSystemSetting(key: string): string | null {
  const db = getDb();
  const row = db.select().from(systemSettings).where(eq(systemSettings.key, key)).get();
  return row?.value ?? null;
}

export function setSystemSetting(key: string, value: string): void {
  const db = getDb();
  db.insert(systemSettings)
    .values({
      key,
      value,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: {
        value,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

export interface BackupSettings {
  enabled: boolean;
  destination: string;
  cron: string;
}

const BACKUP_SETTINGS_DEFAULTS: BackupSettings = {
  enabled: false,
  destination: '/Volumes/CLOUD/deploy-backup',
  cron: '0 */6 * * *',
};

export function getBackupSettings(): BackupSettings {
  const raw = getSystemSetting('backup_settings');
  if (!raw) return { ...BACKUP_SETTINGS_DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled:
        typeof parsed.enabled === 'boolean' ? parsed.enabled : BACKUP_SETTINGS_DEFAULTS.enabled,
      destination:
        typeof parsed.destination === 'string'
          ? parsed.destination
          : BACKUP_SETTINGS_DEFAULTS.destination,
      cron: typeof parsed.cron === 'string' ? parsed.cron : BACKUP_SETTINGS_DEFAULTS.cron,
    };
  } catch {
    return { ...BACKUP_SETTINGS_DEFAULTS };
  }
}

export function saveBackupSettings(settings: BackupSettings): void {
  setSystemSetting('backup_settings', JSON.stringify(settings));
}
