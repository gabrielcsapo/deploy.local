/** Disk format shared by the backup writer and the offline restore command. No flat-layout fallback. */
import { lstat, mkdir, opendir, readFile, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const DESTINATION_MARKER = '.deploy-backup-destination';
export const COMPLETE_MARKER = '.deploy-backup-complete';
const COPY_NAME =
  /^deploy-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export interface BackupCopy {
  name: string;
  path: string;
  startedAt: Date;
  complete: boolean;
}

export async function createCopyDirectory(destination: string, now = new Date()): Promise<string> {
  const name = `deploy-backup-${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const path = join(destination, name);
  // Exclusive creation: a complete copy is never opened as a writable destination again.
  await mkdir(path, { mode: 0o700 });
  return path;
}

export async function listBackupCopies(destination: string): Promise<BackupCopy[]> {
  const copies: BackupCopy[] = [];
  for await (const entry of await opendir(destination)) {
    if (!entry.isDirectory() || !COPY_NAME.test(entry.name)) continue;
    const path = join(destination, entry.name);
    const timestamp = entry.name.slice('deploy-backup-'.length, -37);
    const iso = timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
    const startedAt = new Date(iso);
    if (!Number.isFinite(+startedAt) || startedAt.toISOString() !== iso) continue;
    let complete = false;
    try {
      const marker = join(path, COMPLETE_MARKER);
      if ((await lstat(marker)).isFile()) {
        const metadata = JSON.parse(await readFile(marker, 'utf8'));
        complete =
          metadata.copyName === entry.name &&
          metadata.version === 1 &&
          typeof metadata.dataDirectory === 'string' &&
          typeof metadata.finishedAt === 'string' &&
          Number.isFinite(Date.parse(metadata.finishedAt));
      }
    } catch {
      // Missing or malformed markers identify an incomplete copy.
    }
    copies.push({ name: entry.name, path, startedAt, complete });
  }
  return copies.sort((a, b) => b.name.localeCompare(a.name));
}

/** Keep all runs from 24h, latest on 7 UTC dates, latest in 4 Monday-based UTC weeks, and newest. */
export function retainedCopyNames(copies: BackupCopy[], now = new Date()): Set<string> {
  const complete = copies
    .filter((copy) => copy.complete)
    .sort((a, b) => b.name.localeCompare(a.name));
  const keep = new Set<string>();
  const days = new Set<string>();
  const weeks = new Set<string>();
  for (const [index, copy] of complete.entries()) {
    const day = copy.startedAt.toISOString().slice(0, 10);
    const monday = new Date(`${day}T00:00:00Z`);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const week = monday.toISOString().slice(0, 10);
    if (index === 0 || +copy.startedAt > +now - 86400000) keep.add(copy.name);
    if (!days.has(day) && days.size < 7) {
      days.add(day);
      keep.add(copy.name);
    }
    if (!weeks.has(week) && weeks.size < 4) {
      weeks.add(week);
      keep.add(copy.name);
    }
  }
  return keep;
}

// Bound work per turn even for a single directory containing hundreds of thousands of files.
// Node's recursive rm enumerates a directory and queues its children together.
async function removeCopyTree(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) {
    await unlink(path);
    return;
  }
  for await (const entry of await opendir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await removeCopyTree(child);
    else await unlink(child);
  }
  await rmdir(path);
}

/** Call only after publishing a new complete marker. Unknown folders always stay untouched. */
export async function pruneBackupCopies(destination: string, now = new Date()): Promise<void> {
  const copies = await listBackupCopies(destination);
  const newest = copies.find((copy) => copy.complete);
  if (!newest) return;
  const keep = retainedCopyNames(copies, now);
  for (const copy of copies) {
    // Equal timestamps are also protected: UUID ordering cannot establish which run started first.
    if (copy.complete ? !keep.has(copy.name) : +copy.startedAt < +newest.startedAt)
      await removeCopyTree(copy.path);
  }
}
