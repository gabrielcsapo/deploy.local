import { mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
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
  requestLogs1m,
  resourceMetrics,
  backups,
  buildLogs,
  systemSettings,
} from './schema.ts';
import { parseMemoryLimit, type RawContainerStats } from './docker.ts';
import { isCrashLooping } from './crash-tracker.ts';
import { ROLLUP_BACKFILL_SQL } from './rollup.ts';
import { notifyRouteChanged } from './ipc.ts';

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
  // Multiple connections write to this DB (main thread, log-worker thread,
  // and — post edge-split — a second process). Without a busy timeout a
  // colliding write transaction throws SQLITE_BUSY instead of waiting.
  _sqlite.pragma('busy_timeout = 5000');
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

  // One-time rollup backfill: aggregate existing raw request_logs into
  // request_logs_1m the first time we open a DB that has raw rows but an
  // empty rollup table. A few seconds for 90 days of logs, once.
  try {
    const rollupCount = (
      _sqlite.prepare('SELECT count(*) AS c FROM request_logs_1m').get() as { c: number }
    ).c;
    if (rollupCount === 0) {
      const rawCount = (
        _sqlite.prepare('SELECT count(*) AS c FROM request_logs').get() as { c: number }
      ).c;
      if (rawCount > 0) {
        const start = Date.now();
        _sqlite.prepare(ROLLUP_BACKFILL_SQL).run();
        console.log(
          `[store] Backfilled request_logs_1m from ${rawCount} raw rows in ${Date.now() - start}ms`,
        );
      }
    }
  } catch (err) {
    console.warn('[store] rollup backfill failed (will retry next start):', err);
  }

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

// ── Password hashing ─────────────────────────────────────────────────────────
// scrypt with a per-user random salt, stored as `scrypt:<salt>:<hash>`.
// Accounts created before this change hold a bare unsalted sha256 hex digest;
// verifyPassword still accepts those and loginUser transparently rehashes on
// the next successful login.

function legacySha256(password: string) {
  return createHash('sha256').update(password).digest('hex');
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    if (stored.startsWith('scrypt:')) {
      const [, saltHex, hashHex] = stored.split(':');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
      return expected.length > 0 && timingSafeEqual(actual, expected);
    }
    const expected = Buffer.from(stored, 'hex');
    const actual = Buffer.from(legacySha256(password), 'hex');
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function generateToken() {
  return randomBytes(32).toString('hex');
}

// Sessions expire after 30 days — matches the auth cookie's Max-Age, so the
// browser and DB agree on lifetime. Expired rows are pruned by maintenance.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function createSession(username: string): string {
  const db = getDb();
  const token = generateToken();
  db.insert(sessions)
    .values({
      username,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    })
    .run();
  return token;
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
  return { token: createSession(username) };
}

export function loginUser(username: string, password: string) {
  const db = getDb();
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user || !verifyPassword(password, user.password)) {
    return { error: 'Invalid credentials' as const, status: 401 as const };
  }
  // Transparent upgrade: legacy sha256 hashes are replaced with scrypt the
  // first time the password is presented and verified.
  if (!user.password.startsWith('scrypt:')) {
    db.update(users)
      .set({ password: hashPassword(password) })
      .where(eq(users.username, username))
      .run();
  }
  return { token: createSession(username) };
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
  if (!session) return false;
  // Sessions created before TTLs existed have no expiry — accept them; the
  // maintenance pruner ages them out by createdAt instead.
  if (session.expiresAt != null && session.expiresAt < Date.now()) return false;
  return true;
}

