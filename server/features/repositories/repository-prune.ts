// After a push rewrites history (a force push, a reset, a filter-repo, a deleted branch or tag),
// prune the hosted repository so the old history actually leaves the disk, Git LFS files
// included. It runs on the server whatever carried the push, SSH or HTTP.
//
// Git objects go through reflog expiry and `git gc --prune=now`; a Git LFS object is deleted when
// no LFS pointer reachable from any ref names it. Every ref counts, refs/deploy included: tasks,
// checkpoints and design reviews keep what they point at.
import { execFile } from 'node:child_process';
import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitEnvironment } from '../../kernel/git.ts';
import { remove } from '../../workspace/store.ts';
import {
  gitLines,
  lfsObjects,
  pointerOid,
  reachableObjects,
  readBlobs,
  remeasureRepositoryStorage,
} from './repository-storage.ts';

export const pruneSettings = {
  /**
   * LFS objects written this recently are kept even when nothing points at them: Git LFS uploads
   * a push's objects before the push updates its refs. A prune that kept some runs again once
   * they are this old.
   */
  graceMs: 60 * 60 * 1000,
  /** Wait this long after a rewriting push, so a burst of force pushes prunes once. */
  delayMs: 30 * 1000,
  log: (message: string) => console.error(message),
};

export type PruneResult = {
  git: { before: number; after: number };
  lfs: {
    removed: number;
    removedBytes: number;
    kept: number;
    keptBytes: number;
    /** Unreferenced, but written within the grace period, so kept for now. */
    recent: number;
    recentBytes: number;
  };
};
type Project = { id: string; repositoryPath: string };

const running = new Map<string, Promise<PruneResult>>();
const scheduled = new Map<string, NodeJS.Timeout>();
const background = new Set<Promise<unknown>>();
const track = <T>(work: Promise<T>) => {
  background.add(work);
  void work.catch(() => {}).finally(() => background.delete(work));
  return work;
};
/** Resolves once every prune and the storage measurements they started have finished. */
export async function pruneSettled() {
  while (running.size || background.size)
    await Promise.allSettled([...running.values(), ...background]);
}

/** LFS object ids named by pointers reachable from any ref. */
async function referencedLfs(repository: string) {
  const candidates = new Set<string>();
  await reachableObjects(repository, ['--all'], (object) => {
    // An LFS pointer is a small text blob (the spec keeps it under 1024 bytes).
    if (object.type === 'blob' && object.size >= 100 && object.size < 1024)
      candidates.add(object.oid);
  });
  const oids = new Set<string>();
  await readBlobs(repository, [...candidates], (_blob, text) => {
    const oid = pointerOid(text);
    if (oid) oids.add(oid);
  });
  return oids;
}

async function objectBytes(repository: string) {
  let bytes = 0;
  await gitLines(repository, ['count-objects', '-v'], (line) => {
    const [key, value] = line.split(': ');
    if (key === 'size' || key === 'size-pack' || key === 'size-garbage')
      bytes += Number(value) * 1024;
  });
  return bytes;
}

/** Interrupted uploads (`<oid>.<id>.upload`) older than the grace period, and emptied folders. */
async function tidyLfsFolders(repository: string, olderThan: number) {
  const base = join(repository, 'lfs', 'objects');
  for (const first of await readdir(base).catch(() => [] as string[])) {
    for (const second of await readdir(join(base, first)).catch(() => [] as string[])) {
      const folder = join(base, first, second);
      for (const name of await readdir(folder).catch(() => [] as string[]))
        if (name.endsWith('.upload')) {
          const info = await stat(join(folder, name)).catch(() => null);
          if (info && info.mtimeMs < olderThan) await rm(join(folder, name), { force: true });
        }
      await rmdir(folder).catch(() => {});
    }
    await rmdir(join(base, first)).catch(() => {});
  }
}

