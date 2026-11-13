import { openDatabase } from '../kernel/db/sqlite.ts';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  statSync,
  statfsSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { withWorkspaceDatabaseGate } from '../kernel/db/database-open.ts';

/** Fail closed if open-file inspection is unavailable or incomplete. Stop the service first. */
function assertDatabaseClosed(file: string) {
  const paths = [file, `${file}-wal`, `${file}-shm`].filter(existsSync);
  try {
    const pids = execFileSync('lsof', ['-t', '--', ...paths], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (pids)
      throw new Error(`Workspace database is open in processes: ${pids.replaceAll('\n', ', ')}`);
  } catch (error: any) {
    if (
      error.status === 1 &&
      !String(error.stdout || '').trim() &&
      !String(error.stderr || '').trim()
    )
      return;
    throw error;
  }
}

/** Only run in a worker, during a stopped-server maintenance window. Never retries an attempt. */
export function convertWorkspaceDatabase(
  file: string,
  freeBytes = () => {
    const disk = statfsSync(file);
    return disk.bavail * disk.bsize;
  },
) {
  return withWorkspaceDatabaseGate(file, () => {
    const attempt = `${file}.incremental-vacuum-attempt.json`;
    if (existsSync(attempt)) return { status: 'already-attempted' };
    const record = (status: string, error?: string) =>
      JSON.stringify({ status, at: new Date().toISOString(), error }, null, 2) + '\n';
    const receipt = openSync(attempt, 'wx', 0o600);
    try {
      writeFileSync(receipt, record('started'));
      fsyncSync(receipt);
    } finally {
      closeSync(receipt);
    }
    try {
      assertDatabaseClosed(file);
      const walBytes = existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0;
      if (freeBytes() < 2 * (statSync(file).size + walBytes))
        throw new Error(
          'Workspace conversion requires free disk space of at least twice the database file size',
        );
      const db = openDatabase(file, { fileMustExist: true });
      try {
        if (db.pragma('auto_vacuum', { simple: true }) === 2) {
          writeFileSync(attempt, record('already-incremental'));
          return { status: 'already-incremental' };
        }
        db.pragma('busy_timeout = 5000');
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.pragma('auto_vacuum = INCREMENTAL');
        db.exec('VACUUM');
        if (db.pragma('auto_vacuum', { simple: true }) !== 2)
          throw new Error('Workspace auto_vacuum conversion did not persist');
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      writeFileSync(attempt, record('complete'));
      return { status: 'complete' };
    } catch (error) {
      writeFileSync(attempt, record('failed', String(error)));
      throw error;
    }
  });
}