/** Delete expired sessions (and pre-TTL sessions older than the TTL). */
export function pruneExpiredSessions(): number {
  const sqlite = getSqlite();
  if (!sqlite) return 0;
  const now = Date.now();
  const cutoffIso = new Date(now - SESSION_TTL_MS).toISOString();
  const result = sqlite
    .prepare(
      `DELETE FROM sessions
       WHERE (expires_at IS NOT NULL AND expires_at < ?)
          OR (expires_at IS NULL AND created_at < ?)`,
    )
    .run(now, cutoffIso);
  return result.changes;
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
  if (!user || !verifyPassword(currentPassword, user.password)) {
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
  if (_deploymentsCache) {
    const db = getDb();
    const row = db.select().from(deployments).where(eq(deployments.name, name)).get();
    if (row) {
      _deploymentsCache.set(name, row);
    } else {
      _deploymentsCache.delete(name);
    }
  }
  // Hint the edge process (or in-process edge modules) that this deployment's
  // row changed — it re-reads the row and reconciles routes/mDNS/TCP proxies.
  // No-op when no IPC link is registered.
  notifyRouteChanged(name);
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
  notifyRouteChanged(name);
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
// Write path (buffer + worker thread + rollups) lives in request-log.ts so
// the edge process can use it without importing this module (store runs
// migrations on open; only the control plane may do that). Re-exported here
// for existing callers.

export { logRequest, flushRequestLogs } from './request-log.ts';

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

  // ── Summary ── — SQL aggregates instead of materializing every row in JS.
  const agg = db
    .select({
      total: sql<number>`count(*)`,
      avgDuration: sql<number>`round(avg(${requestLogs.duration}))`,
      errors: sql<number>`sum(case when ${requestLogs.status} >= 400 then 1 else 0 end)`,
      s2xx: sql<number>`sum(case when ${requestLogs.status} >= 200 and ${requestLogs.status} < 300 then 1 else 0 end)`,
      s3xx: sql<number>`sum(case when ${requestLogs.status} >= 300 and ${requestLogs.status} < 400 then 1 else 0 end)`,
      s4xx: sql<number>`sum(case when ${requestLogs.status} >= 400 and ${requestLogs.status} < 500 then 1 else 0 end)`,
      s5xx: sql<number>`sum(case when ${requestLogs.status} >= 500 then 1 else 0 end)`,
      requestBytes: sql<number>`coalesce(sum(${requestLogs.requestSize}), 0)`,
      responseBytes: sql<number>`coalesce(sum(${requestLogs.responseSize}), 0)`,
    })
    .from(requestLogs)
    .where(where)
    .get();

  const summaryTotal = agg?.total ?? 0;
  const percentile = (p: number) =>
    summaryTotal === 0
      ? 0
      : (db
          .select({ duration: requestLogs.duration })
          .from(requestLogs)
          .where(where)
          .orderBy(requestLogs.duration)
          .limit(1)
          .offset(Math.min(Math.floor(summaryTotal * p), summaryTotal - 1))
          .get()?.duration ?? 0);

  const statusCodes: Record<string, number> = {};
  if (agg?.s2xx) statusCodes['2xx'] = agg.s2xx;
  if (agg?.s3xx) statusCodes['3xx'] = agg.s3xx;
  if (agg?.s4xx) statusCodes['4xx'] = agg.s4xx;
  if (agg?.s5xx) statusCodes['5xx'] = agg.s5xx;

  const summary = {
    totalRequests: summaryTotal,
    avgDuration: summaryTotal ? agg!.avgDuration || 0 : 0,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    errorRate: summaryTotal ? Math.round(((agg!.errors || 0) / summaryTotal) * 100) : 0,
    statusCodes,
    totalRequestBytes: agg?.requestBytes ?? 0,
    totalResponseBytes: agg?.responseBytes ?? 0,
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

  // Reads the 1-minute rollup table instead of raw request_logs — the fleet
  // series spans every deployment over up to months, which used to scan the
  // raw table. pickBucketMs always returns a multiple of 60s, so rollup
  // buckets re-bucket cleanly.
  const bucketExpr = sql`CAST(${requestLogs1m.bucketMs} / ${bucketMs} AS INTEGER) * ${bucketMs}`;
  const rows = db
    .select({
      bucket: sql<number>`${bucketExpr}`.as('bucket'),
      total: sql<number>`sum(${requestLogs1m.count})`,
      errors: sql<number>`sum(${requestLogs1m.errors5xx})`,
    })
    .from(requestLogs1m)
    .where(and(gte(requestLogs1m.bucketMs, fromMs), sql`${requestLogs1m.bucketMs} <= ${toMs}`))
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

  // Whole-minute buckets re-aggregate from the rollup table; sub-minute
  // buckets (windows under an hour) need raw rows.
  // CAST to INTEGER — parameter-bound bucketSizeMs would otherwise trigger
  // floating-point division, hashing every row to its own bucket.
  const useRollups = bucketSizeMs % 60_000 === 0;
  const rows = useRollups
    ? db
        .select({
          bucket: sql<number>`CAST(${requestLogs1m.bucketMs} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`,
          count: sql<number>`sum(${requestLogs1m.count})`,
        })
        .from(requestLogs1m)
        .where(and(eq(requestLogs1m.deploymentName, name), gte(requestLogs1m.bucketMs, since)))
        .groupBy(
          sql`CAST(${requestLogs1m.bucketMs} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`,
        )
        .orderBy(
          sql`CAST(${requestLogs1m.bucketMs} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`,
        )
        .all()
    : db
        .select({
          bucket: sql<number>`CAST(${requestLogs.timestamp} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`,
          count: sql<number>`count(*)`,
        })
        .from(requestLogs)
        .where(and(eq(requestLogs.deploymentName, name), sql`${requestLogs.timestamp} >= ${since}`))
        .groupBy(sql`CAST(${requestLogs.timestamp} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`)
        .orderBy(sql`CAST(${requestLogs.timestamp} / ${bucketSizeMs} AS INTEGER) * ${bucketSizeMs}`)
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

  // Aggregate from the 1-minute rollups (≤10k rows/app/week) instead of raw
  // request logs. strftime with 'localtime' matches the previous Date-based
  // local-timezone semantics.
  const dayExpr = sql<string>`strftime('%w', ${requestLogs1m.bucketMs} / 1000, 'unixepoch', 'localtime')`;
  const hourExpr = sql<string>`strftime('%H', ${requestLogs1m.bucketMs} / 1000, 'unixepoch', 'localtime')`;
  const rows = db
    .select({
      day: dayExpr.as('day'),
      hour: hourExpr.as('hour'),
      count: sql<number>`sum(${requestLogs1m.count})`,
    })
    .from(requestLogs1m)
    .where(and(eq(requestLogs1m.deploymentName, name), gte(requestLogs1m.bucketMs, sevenDaysAgo)))
    .groupBy(dayExpr, hourExpr)
    .all();

  // 7x24 grid: day 0=Sunday through 6=Saturday, hours 0-23
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const row of rows) {
    grid[parseInt(row.day, 10)][parseInt(row.hour, 10)] = row.count;
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
//
// Build output lives in append-only files under .deploy-data/build-logs/<id>.log,
// not in the `output` TEXT column. The old flow rewrote the entire accumulated
// string into the row every 2s during a build — O(n²) bytes written for an
// n-byte log. The column is kept for rows created before this change; read
// paths hydrate from the file when the column is empty.

const BUILD_LOGS_DIR = resolve(DATA_DIR, 'build-logs');

export function buildLogFilePath(id: number): string {
  if (!existsSync(BUILD_LOGS_DIR)) mkdirSync(BUILD_LOGS_DIR, { recursive: true });
  return resolve(BUILD_LOGS_DIR, `${id}.log`);
}

function hydrateBuildOutput<T extends { id: number; output: string }>(row: T): T {
  if (row.output) return row;
  try {
    const p = resolve(BUILD_LOGS_DIR, `${row.id}.log`);
    if (existsSync(p)) return { ...row, output: readFileSync(p, 'utf8') };
  } catch {
    // unreadable file → keep empty output
  }
  return row;
}

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

export function completeBuildLog(id: number, log: { success: boolean; duration: number }) {
  const db = getDb();
  db.update(buildLogs)
    .set({
      success: log.success,
      duration: log.duration,
      status: log.success ? 'complete' : 'failed',
    })
    .where(eq(buildLogs.id, id))
    .run();
}

export function getActiveBuildLog(deploymentName: string) {
  const db = getDb();
  const row =
    db
      .select()
      .from(buildLogs)
      .where(and(eq(buildLogs.deploymentName, deploymentName), eq(buildLogs.status, 'building')))
      .orderBy(desc(buildLogs.timestamp))
      .limit(1)
      .get() ?? null;
  return row ? hydrateBuildOutput(row) : null;
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
  return { rows: rows.map(hydrateBuildOutput), total, page, pageSize };
}

export function getLatestBuildLog(deploymentName: string) {
  const db = getDb();
  const row = db
    .select()
    .from(buildLogs)
    .where(eq(buildLogs.deploymentName, deploymentName))
    .orderBy(desc(buildLogs.timestamp))
    .limit(1)
    .get();
  return row ? hydrateBuildOutput(row) : row;
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
      .set({ status: 'failed', success: false })
      .where(eq(buildLogs.id, row.id))
      .run();
    try {
      appendFileSync(buildLogFilePath(row.id), '\n[Build interrupted — server restarted]\n');
    } catch {
      // best-effort annotation
    }
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
