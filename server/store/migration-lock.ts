/**
 * One migrator at a time, across processes and threads.
 *
 * Control, the two workspace workers and the server-action thread each open the database, and
 * the supervisor starts them in the same tick. Drizzle's migrator reads the last applied
 * migration before it opens its transaction, so two of them can both find the same migrations
 * pending: the second then fails on `CREATE TABLE`, or silently repeats a data migration that
 * has no such guard. Whoever holds this lock migrates; the rest wait and then find nothing to do.
 *
 * The lock is a directory beside the database (mkdir is atomic) holding the owner's pid, so a
 * lock left by a process that died is recognised and taken over.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WAIT_MS = 5 * 60_000;
// A lock directory whose pid file never appeared: its owner died between the two writes.
const UNOWNED_GRACE_MS = 10_000;

function ownerGone(lock: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(join(lock, 'pid'), 'utf8'));
  } catch {
    try {
      return Date.now() - statSync(lock).mtimeMs > UNOWNED_GRACE_MS;
    } catch {
      return false; // released meanwhile; the next attempt takes it
    }
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export function withMigrationLock<T>(databaseFile: string, migrate: () => T, waitMs = WAIT_MS): T {
  const lock = `${databaseFile}.migrating`;
  const deadline = Date.now() + waitMs;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (ownerGone(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline)
      throw new Error(`Another process has been migrating ${databaseFile} for too long (${lock})`);
    Atomics.wait(pause, 0, 0, 50);
  }
  try {
    writeFileSync(join(lock, 'pid'), String(process.pid));
    return migrate();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