async function prune(owner: string, project: Project): Promise<PruneResult> {
  const repository = project.repositoryPath;
  const result: PruneResult = {
    git: { before: await objectBytes(repository), after: 0 },
    lfs: { removed: 0, removedBytes: 0, kept: 0, keptBytes: 0, recent: 0, recentBytes: 0 },
  };
  // Read before anything is deleted: a failure here stops the prune with nothing removed.
  const referenced = await referencedLfs(repository);
  const olderThan = Date.now() - pruneSettings.graceMs;
  for (const object of await lfsObjects(repository)) {
    if (referenced.has(object.oid)) {
      result.lfs.kept++;
      result.lfs.keptBytes += object.bytes;
    } else if (Date.parse(object.modifiedAt) >= olderThan) {
      result.lfs.recent++;
      result.lfs.recentBytes += object.bytes;
    } else {
      const { oid } = object;
      await rm(join(repository, 'lfs', 'objects', oid.slice(0, 2), oid.slice(2, 4), oid), {
        force: true,
      });
      try {
        remove('lfs-object', owner, project.id + ':' + oid);
      } catch {
        // No record (an object copied in by hand): the file was all there was.
      }
      result.lfs.removed++;
      result.lfs.removedBytes += object.bytes;
    }
  }
  await tidyLfsFolders(repository, olderThan);
  await gitLines(
    repository,
    ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'],
    () => {},
  );
  await gitLines(repository, ['-c', 'gc.auto=0', 'gc', '--prune=now', '--quiet'], () => {});
  result.git.after = await objectBytes(repository);
  // Refs did not move, so the Storage summary would not notice on its own.
  track(remeasureRepositoryStorage(owner, project.id));
  return result;
}

/** Prune now. One prune per repository at a time; a second waits for the first to finish. */
export function pruneRepository(owner: string, project: Project) {
  const key = `${owner}:${project.id}`;
  const earlier = running.get(key) ?? Promise.resolve(null);
  const work: Promise<PruneResult> = earlier
    .catch(() => null)
    .then(() => prune(owner, project))
    .finally(() => {
      if (running.get(key) === work) running.delete(key);
    });
  running.set(key, work);
  return work;
}

const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Prune after `delayMs`, again after the grace period if it kept recent LFS uploads. */
export function schedulePrune(owner: string, project: Project, delayMs = pruneSettings.delayMs) {
  const key = `${owner}:${project.id}`;
  clearTimeout(scheduled.get(key));
  const timer = setTimeout(() => {
    scheduled.delete(key);
    track(
      pruneRepository(owner, project).then(
        (result) => {
          pruneSettings.log(
            `[git] Pruned ${project.id}: Git ${MB(result.git.before)} → ${MB(result.git.after)}, ` +
              `${result.lfs.removed} LFS files removed (${MB(result.lfs.removedBytes)})`,
          );
          if (result.lfs.recent) schedulePrune(owner, project, pruneSettings.graceMs);
        },
        (error) => pruneSettings.log(`[git] Prune of ${project.id} failed: ${error?.message}`),
      ),
    );
  }, delayMs);
  timer.unref();
  scheduled.set(key, timer);
}

/** True while a prune is waiting to run for the project. */
export function pruneScheduled(owner: string, projectId: string) {
  return scheduled.has(`${owner}:${projectId}`);
}

const ZERO = /^0+$/;
/** Exit code of `git merge-base --is-ancestor`: 0 yes, 1 no, anything else unknown. */
function isAncestor(repository: string, older: string, newer: string) {
  return new Promise<number>((resolve) => {
    execFile(
      'git',
      ['-C', repository, 'merge-base', '--is-ancestor', older, newer],
      { env: gitEnvironment() },
      (error) => resolve(error ? (typeof error.code === 'number' ? error.code : 128) : 0),
    );
  });
}

/**
 * Called after every accepted push: when one of its updates deleted a branch or tag or moved it
 * to a commit that does not contain the old one, schedule a prune.
 */
export async function pruneIfRewritten(
  owner: string,
  project: Project,
  updates: { ref: string; commit: string; previousCommit: string }[],
) {
  for (const update of updates) {
    if (ZERO.test(update.previousCommit)) continue; // A new ref leaves nothing behind.
    if (
      ZERO.test(update.commit) ||
      (await isAncestor(project.repositoryPath, update.previousCommit, update.commit)) !== 0
    )
      return void schedulePrune(owner, project);
  }
}
