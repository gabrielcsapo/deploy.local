import { pruneDeploymentData } from './data-retention.ts';
import { finalizeReleases } from './telemetry.ts';
import { db as workspaceDb } from './workspace/store.ts';
import { pruneHealthEvents } from './workspace/health-event-retention.ts';
import {
  getRequestsSqlite,
  vacuumRequests,
  pruneRequests,
  REQUEST_RETENTION_DAYS,
  ROLLUP_RETENTION_DAYS,
} from './requests-db.ts';
import { legacyUpdateProtected } from './legacy-docker-update.ts';
/**
 * Database maintenance tasks + periodic rsync backup
 * - Periodic VACUUM operations to reclaim disk space
 * - Data retention: prune old metrics (30 days) and request logs (90 days)
 * - Periodic rsync of .deploy-data/ to external destination (cron-scheduled)
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { Cron } from 'croner';
import {
  getSqlite,
  getBackupSettings,
  pruneExpiredSessions,
  getAllDeployments,
  enqueueAgentJob,
  getAgentJob,
  getNode,
  saveBackup,
  getSystemSetting,
  setSystemSetting,
} from './store.ts';
import { pruneOldCaptures } from './capture.ts';
import { createCoordinatorApplicationBackup } from './application-backups.ts';
import { deployDataDirectory } from './data-directory.ts';
import { startRecoveryBoundaryScheduler } from './recovery-bundle-scheduler.ts';
import {
  assertRoomForSnapshots,
  destinationProblem,
  markCopyComplete,
  assertDestinationHardLinks,
  assertRoomForCopy,
  copyBytesNeeded,
  createCopyDirectory,
  listBackupCopies,
  pruneBackupCopies,
  removeSnapshots,
  rsyncArguments,
  rsyncFailure,
  snapshotDatabases,
} from './rsync-backup.ts';

const DATA_DIR = deployDataDirectory();
const VACUUM_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run incremental vacuum every 6 hours
const MAINTENANCE_FIRST_CHECK_MS = 5 * 60 * 1000;
const MAINTENANCE_CHECK_MS = 15 * 60 * 1000;
const MAINTENANCE_LAST_RUN_KEY = 'maintenance_last_run_at';

// Bound the incremental_vacuum call so a backlog of free pages can't lock the
// DB for multiple seconds. 1024 pages × 4 KB default page size = 4 MB freed per
// pass, which completes in milliseconds even on slow disks. Pages beyond this
// are reclaimed on the next scheduled run.
const INCREMENTAL_VACUUM_PAGES = 1024;

// ── Backup state ─────────────────────────────────────────────────────────────

export interface BackupStatus {
  lastRunAt: string | null;
  lastSuccess: boolean | null;
  lastDurationMs: number | null;
  lastError: string | null;
  running: boolean;
}

let _backupStatus: BackupStatus = {
  lastRunAt: null,
  lastSuccess: null,
  lastDurationMs: null,
  lastError: null,
  running: false,
};

let _backupJob: Cron | null = null;
let _recoveryBoundaryScheduler: { stop(): void } | null = null;

// ── Data retention ──────────────────────────────────────────────────────────

const RETENTION_DAYS_METRICS = 30;
const RETENTION_DAYS_REQUESTS = REQUEST_RETENTION_DAYS;
// 5xx body captures are debugging artifacts, not analytics — two weeks is
// plenty, and the per-app rate limit already bounds the steady-state count.
const RETENTION_DAYS_CAPTURES = 14;
// 1-minute rollups are tiny (one row per app per active minute) — keep ~13
// months so year-over-year charts stay possible after raw rows age out.
const RETENTION_DAYS_ROLLUPS = ROLLUP_RETENTION_DAYS;

async function pruneOldData() {
  try {
    const sqlite = getSqlite();
    if (!sqlite) return;

    const metricsCutoff = Date.now() - RETENTION_DAYS_METRICS * 86_400_000;

    const metricsResult = sqlite
      .prepare('DELETE FROM resource_metrics WHERE timestamp < ?')
      .run(metricsCutoff);
    const pruned = pruneRequests();
    finalizeReleases(getRequestsSqlite());
    const requestsResult = { changes: pruned.requests };
    const rollupsResult = { changes: pruned.rollups };

    if (metricsResult.changes > 0 || requestsResult.changes > 0 || rollupsResult.changes > 0) {
      console.log(
        `Data retention: pruned ${metricsResult.changes} metrics rows (>${RETENTION_DAYS_METRICS}d), ${requestsResult.changes} request log rows (>${RETENTION_DAYS_REQUESTS}d), ${rollupsResult.changes} rollup rows (>${RETENTION_DAYS_ROLLUPS}d)`,
      );
    }
    await pruneDeploymentData(sqlite);
  } catch (err) {
    console.error('Data retention pruning failed:', err);
  }
}

// ── VACUUM ───────────────────────────────────────────────────────────────────

// Incremental vacuum reclaims free pages without rewriting the entire DB.
// `PRAGMA auto_vacuum = INCREMENTAL` (set on DB open in store.ts) marks pages
// as freelist; `PRAGMA incremental_vacuum(N)` returns up to N of them to the
// filesystem. Each call typically takes <50ms vs full VACUUM which holds an
// exclusive lock for the entire DB rewrite (multi-seconds on large DBs).
function runIncrementalVacuum() {
  try {
    const sqlite = getSqlite();
    if (!sqlite) {
      console.warn('SQLite not initialized, skipping vacuum');
      return;
    }

    const start = Date.now();
    sqlite.prepare(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`).run();
    vacuumRequests(getRequestsSqlite(), INCREMENTAL_VACUUM_PAGES);
    workspaceDb.prepare(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`).run();
    const duration = Date.now() - start;
    if (duration > 100) {
      // Only log when slow — routine runs shouldn't spam the log
      console.log(`Database incremental_vacuum completed in ${duration}ms`);
    }
  } catch (err) {
    console.error('incremental_vacuum failed:', err);
  }
}

// ── rsync backup ─────────────────────────────────────────────────────────────

// Online-backup snapshots of the live databases. rsync-ing a live database can
// copy torn pages and lose whatever is still in its WAL, so the copy carries
// consistent `<database>.snapshot` files instead and excludes the live ones. They
// sit on the data disk only for the length of a backup. README.md and
// scripts/restore-backup.mjs turn them back into databases.
export async function snapshotDatabase(root = DATA_DIR): Promise<void> {
  if (!getSqlite()) throw new Error('SQLite not initialized');
  getRequestsSqlite();
  removeSnapshots(root);
  assertRoomForSnapshots(root);
  await snapshotDatabases(root);
}

async function waitForBackupJob(jobId: string, nodeName: string) {
  const deadline = Date.now() + 10 * 60_000;
  let job = getAgentJob(jobId);
  while (job && job.status !== 'complete' && job.status !== 'failed' && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 750));
    job = getAgentJob(jobId);
  }
  if (!job || (job.status !== 'complete' && job.status !== 'failed')) {
    throw new Error(`Timed out waiting for ${nodeName}`);
  }
  if (job.status === 'failed') throw new Error(job.error || `Backup failed on ${nodeName}`);
}

/**
 * Pull managed-volume snapshots from every app that opted into auto backup.
 * Remote agents stream archives into the coordinator's normal backups tree,
 * so the existing whole-.deploy-data rsync remains the off-machine copy.
 */
