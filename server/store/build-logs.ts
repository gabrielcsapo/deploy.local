import { resolve } from 'node:path';
import { DATA_DIR, getDb } from './connection.ts';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { buildLogs, deployments } from '../schema.ts';
import { eq, and, desc, sql } from 'drizzle-orm';

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

async function hydrateBuildOutputAsync<T extends { id: number; output: string }>(
  row: T,
): Promise<T> {
  if (row.output) return row;
  try {
    const p = resolve(BUILD_LOGS_DIR, `${row.id}.log`);
    if (existsSync(p)) return { ...row, output: await readFile(p, 'utf8') };
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

export async function getActiveBuildLog(deploymentName: string) {
  const db = getDb();
  const row =
    db
      .select()
      .from(buildLogs)
      .where(and(eq(buildLogs.deploymentName, deploymentName), eq(buildLogs.status, 'building')))
      .orderBy(desc(buildLogs.timestamp))
      .limit(1)
      .get() ?? null;
  return row ? hydrateBuildOutputAsync(row) : null;
}

export async function getBuildLogs(deploymentName: string, page = 1, pageSize = 20) {
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
  return { rows: await Promise.all(rows.map(hydrateBuildOutputAsync)), total, page, pageSize };
}

/** Read an exact deployment attempt without hydrating its potentially large output. */
export function getBuildLogResult(deploymentName: string, id: number) {
  return getDb()
    .select({ id: buildLogs.id, status: buildLogs.status })
    .from(buildLogs)
    .where(and(eq(buildLogs.id, id), eq(buildLogs.deploymentName, deploymentName)))
    .get();
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
    .where(
      sql`${deployments.status} IN ('building', 'starting', 'uploading', 'backing-up', 'restoring')`,
    )
    .run();
}
