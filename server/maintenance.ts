/**
 * Database maintenance tasks + periodic rsync backup
 * - Periodic VACUUM operations to reclaim disk space
 * - Data retention: prune old metrics (30 days) and request logs (90 days)
 * - Periodic rsync of .deploy-data/ to external destination (cron-scheduled)
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Cron } from 'croner';
import { getSqlite, getBackupSettings, pruneExpiredSessions } from './store.ts';
import { pruneOldCaptures } from './capture.ts';

const DATA_DIR = resolve(process.cwd(), '.deploy-data');
const VACUUM_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run incremental vacuum every 6 hours

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

// ── Data retention ──────────────────────────────────────────────────────────

const RETENTION_DAYS_METRICS = 30;
const RETENTION_DAYS_REQUESTS = 90;
// 5xx body captures are debugging artifacts, not analytics — two weeks is
// plenty, and the per-app rate limit already bounds the steady-state count.
const RETENTION_DAYS_CAPTURES = 14;
// 1-minute rollups are tiny (one row per app per active minute) — keep ~13
// months so year-over-year charts stay possible after raw rows age out.
const RETENTION_DAYS_ROLLUPS = 396;

function pruneOldData() {
  try {
    const sqlite = getSqlite();
    if (!sqlite) return;

    const metricsCutoff = Date.now() - RETENTION_DAYS_METRICS * 86_400_000;
    const requestsCutoff = Date.now() - RETENTION_DAYS_REQUESTS * 86_400_000;
    const rollupsCutoff = Date.now() - RETENTION_DAYS_ROLLUPS * 86_400_000;

    const metricsResult = sqlite
      .prepare('DELETE FROM resource_metrics WHERE timestamp < ?')
      .run(metricsCutoff);
    const requestsResult = sqlite
      .prepare('DELETE FROM request_logs WHERE timestamp < ?')
      .run(requestsCutoff);
    const rollupsResult = sqlite
      .prepare('DELETE FROM request_logs_1m WHERE bucket_ms < ?')
      .run(rollupsCutoff);

    if (metricsResult.changes > 0 || requestsResult.changes > 0 || rollupsResult.changes > 0) {
      console.log(
        `Data retention: pruned ${metricsResult.changes} metrics rows (>${RETENTION_DAYS_METRICS}d), ${requestsResult.changes} request log rows (>${RETENTION_DAYS_REQUESTS}d), ${rollupsResult.changes} rollup rows (>${RETENTION_DAYS_ROLLUPS}d)`,
      );
    }
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

// Online-backup snapshot of the live DB. rsync-ing `deploy.db` while WAL
// writers are active can copy torn pages (and we exclude the WAL, dropping
// committed-but-uncheckpointed data) — the restored copy may be corrupt or
// stale exactly when it matters. better-sqlite3's backup API produces a
// transactionally-consistent snapshot file; we ship that instead and exclude
// the live DB files from the rsync.
const DB_SNAPSHOT_NAME = 'deploy.db.snapshot';

async function snapshotDatabase(): Promise<void> {
  const sqlite = getSqlite();
  if (!sqlite) throw new Error('SQLite not initialized');
  await sqlite.backup(resolve(DATA_DIR, DB_SNAPSHOT_NAME));
}

async function runRsyncBackup(): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const settings = getBackupSettings();

  if (!settings.enabled) {
    return { success: false, durationMs: 0, error: 'Backup is disabled' };
  }

  if (!settings.destination) {
    return { success: false, durationMs: 0, error: 'No destination configured' };
  }

  if (!_backupStatus.running) {
    try {
      await snapshotDatabase();
    } catch (err) {
      const msg = `DB snapshot failed: ${(err as Error).message}`;
      console.error(`rsync backup aborted: ${msg}`);
      _backupStatus = {
        lastRunAt: new Date().toISOString(),
        lastSuccess: false,
        lastDurationMs: 0,
        lastError: msg,
        running: false,
      };
      return { success: false, durationMs: 0, error: msg };
    }
  }

  return new Promise((resolvePromise) => {
    // Check if destination parent directory exists (handle unmounted volumes)
    const destParent = resolve(settings.destination, '..');
    if (!existsSync(destParent)) {
      const msg = `Destination parent does not exist: ${destParent} (volume may not be mounted)`;
      console.warn(`rsync backup skipped: ${msg}`);
      _backupStatus = {
        lastRunAt: new Date().toISOString(),
        lastSuccess: false,
        lastDurationMs: 0,
        lastError: msg,
        running: false,
      };
      resolvePromise({ success: false, durationMs: 0, error: msg });
      return;
    }

    if (_backupStatus.running) {
      resolvePromise({ success: false, durationMs: 0, error: 'Backup already in progress' });
      return;
    }

    _backupStatus.running = true;
    const start = Date.now();

    // Trailing slash on source is important: copies CONTENTS of src into dest
    const source = DATA_DIR.endsWith('/') ? DATA_DIR : DATA_DIR + '/';
    const dest = settings.destination.endsWith('/')
      ? settings.destination
      : settings.destination + '/';

    console.log(`Starting rsync backup: ${source} -> ${dest}`);

    const proc = spawn(
      'rsync',
      [
        '-a', // archive mode
        '--delete', // mirror deletions
        // The live DB files are excluded — deploy.db.snapshot (written just
        // above by the online backup API) is the consistent copy we ship.
        '--exclude',
        'deploy.db',
        '--exclude',
        'deploy.db-wal',
        '--exclude',
        'deploy.db-shm',
        source,
        dest,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      const durationMs = Date.now() - start;
      const errorMsg = `rsync spawn error: ${err.message}`;
      console.error(errorMsg);
      _backupStatus = {
        lastRunAt: new Date().toISOString(),
        lastSuccess: false,
        lastDurationMs: durationMs,
        lastError: errorMsg,
        running: false,
      };
      resolvePromise({ success: false, durationMs, error: errorMsg });
    });

    proc.on('close', (code) => {
      const durationMs = Date.now() - start;
      const success = code === 0;

      if (success) {
        console.log(`rsync backup completed in ${durationMs}ms`);
      } else {
        console.error(`rsync backup failed (exit code ${code}): ${stderr}`);
      }

      _backupStatus = {
        lastRunAt: new Date().toISOString(),
        lastSuccess: success,
        lastDurationMs: durationMs,
        lastError: success ? null : stderr.trim() || `Exit code ${code}`,
        running: false,
      };

      resolvePromise({
        success,
        durationMs,
        error: success ? undefined : stderr.trim() || `Exit code ${code}`,
      });
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Starts periodic maintenance tasks
 * - VACUUM every 6 hours to reclaim disk space
 * - rsync backup on cron schedule (if enabled)
 */