async function runFleetApplicationBackups() {
  const deployments = getAllDeployments().filter(
    (deployment) => deployment.autoBackup && !legacyUpdateProtected(deployment.name),
  );
  for (const deployment of deployments) {
    try {
      if (deployment.activeNodeId && deployment.activeNodeId !== 'coordinator') {
        const node = getNode(deployment.activeNodeId);
        if (!node?.online) {
          throw new Error('deployment node is offline');
        }
        const job = enqueueAgentJob({
          nodeId: node.id,
          type: 'backup',
          deploymentName: deployment.name,
          payload: {
            label: 'scheduled',
            createdBy: 'scheduler',
            relatedBuildLogId: deployment.currentBuildLogId ?? null,
            auto: true,
          },
        });
        await waitForBackupJob(job.id, node.name);
        continue;
      }

      const backup = await createCoordinatorApplicationBackup(deployment, 'scheduled');
      saveBackup({
        deploymentName: deployment.name,
        filename: backup.filename,
        label: 'scheduled',
        sizeBytes: backup.sizeBytes,
        createdBy: 'scheduler',
        createdAt: backup.timestamp,
        volumePaths: backup.volumePaths,
        relatedBuildLogId: deployment.currentBuildLogId ?? null,
        auto: true,
      });
    } catch (err) {
      // One offline node must not prevent the coordinator DB and the other
      // applications from reaching the external backup destination.
      console.error(`Scheduled backup failed for ${deployment.name}:`, err);
    }
  }
}

