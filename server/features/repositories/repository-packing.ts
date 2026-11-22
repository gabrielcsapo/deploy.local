// Keep hosted repositories quick to clone.
//
// Every push leaves one more pack, and objects that arrive loose stay loose. Git's own automatic
// gc folds them together only at 50 packs or about 6,700 loose objects, so a repository of large
// binary files could sit at dozens of packs and hundreds of megabytes of loose objects with no
// bitmap, and every clone recompressed all of it ("Compressing objects: 99%" for minutes).
//
// After a push, and on a schedule for repositories nobody pushed to, a geometric repack rolls the
// loose objects and the small packs into as few packs as needed, and writes a multi-pack index
// with a bitmap, so upload-pack sends what is already compressed instead of compressing it again.
// It never rewrites the large pack each push: that would take minutes for a repository of
// gigabytes. A prune (repository-prune.ts) repacks everything anyway, so packing waits for it.
import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { availableParallelism, setPriority } from 'node:os';
import { join } from 'node:path';
import { gitEnvironment } from '../../kernel/git.ts';
import { pruneBusy } from './repository-prune.ts';

export const packingSettings = {
  /** Wait this long after a push, so a burst of pushes packs once. */
  delayMs: 60 * 1000,
  /** Check every hosted repository this often, for repositories no push reached. */
  sweepMs: 6 * 60 * 60 * 1000,
  /** The first sweep waits for the server to settle after a start. */
  firstSweepMs: 10 * 60 * 1000,
  /** A repack of a repository of gigabytes takes minutes; this is long past that. */
  timeoutMs: 60 * 60 * 1000,
  log: (message: string) => console.error(message),
};

/**
 * Config for the upload-pack that serves a fetch or clone: send objects straight from every
 * pack the multi-pack index covers, not only from one.
 */
export const uploadPackConfig = ['-c', 'pack.allowPackReuse=multi'];

type Project = { id: string; repositoryPath: string };

const LOOSE = /^[0-9a-f]{2}$/;
async function newest(files: string[]) {
  let time = 0;
  for (const file of files)
    time = Math.max(time, (await stat(file).catch(() => null))?.mtimeMs ?? 0);
  return time;
}

/**
 * True when a clone would compress objects again: objects are loose, there is no bitmap, or a
 * pack arrived after the newest bitmap. Reads the objects folder only; starts no Git.
 */
export async function needsPacking(repository: string) {
  const objects = join(repository, 'objects');
  const packFolder = join(objects, 'pack');
  for (const name of await readdir(objects).catch(() => [] as string[]))
    if (LOOSE.test(name) && (await readdir(join(objects, name)).catch(() => [])).length)
      return true;
  const names = await readdir(packFolder).catch(() => [] as string[]);
  // A pack's .idx is written once; the .pack itself is touched whenever Git freshens objects.
  const packs = names.filter((name) => name.endsWith('.idx')).map((name) => join(packFolder, name));
  if (!packs.length) return false;
  const bitmaps = names
    .filter((name) => name.endsWith('.bitmap'))
    .map((name) => join(packFolder, name));
  if (!bitmaps.length) return true;
  return (await newest(packs)) > (await newest(bitmaps));
}

function git(repository: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', repository, ...args], {
      env: gitEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    // Clones and pushes come first: packing is background work.
    try {
      if (child.pid) setPriority(child.pid, 10);
    } catch {
      /* Not permitted here; run at normal priority. */
    }
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), packingSettings.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(`git ${args[args.length - 1]} failed (${signal ?? code}): ${stderr.trim()}`),
        );
    });
  });
}

async function pack(repository: string) {
  const threads = Math.max(1, Math.floor(availableParallelism() / 2));
  await git(repository, [
    '-c',
    `pack.threads=${threads}`,
    // Bound the delta search: a window of ten 100 MB files would otherwise hold a gigabyte.
    '-c',
    'pack.windowMemory=256m',
    '-c',
    'gc.auto=0',
    'repack',
    '-d',
    '--geometric=2',
    '--write-midx',
    '--write-bitmap-index',
    '--quiet',
  ]);
  await git(repository, ['commit-graph', 'write', '--reachable', '--split']);
}

// One repack on the server at a time: each one uses half the cores and a lot of disk.
let queue: Promise<unknown> = Promise.resolve();
const waiting = new Set<string>();
const scheduled = new Map<string, NodeJS.Timeout>();
const background = new Set<Promise<unknown>>();

/** Pack the repository if it needs it. Waits for any packing before it; true when it packed. */
export function packRepository(project: Project): Promise<boolean> {
  const repository = project.repositoryPath;
  if (waiting.has(repository)) return Promise.resolve(false);
  waiting.add(repository);
  const work = queue.then(async () => {
    waiting.delete(repository);
    if (pruneBusy(project.id) || !(await needsPacking(repository))) return false;
    const started = Date.now();
    await pack(repository);
    packingSettings.log(
      `[git] Packed ${project.id} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return true;
  });
  queue = work.catch(() => {});
  background.add(work);
  void work
    .catch((error) => packingSettings.log(`[git] Packing ${project.id} failed: ${error?.message}`))
    .finally(() => background.delete(work));
  return work;
}

/** Called after every accepted push. */
export function schedulePacking(project: Project, delayMs = packingSettings.delayMs) {
  const repository = project.repositoryPath;
  clearTimeout(scheduled.get(repository));
  const timer = setTimeout(() => {
    scheduled.delete(repository);
    void packRepository(project).catch(() => {});
  }, delayMs);
  timer.unref();
  scheduled.set(repository, timer);
}

/** Every hosted repository: `<root>/<project id>.git`. */
export async function packAll(root: string) {
  const names = await readdir(root).catch(() => [] as string[]);
  const work = names
    .filter((name) => name.endsWith('.git'))
    .map((name) => packRepository({ id: name.slice(0, -4), repositoryPath: join(root, name) }));
  return (await Promise.allSettled(work)).filter(
    (result) => result.status === 'fulfilled' && result.value,
  ).length;
}

/** Resolves once every scheduled pack that has started has finished. */
export async function packingSettled() {
  while (background.size) await Promise.allSettled([...background]);
}

/** Sweep the hosted repositories soon after start, then every `sweepMs`. */
export function startRepositoryPacking(root: string) {
  const sweep = () => void packAll(root).catch(() => {});
  const first = setTimeout(sweep, packingSettings.firstSweepMs);
  first.unref();
  const every = setInterval(sweep, packingSettings.sweepMs);
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