export function startMaintenance() {
  console.log('Starting database maintenance - incremental vacuum and data retention every 6h');

  // Don't run on startup — both pruneOldData and incremental_vacuum hold write
  // locks. Restart-loops shouldn't repeatedly hit the DB hard. First scheduled
  // tick runs 6h after boot, which is what `setInterval` does for us.
  setInterval(() => {
    pruneOldData();
    const pruned = pruneExpiredSessions();
    if (pruned > 0) console.log(`Session pruning: removed ${pruned} expired sessions`);
    runIncrementalVacuum();
    pruneOldCaptures(RETENTION_DAYS_CAPTURES * 86_400_000)
      .then((n) => {
        if (n > 0)
          console.log(`Capture pruning: removed ${n} 5xx captures (>${RETENTION_DAYS_CAPTURES}d)`);
      })
      .catch((err) => console.error('Capture pruning failed:', err));
  }, VACUUM_INTERVAL_MS);

  // Schedule rsync backup based on saved settings
  scheduleBackupCron();
}

/**
 * Export for manual maintenance operations and backup management
 */
export const maintenance = {
  vacuum: runIncrementalVacuum,
  runBackup: runRsyncBackup,
  rescheduleBackup: scheduleBackupCron,
  getBackupStatus: (): BackupStatus => ({ ..._backupStatus }),
};