type BackupResult = { success: boolean; durationMs: number; error?: string };

async function runRsyncBackup(): Promise<BackupResult> {
  const settings = getBackupSettings();

  if (!settings.enabled) {
    return { success: false, durationMs: 0, error: 'Backup is disabled' };
  }

  if (!settings.destination) {
    return { success: false, durationMs: 0, error: 'No destination configured' };
  }

  if (_backupStatus.running) {
    return { success: false, durationMs: 0, error: 'Backup already in progress' };
  }

  _backupStatus.running = true;
  const start = Date.now();
  const finish = (error?: string): BackupResult => {
    const durationMs = Date.now() - start;
    if (error) console.error(`rsync backup failed: ${error}`);
    else console.log(`rsync backup completed in ${durationMs}ms`);
    _backupStatus = {
      lastRunAt: new Date().toISOString(),
      lastSuccess: !error,
      lastDurationMs: durationMs,
      lastError: error ?? null,
      running: false,
    };
    return { success: !error, durationMs, error };
  };

  // Before any work, so a drive that isn't attached costs nothing and writes nothing.
  const problem = destinationProblem(DATA_DIR, settings.destination);
  if (problem) return finish(problem);

  try {
    await assertDestinationHardLinks(settings.destination);
    await runFleetApplicationBackups();
    await snapshotDatabase();
    // The steps above can take minutes, and a drive can go away during them.
    const stillThere = destinationProblem(DATA_DIR, settings.destination);
    if (stillThere) return finish(stillThere);
    const previous = (await listBackupCopies(settings.destination)).find(
      (copy) => copy.complete,
    )?.path;
    if (previous && (await stat(previous)).dev !== (await stat(settings.destination)).dev) {
      console.error(
        `Backup reference ${previous} is on a different filesystem from ${settings.destination}; hard links require the same filesystem.`,
      );
      throw new Error(
        `Backup destination ${settings.destination} can't make hard links, so it can't keep dated copies. Nothing was written. Format the drive as ext4.`,
      );
    }
    const needed = await copyBytesNeeded(DATA_DIR, previous);
    await assertRoomForCopy(settings.destination, needed);
    const copy = await createCopyDirectory(settings.destination);
    const error = await copyToDestination(copy, previous);
    if (error) return finish(error);
    await markCopyComplete(DATA_DIR, copy);
    // A retention failure cannot turn a successfully published copy into an incomplete one.
    try {
      await pruneBackupCopies(settings.destination);
    } catch (err) {
      console.error(`Backup completed, but retention could not finish: ${(err as Error).message}`);
    }
    return finish();
  } catch (err) {
    return finish((err as Error).message);
  } finally {
    removeSnapshots(DATA_DIR);
  }
}

function copyToDestination(destination: string, previous?: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    console.log(`Starting rsync backup: ${DATA_DIR} -> ${destination}`);
    const proc = spawn('rsync', rsyncArguments(DATA_DIR, destination, previous), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      resolvePromise(`rsync spawn error: ${err.message}`);
    });

    proc.on('close', (code) => {
      if (code === 24) console.warn(`rsync backup: files vanished during the copy: ${stderr}`);
      resolvePromise(rsyncFailure(code, stderr, destination));
    });
  });
}

/**
 * Reschedule the rsync backup cron job based on current settings.
 * Called on startup and whenever settings change.
 */
function scheduleBackupCron() {
  // Stop existing cron job
  if (_backupJob !== null) {
    _backupJob.stop();
    _backupJob = null;
  }

  const settings = getBackupSettings();

  if (!settings.enabled) {
    console.log('rsync backup is disabled');
    return;
  }

  try {
    _backupJob = new Cron(settings.cron, () => {
      runRsyncBackup().catch((err) => {
        console.error('Unexpected rsync backup error:', err);
      });
    });
    console.log(`rsync backup scheduled with cron "${settings.cron}" to ${settings.destination}`);
  } catch (err) {
    console.error(`Invalid cron expression "${settings.cron}":`, err);
  }
}

