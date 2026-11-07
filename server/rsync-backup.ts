/**
 * The parts of the whole-directory rsync backup that decide what is safe: where it may write, what
 * it copies, and what a result means. server/maintenance.ts runs it; scripts/restore-backup.mjs and
 * README.md are the way back.
 */
import { existsSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { packageWorkerFile } from './packages/worker-file.ts';

export const BACKUP_DATABASES = ['deploy.db', 'requests.db', 'workspace/workspace.db'];
/** The owner creates this once on the drive. A mount point with no drive on it doesn't have it. */
export const DESTINATION_MARKER = '.deploy-backup-destination';
/** Removed when a copy starts and written when it finishes, so a copy cut short can be told. */
export const COMPLETE_MARKER = '.deploy-backup-complete';

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);
const inside = (parent: string, path: string) => {
  const step = relative(parent, path);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
};

/** Why nothing may be written to this destination, or null when it is the owner's backup drive. */
export function destinationProblem(root: string, destination: string): string | null {
  if (!isAbsolute(destination))
    return `Backup destination must be an absolute path on this computer: ${destination}`;
  const target = resolve(destination);
  if (inside(resolve(root), target) || inside(target, resolve(root)))
    return `Backup destination ${target} overlaps the data directory ${resolve(root)}. Nothing was written.`;
  if (!existsSync(target))
    return `Backup destination ${target} does not exist. If it is on a drive, the drive is not mounted. Nothing was written.`;
  const marker = join(target, DESTINATION_MARKER);
  if (!existsSync(marker))
    return `Backup destination ${target} has no ${DESTINATION_MARKER} file, so it may be an empty mount point on this computer's own disk. Nothing was written. If the drive is not mounted, mount it. If this is the backup drive, mark it once: touch "${marker}"`;
  return null;
}

/** Room each snapshot could take: the database and its WAL, with space for writes during the copy. */
export function snapshotBytesNeeded(root: string): number {
  const bytes = BACKUP_DATABASES.reduce(
    (sum, file) => sum + sizeOf(resolve(root, file)) + sizeOf(resolve(root, `${file}-wal`)),
    0,
  );
  return bytes + Math.max(256 * 1024 ** 2, bytes / 10);
}

export function assertRoomForSnapshots(
  root: string,
  freeBytes = (path: string) => {
    const disk = statfsSync(path);
    return disk.bavail * disk.bsize;
  },
): void {
  const needed = snapshotBytesNeeded(root);
  const free = freeBytes(root);
  if (free < needed)
    throw new Error(
      `Database snapshots need ${gigabytes(needed)} free on the data disk at ${resolve(root)}, and it has ${gigabytes(free)}. Nothing was copied.`,
    );
}

export const snapshotPath = (root: string, file: string) => resolve(root, `${file}.snapshot`);

export function removeSnapshots(root: string): void {
  for (const file of BACKUP_DATABASES) {
    rmSync(snapshotPath(root, file), { force: true });
    rmSync(`${snapshotPath(root, file)}.tmp`, { force: true });
  }
}

/** Writes `<database>.snapshot` beside each live database, off the calling thread. */
export function snapshotDatabases(root: string): Promise<void> {
  const worker = new Worker(
    packageWorkerFile(import.meta.url, 'backup-snapshot-worker.js', './backup-snapshot-worker.ts'),
    {
      workerData: {
        databases: BACKUP_DATABASES.map((file) => ({
          source: resolve(root, file),
          target: snapshotPath(root, file),
        })),
      },
    },
  );
  return new Promise((resolvePromise, reject) => {
    worker.once('message', (value) =>
      value.error ? reject(new Error(value.error)) : resolvePromise(),
    );
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code) reject(new Error(`The snapshot worker exited with code ${code}`));
    });
  });
}

export function rsyncArguments(root: string, destination: string): string[] {
  // Rules start at the data directory. Unanchored, `requests.db` also dropped any app's own file of
  // that name, and only the two root databases were listed, so workspace.db was copied live.
  const excluded = [
    // Only on the drive. Excluded so --delete leaves them there.
    DESTINATION_MARKER,
    COMPLETE_MARKER,
    // Live databases: the *.snapshot files stand in for them.
    ...BACKUP_DATABASES.flatMap((file) => [
      file,
      `${file}-wal`,
      `${file}-shm`,
      `${file}.snapshot.tmp`,
    ]),
    // Sockets mean nothing in a copy.
    'edge.sock',
    'supervisor.sock',
    'coordinator-updates/switch.sock',
    // Hosted packages are durable data; the refetchable copy and incomplete writes are not.
    'packages/cache/',
    'packages/tmp/',
  ];
  return [
    '-a',
    '--numeric-ids',
    '--delete',
    ...excluded.flatMap((path) => ['--exclude', `/${path}`]),
    `${resolve(root)}/`,
    `${resolve(destination)}/`,
  ];
}

/**
 * What an rsync exit means, as the error to report or null for a usable copy. Exit 24 is files that
 * vanished while being copied, which a running server always has: temp files, finished task output.
 */
export function rsyncFailure(code: number | null, stderr: string, destination: string) {
  if (code === 0 || code === 24) return null;
  if (/no space left/i.test(stderr))
    return `Backup destination ${destination} ran out of space, so this copy is incomplete. ${stderr.trim()}`;
  return stderr.trim() || `rsync exit code ${code}`;
}

export function markCopyStarted(destination: string): void {
  rmSync(join(destination, COMPLETE_MARKER), { force: true });
}

export function markCopyComplete(root: string, destination: string): void {
  writeFileSync(
    join(destination, COMPLETE_MARKER),
    `${JSON.stringify({ finishedAt: new Date().toISOString(), dataDirectory: resolve(root) })}\n`,
    { mode: 0o600 },
  );
}
