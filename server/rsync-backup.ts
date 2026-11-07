/**
 * The parts of the whole-directory rsync backup that decide what is safe: where it may write, what
 * it copies, and what a result means. server/maintenance.ts runs it; scripts/restore-backup.mjs and
 * README.md are the way back.
 */
import { existsSync, realpathSync, rmSync, statSync, statfsSync } from 'node:fs';
import {
  link,
  lstat,
  mkdtemp,
  opendir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { packageWorkerFile } from './packages/worker-file.ts';

import { COMPLETE_MARKER, DESTINATION_MARKER } from '../shared/backup-copies.ts';

export const BACKUP_DATABASES = ['deploy.db', 'requests.db', 'workspace/workspace.db'];
export {
  COMPLETE_MARKER,
  DESTINATION_MARKER,
  createCopyDirectory,
  listBackupCopies,
  retainedCopyNames,
  pruneBackupCopies,
} from '../shared/backup-copies.ts';

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const sizeOf = (path: string) => (existsSync(path) ? statSync(path).size : 0);
const inside = (parent: string, path: string) => {
  const step = relative(parent, path);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
};

// Resolve existing ancestors too: an absent child under /var (or a symlink) still overlaps /private/var.
const canonicalPath = (path: string): string => {
  const absolute = resolve(path);
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(canonicalPath(dirname(absolute)), basename(absolute));
};

/** Why nothing may be written to this destination, or null when it is the owner's backup drive. */
export function destinationProblem(root: string, destination: string): string | null {
  if (!isAbsolute(destination))
    return `Backup destination must be an absolute path on this computer: ${destination}`;
  const target = canonicalPath(destination);
  root = canonicalPath(root);
  if (inside(resolve(root), target) || inside(target, resolve(root)))
    return `Backup destination ${target} overlaps the data directory ${resolve(root)}. Nothing was written.`;
  if (!existsSync(target))
    return `Backup destination ${target} does not exist. If it is on a drive, the drive is not mounted. Nothing was written.`;
  const marker = join(target, DESTINATION_MARKER);
  if (!existsSync(marker))
    return `Backup destination ${target} has no ${DESTINATION_MARKER} file, so it may be an empty mount point on this computer's own disk. Nothing was written. If the drive is not mounted, mount it.`;
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

export function rsyncArguments(root: string, destination: string, previous?: string): string[] {
  // Rules start at the data directory. Unanchored, `requests.db` also dropped any app's own file of
  // that name, and only the two root databases were listed, so workspace.db was copied live.
  return [
    '-a',
    '--numeric-ids',
    ...(previous ? [`--link-dest=${resolve(previous)}`] : []),
    ...BACKUP_EXCLUDED.flatMap((path) => ['--exclude', `/${path}`]),
    `${resolve(root)}/`,
    `${resolve(destination)}/`,
  ];
}

const BACKUP_EXCLUDED = [
  // Reserved backup metadata never comes from the live data directory.
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

/**
 * What an rsync exit means, as the error to report or null for a usable copy. Exit 24 is files that
 * vanished while being copied, which a running server always has: temp files, finished task output.
 */
export function rsyncFailure(code: number | null, stderr: string, destination: string) {
  if (code === 0 || code === 24) return null;
  if (/no space left/i.test(stderr)) {
    console.error(stderr.trim());
    return `Backup destination ${destination} ran out of space, so this copy is incomplete.`;
  }
  return stderr.trim() || `rsync exit code ${code}`;
}

export async function markCopyComplete(root: string, destination: string): Promise<void> {
  await writeFile(
    join(destination, `${COMPLETE_MARKER}.tmp`),
    `${JSON.stringify({ version: 1, copyName: basename(destination), finishedAt: new Date().toISOString(), dataDirectory: resolve(root) })}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await rename(join(destination, `${COMPLETE_MARKER}.tmp`), join(destination, COMPLETE_MARKER));
}

export async function assertDestinationHardLinks(
  destination: string,
  makeLink = link,
): Promise<void> {
  let probe: string | undefined;
  try {
    probe = await mkdtemp(join(destination, '.deploy-link-probe-'));
    const source = join(probe, 'source');
    const target = join(probe, 'target');
    await writeFile(source, 'hard-link probe', { mode: 0o600 });
    await makeLink(source, target);
    const sourceInfo = await stat(source);
    if (sourceInfo.ino !== (await stat(target)).ino || sourceInfo.nlink < 2)
      throw new Error('the filesystem did not create a hard link');
  } catch (error) {
    console.error(`Backup hard-link preflight at ${destination}: ${(error as Error).message}`);
    throw new Error(
      `Backup destination ${destination} can't make hard links, so it can't keep dated copies. Nothing was written. Format the drive as ext4.`,
    );
  } finally {
    if (probe) await rm(probe, { recursive: true, force: true });
  }
}

/** Budget new inodes, not the size of the live tree. Always budget all freshly rewritten snapshots. */
export async function copyBytesNeeded(root: string, previous?: string): Promise<number> {
  let bytes = 0;
  const walk = async (directory: string, prefix = '') => {
    for await (const entry of await opendir(directory)) {
      const file = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (
        BACKUP_EXCLUDED.some((excluded) =>
          excluded.endsWith('/') ? `${file}/`.startsWith(excluded) : file === excluded,
        )
      )
        continue;
      const source = join(root, file);
      if (entry.isDirectory()) {
        bytes += 4096;
        await walk(source, file);
        continue;
      }
      if (!entry.isFile()) {
        bytes += 4096;
        continue;
      }
      let info;
      try {
        info = await lstat(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let unchanged = false;
      if (previous && !BACKUP_DATABASES.some((database) => file === `${database}.snapshot`)) {
        try {
          const old = join(previous, file);
          const oldInfo = await lstat(old);
          unchanged =
            oldInfo.isFile() &&
            oldInfo.size === info.size &&
            oldInfo.mode === info.mode &&
            oldInfo.uid === info.uid &&
            oldInfo.gid === info.gid &&
            // rsync's default modify-window is zero: compare integral seconds.
            Math.floor(oldInfo.mtimeMs / 1000) === Math.floor(info.mtimeMs / 1000);
        } catch {
          /* Missing or unreadable reference: budget a full file. */
        }
      }
      if (!unchanged) bytes += Math.ceil(info.size / 4096) * 4096;
    }
  };
  await walk(root);
  // Metadata, concurrent live writes and filesystem allocation overhead; never reclaim first.
  return bytes + Math.max(256 * 1024 ** 2, Math.ceil(bytes / 10));
}

export async function assertRoomForCopy(
  destination: string,
  needed: number,
  freeBytes: (path: string) => number | Promise<number> = async (path: string) => {
    const disk = await statfs(path);
    return disk.bavail * disk.bsize;
  },
): Promise<void> {
  const free = await freeBytes(destination);
  if (free < needed) {
    console.error(
      `Backup preflight: new changed data needs ${needed} bytes (${gigabytes(needed)}) free at ${destination}; available ${free} bytes (${gigabytes(free)}). No dated copy was started and no old copy was removed.`,
    );
    throw new Error(
      `Backup destination ${destination} doesn't have room for this copy, which needs ${gigabytes(needed)}. Nothing was written.`,
    );
  }
}
