/**
 * Database maintenance tasks + periodic rsync backup
 * - Periodic VACUUM operations to reclaim disk space
 * - Periodic rsync of .deploy-data/ to external destination (cron-scheduled)
 * - All data is preserved indefinitely (no automatic cleanup)
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { Cron } from 'croner';
import { getSqlite, getBackupSettings } from './store.ts';

const DATA_DIR = resolve(process.cwd(), '.deploy-data');
const VACUUM_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run VACUUM every 6 hours

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

// ── VACUUM ───────────────────────────────────────────────────────────────────

function runVacuum() {
  try {
    const sqlite = getSqlite();
    if (!sqlite) {
      console.warn('SQLite not initialized, skipping VACUUM');
      return;
    }

    const start = Date.now();
    console.log('Starting database VACUUM...');

    sqlite.prepare('VACUUM').run();

    const duration = Date.now() - start;
    console.log(`Database VACUUM completed in ${duration}ms`);
  } catch (err) {
    console.error('VACUUM failed:', err);
  }
}

// ── rsync backup ─────────────────────────────────────────────────────────────

function runRsyncBackup(): Promise<{ success: boolean; durationMs: number; error?: string }> {
  return new Promise((resolvePromise) => {
    const settings = getBackupSettings();

    if (!settings.enabled) {
      resolvePromise({ success: false, durationMs: 0, error: 'Backup is disabled' });
      return;
    }

    if (!settings.destination) {
      resolvePromise({ success: false, durationMs: 0, error: 'No destination configured' });
      return;
    }

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
    const dest = settings.destination.endsWith('/') ? settings.destination : settings.destination + '/';

    console.log(`Starting rsync backup: ${source} -> ${dest}`);

    const proc = spawn('rsync', [
      '-a',                            // archive mode
      '--delete',                      // mirror deletions
      '--exclude', 'deploy.db-wal',    // exclude WAL (transient)
      '--exclude', 'deploy.db-shm',    // exclude SHM (transient)
      source,
      dest,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
        lastError: success ? null : (stderr.trim() || `Exit code ${code}`),
        running: false,
      };

      resolvePromise({
        success,
        durationMs,
        error: success ? undefined : (stderr.trim() || `Exit code ${code}`),
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
  console.log('Starting database maintenance - VACUUM will run every 6 hours');

  // Run VACUUM on startup
  runVacuum();

  // Schedule periodic VACUUM
  setInterval(() => {
    runVacuum();
  }, VACUUM_INTERVAL_MS);

  // Schedule rsync backup based on saved settings
  scheduleBackupCron();
}

/**
 * Export for manual maintenance operations and backup management
 */
export const maintenance = {
  vacuum: runVacuum,
  runBackup: runRsyncBackup,
  rescheduleBackup: scheduleBackupCron,
  getBackupStatus: (): BackupStatus => ({ ..._backupStatus }),
};