// ── Schedule ─────────────────────────────────────────────────────────────────

/** True when retention and vacuum have not run within the interval, or never, or the stored time is unusable. */
export function maintenanceDue(
  lastRunAt: string | null,
  now = Date.now(),
  intervalMs = VACUUM_INTERVAL_MS,
): boolean {
  const last = lastRunAt ? Date.parse(lastRunAt) : NaN;
  // A time in the future (a clock that was set back) must not postpone maintenance forever.
  return !Number.isFinite(last) || last > now || now - last >= intervalMs;
}

/** Retention and vacuum, when due. Returns whether it ran. */
export async function runDueMaintenance(now = Date.now()): Promise<boolean> {
  try {
    if (!maintenanceDue(getSystemSetting(MAINTENANCE_LAST_RUN_KEY), now)) return false;
    // Recorded first: a pass that crashes the process must not rerun on every restart.
    setSystemSetting(MAINTENANCE_LAST_RUN_KEY, new Date(now).toISOString());
  } catch (err) {
    console.error('Maintenance schedule check failed:', err);
    return false;
  }
  await pruneOldData();
  try {
    const pruned = pruneExpiredSessions();
    if (pruned > 0) console.log(`Session pruning: removed ${pruned} expired sessions`);
  } catch (err) {
    console.error('Session pruning failed:', err);
  }
  runIncrementalVacuum();
  pruneOldCaptures(RETENTION_DAYS_CAPTURES * 86_400_000)
    .then((n) => {
      if (n > 0)
        console.log(`Capture pruning: removed ${n} 5xx captures (>${RETENTION_DAYS_CAPTURES}d)`);
    })
    .catch((err) => console.error('Capture pruning failed:', err));
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts periodic maintenance tasks
 * - VACUUM every 6 hours to reclaim disk space
 * - rsync backup on cron schedule (if enabled)
 */
export function startMaintenance(packages?: { warm(): Promise<void>; daily(): Promise<void> }) {
  if (packages) {
    const warmTimer = setInterval(() => void packages.warm().catch(() => {}), 5000);
    warmTimer.unref();
    new Cron(
      '0 3 * * *',
      () => void packages.daily().catch(() => console.error('Package copy maintenance failed')),
    );
  }
  console.log('Starting database maintenance - incremental vacuum and data retention every 6h');

  // The schedule is kept in the database, not in this process's uptime: a server that restarts
  // more often than every 6 hours (updates, crashes) would otherwise never prune or vacuum.
  // The first check waits a few minutes so a restart loop doesn't hit the database hard, and
  // the stored time keeps a run from repeating within the interval however often it restarts.
  const first = setTimeout(runDueMaintenance, MAINTENANCE_FIRST_CHECK_MS);
  first.unref();
  const check = setInterval(runDueMaintenance, MAINTENANCE_CHECK_MS);
  check.unref();

  const comparisonTimer = setInterval(() => {
    try {
      finalizeReleases(getRequestsSqlite());
    } catch (error) {
      console.error('[telemetry] release comparisons deferred:', error);
    }
  }, 60_000);
  comparisonTimer.unref();
  // A short first delay clears legacy heartbeat backlogs soon after startup.
  // Each pass yields between bounded batches; a busy database retries next minute.
  let pruningHealth = false;
  const healthTimer = setInterval(() => {
    if (pruningHealth) return;
    pruningHealth = true;
    void pruneHealthEvents(workspaceDb)
      .catch((error) => {
        if (error.code !== 'SQLITE_BUSY') console.error('Health event retention failed:', error);
      })
      .finally(() => {
        pruningHealth = false;
      });
  }, 60_000);
  healthTimer.unref();

  // Schedule rsync backup based on saved settings
  scheduleBackupCron();
  _recoveryBoundaryScheduler?.stop();
  _recoveryBoundaryScheduler = startRecoveryBoundaryScheduler();
}

/**
 * Export for manual maintenance operations and backup management
 */
export const maintenance = {
  runBackup: runRsyncBackup,
};
