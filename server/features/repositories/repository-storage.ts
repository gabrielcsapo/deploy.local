// What a hosted repository takes on disk, and what it is made of: Git LFS objects, the code and
// history branches and tags hold, the work deploy.local keeps under refs/deploy, and the rest.
// Measuring reads every object's size, so it runs in the background and its answer is kept as a
// store record; reads serve that record and start a new measurement when it is missing or stale.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gitEnvironment, gitRead } from '../../kernel/git.ts';
import { get, save, listCheckpointMetadata, now } from '../../workspace/store.ts';

export type LargeFile = {
  oid: string;
  /** The path its pointer was committed at; null when no pointer in the repository names it. */
  path: string | null;
  bytes: number;
  addedAt: string | null;
  /** True when a branch or tag's latest commit has this file. */
  onBranch: boolean;
};
export type HistoryFile = {
  path: string;
  /** What all of the path's versions take on disk, after compression. */
  bytes: number;
  versions: number;
  lastChangedAt: string | null;
  /** The path is gone from the default branch's latest commit. */
  deleted: boolean;
};
export type StorageMeasurement = {
  total: number;
  largeFiles: { bytes: number; count: number };
  history: { bytes: number; commits: number; files: number };
  work: { bytes: number; tasks: number; reviews: number };
  other: { bytes: number };
  lfs: LargeFile[];
  historyFiles: HistoryFile[];
  durationMs: number;
};
export type StorageSummary =
  | { available: false }
  | {
      available: true;
      measuredAt: string | null;
      measuring: boolean;
      /** The last measurement failed; the previous answer, if any, is still served. */
      error?: string;
      total?: number;
      largeFiles?: StorageMeasurement['largeFiles'];
      history?: StorageMeasurement['history'];
      work?: StorageMeasurement['work'];
      other?: StorageMeasurement['other'];
    };

/** Tunables, changed only by tests. */
export const storageSettings = {
  /** A measurement older than this is redone in the background. */
  staleAfterMs: 6 * 60 * 60 * 1000,
  /** Refs moved since the last measurement start a new one, at most this often. */
  minimumIntervalMs: 60 * 1000,
  /** Measurements running at once across the server. */
  concurrency: 2,
  /** Rows kept for each dialog; counts and totals stay true beyond them. */
  historyLimit: 1000,
  lfsLimit: 1000,
  commandTimeoutMs: 10 * 60 * 1000,
};

const KIND = 'repository-storage';
const POINTER = 'version https://git-lfs.github.com/spec/v1';

/** One git process whose output is read line by line, so a large answer is never buffered. */
function gitLines(
  cwd: string,
  args: string[],
  onLine: (line: string) => void,
  input?: NodeJS.ReadableStream | string,
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotePath=false', '-C', cwd, ...args],
      { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Measuring the repository took too long');
      child.kill('SIGKILL');
    }, storageSettings.commandTimeoutMs);
    child.stderr.on('data', (chunk) => (stderr = (stderr + chunk).slice(-4000)));
    child.stdin.on('error', () => {});
    if (typeof input === 'string' || input === undefined) child.stdin.end(input);
    else input.pipe(child.stdin);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      if (failure) return;
      try {
        onLine(line);
      } catch (error: any) {
        failure = error;
        child.kill('SIGKILL');
      }
    });
    child.once('error', (error) => (failure ||= error));
    // `close` follows the end of stdout, so every line has been read.
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git command failed (${code}): ${stderr.trim()}`));
      else resolve();
    });
  });
}

type ObjectLine = { type: string; disk: number; size: number; oid: string; path: string };
/** Every object the revisions reach, with its size on disk: `rev-list --objects` into
 * `cat-file --batch-check`, which passes each object's path through as `%(rest)`. */
function reachableObjects(cwd: string, revisions: string[], onObject: (line: ObjectLine) => void) {
  const list = spawn(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', cwd, 'rev-list', '--objects', ...revisions],
    { env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let listError = '';
  list.stderr.on('data', (chunk) => (listError = (listError + chunk).slice(-4000)));
  const listed = new Promise<void>((resolve, reject) => {
    list.once('error', reject);
    list.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Git command failed (${code}): ${listError}`)),
    );
  });
  const checked = gitLines(
    cwd,
    [
      'cat-file',
      '--batch-check=%(objecttype) %(objectsize:disk) %(objectsize) %(objectname) %(rest)',
    ],
    (line) => {
      const [type, disk, size, oid] = line.split(' ', 4);
      if (!oid || type === 'missing' || oid === 'missing') return;
      const path = line.slice(type.length + disk.length + size.length + oid.length + 4);
      onObject({ type, disk: Number(disk), size: Number(size), oid, path });
    },
    list.stdout,
  );
  return Promise.all([listed, checked]).then(() => undefined);
}

/** The contents of small blobs, read with one `cat-file --batch`. */
function readBlobs(cwd: string, oids: string[], onBlob: (oid: string, text: string) => void) {
  return new Promise<void>((resolve, reject) => {
    if (!oids.length) return resolve();
    const child = spawn(
      'git',
      ['-c', 'core.hooksPath=/dev/null', '-C', cwd, 'cat-file', '--batch'],
      {
        env: gitEnvironment(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let buffer: Buffer = Buffer.alloc(0);
    let pending: { oid: string; size: number } | null = null;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Measuring the repository took too long');
      child.kill('SIGKILL');
    }, storageSettings.commandTimeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (!pending) {
          const end = buffer.indexOf(10);
          if (end < 0) return;
          const [oid, type, size] = buffer.subarray(0, end).toString().split(' ');
          buffer = buffer.subarray(end + 1);
          if (type === 'missing' || size === undefined) continue;
          pending = { oid, size: Number(size) };
        }
        if (buffer.length < pending.size + 1) return;
        onBlob(pending.oid, buffer.subarray(0, pending.size).toString());
        buffer = buffer.subarray(pending.size + 1);
        pending = null;
      }
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(oids.join('\n') + '\n');
    child.once('error', (error) => (failure ||= error));
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git command failed (${code})`));
      else resolve();
    });
  });
}

/** Bytes of every file under a folder, without following links. */
async function folderBytes(folder: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) total += await folderBytes(path);
    else total += (await lstat(path).catch(() => null))?.size ?? 0;
  }
  return total;
}

/** LFS objects as deploy.local stores them: lfs/objects/aa/bb/<oid>. */
async function lfsObjects(repository: string) {
  const objects: { oid: string; bytes: number; modifiedAt: string }[] = [];
  const base = join(repository, 'lfs', 'objects');
  for (const first of await readdir(base).catch(() => [] as string[]))
    for (const second of await readdir(join(base, first)).catch(() => [] as string[]))
      for (const oid of await readdir(join(base, first, second)).catch(() => [] as string[])) {
        if (!/^[a-f0-9]{64}$/.test(oid)) continue;
        const info = await lstat(join(base, first, second, oid)).catch(() => null);
        if (info?.isFile())
          objects.push({ oid, bytes: info.size, modifiedAt: info.mtime.toISOString() });
      }
  return objects;
}

/** A pointer's LFS object id, or null when the text is not an LFS pointer. */
export function pointerOid(text: string) {
  if (!text.startsWith(POINTER + '\n')) return null;
  return /^oid sha256:([a-f0-9]{64})$/m.exec(text)?.[1] ?? null;
}

/**
 * Measure a bare repository. `taskOfRef` names the task a refs/deploy ref belongs to, for refs
 * whose names do not say (checkpoint refs are named after a hash).
 */
export async function measureRepositoryStorage(
  repository: string,
  options: { defaultBranch?: string; taskOfRef?: (ref: string) => string | undefined } = {},
): Promise<StorageMeasurement> {
  const started = Date.now();
  const total = await folderBytes(repository);
  const stored = await lfsObjects(repository);
  const largeBytes = stored.reduce((sum, object) => sum + object.bytes, 0);

  // Pointer candidates: an LFS pointer is a small text blob (the spec keeps it under 1024 bytes).
  const candidates = new Map<string, string>();
  const candidate = (object: ObjectLine) => {
    if (object.type === 'blob' && object.size >= 100 && object.size < 1024)
      if (!candidates.has(object.oid)) candidates.set(object.oid, object.path);
  };

  // Branches and tags: the code and its history.
  let historyBytes = 0,
    commits = 0;
  const paths = new Map<string, { bytes: number; versions: number }>();
  await reachableObjects(repository, ['--branches', '--tags'], (object) => {
    historyBytes += object.disk;
    if (object.type === 'commit') commits++;
    if (object.type !== 'blob') return;
    candidate(object);
    const entry = paths.get(object.path) ?? { bytes: 0, versions: 0 };
    entry.bytes += object.disk;
    entry.versions++;
    paths.set(object.path, entry);
  });

  // deploy.local's own refs: what they hold beyond branches and tags.
  let workBytes = 0;
  await reachableObjects(
    repository,
    ['--glob=refs/deploy/*', '--not', '--branches', '--tags'],
    (object) => {
      workBytes += object.disk;
      candidate(object);
    },
  );
  // Anything else (remote-tracking refs) is only searched for pointers; its bytes are Other.
  await reachableObjects(
    repository,
    ['--all', '--not', '--branches', '--tags', '--glob=refs/deploy/*'],
    candidate,
  );

  const tasks = new Set<string>();
  let reviews = 0;
  await gitLines(repository, ['for-each-ref', '--format=%(refname)', 'refs/deploy/'], (ref) => {
    const named = /^refs\/deploy\/(?:tasks|checkpoint-baseline)\/([^/]+)$/.exec(ref)?.[1];
    const task = named ?? options.taskOfRef?.(ref);
    if (task) tasks.add(task);
    if (ref.startsWith('refs/deploy/design-reviews/')) reviews++;
  });

  // Which candidates are pointers, and to which LFS object.
  const pointers = new Map<string, { oid: string; path: string }>();
  await readBlobs(repository, [...candidates.keys()], (blob, text) => {
    const oid = pointerOid(text);
    if (oid) pointers.set(blob, { oid, path: candidates.get(blob) || '' });
  });
  const tipBlobs = new Set<string>();
  if (pointers.size)
    await gitLines(
      repository,
      ['rev-list', '--objects', '--no-walk', '--branches', '--tags'],
      (line) => {
        const oid = line.slice(0, line.indexOf(' ') < 0 ? undefined : line.indexOf(' '));
        if (pointers.has(oid)) tipBlobs.add(oid);
      },
    );
  // When each pointer was first committed, from every ref.
  const added = new Map<string, number>();
  if (pointers.size)
    await gitLines(
      repository,
      ['log', '--all', '--raw', '--no-abbrev', '--no-renames', '--format=%x01%ct'],
      (() => {
        let time = 0;
        return (line: string) => {
          if (line.startsWith('\x01')) time = Number(line.slice(1)) * 1000;
          else if (line.startsWith(':')) {
            const blob = line.split(' ')[3];
            if (pointers.has(blob) && (!added.has(blob) || time < added.get(blob)!))
              added.set(blob, time);
          }
        };
      })(),
    );
  const byOid = new Map<string, { path: string; addedAt: number | null; onBranch: boolean }>();
  for (const [blob, pointer] of pointers) {
    const previous = byOid.get(pointer.oid);
    const at = added.get(blob) ?? null;
    const onBranch = tipBlobs.has(blob) || !!previous?.onBranch;
    // The earliest commit names the file and its date; a tip anywhere keeps it on a branch.
    if (!previous || (at !== null && (previous.addedAt === null || at < previous.addedAt)))
      byOid.set(pointer.oid, { path: pointer.path, addedAt: at, onBranch });
    else previous.onBranch = onBranch;
  }
  const lfs: LargeFile[] = stored
    .map((object) => {
      const pointer = byOid.get(object.oid);
      return {
        oid: object.oid,
        path: pointer?.path || null,
        bytes: object.bytes,
        addedAt:
          pointer?.addedAt != null ? new Date(pointer.addedAt).toISOString() : object.modifiedAt,
        onBranch: !!pointer?.onBranch,
      };
    })
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, storageSettings.lfsLimit);

  // The largest paths in history, when each last changed and whether the default branch has it.
  const largest = [...paths.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, storageSettings.historyLimit);
  const wanted = new Map(largest.map(([path]) => [path, 0]));
  if (wanted.size)
    await gitLines(
      repository,
      ['log', '--branches', '--tags', '--name-only', '--no-renames', '--format=%x01%ct'],
      (() => {
        let time = 0;
        return (line: string) => {
          if (line.startsWith('\x01')) time = Number(line.slice(1)) * 1000;
          else if (line && wanted.has(line) && time > wanted.get(line)!) wanted.set(line, time);
        };
      })(),
    );
  const atTip = new Set<string>();
  let tipKnown = false;
  const branch =
    options.defaultBranch || (await gitRead(repository, ['symbolic-ref', '--short', 'HEAD']));
  if (branch)
    try {
      await gitLines(
        repository,
        ['ls-tree', '-r', '--name-only', '--full-tree', `refs/heads/${branch}`],
        (path) => atTip.add(path),
      );
      tipKnown = true;
    } catch {
      // No such branch yet: nothing is called deleted.
    }
  const historyFiles: HistoryFile[] = largest.map(([path, entry]) => ({
    path,
    bytes: entry.bytes,
    versions: entry.versions,
    lastChangedAt: wanted.get(path) ? new Date(wanted.get(path)!).toISOString() : null,
    deleted: tipKnown && !atTip.has(path),
  }));

  return {
    total,
    largeFiles: { bytes: largeBytes, count: stored.length },
    history: { bytes: historyBytes, commits, files: paths.size },
    work: { bytes: workBytes, tasks: tasks.size, reviews },
    other: { bytes: Math.max(0, total - largeBytes - historyBytes - workBytes) },
    lfs,
    historyFiles,
    durationMs: Date.now() - started,
  };
}

// --- Cache and scheduling ---------------------------------------------------------------------

const running = new Map<string, Promise<void>>();
const queue: (() => void)[] = [];
let active = 0;
async function slot<T>(work: () => Promise<T>) {
  if (active >= storageSettings.concurrency) await new Promise<void>((go) => queue.push(go));
  active++;
  try {
    return await work();
  } finally {
    active--;
    queue.shift()?.();
  }
}
/** Measurements running and waiting for a slot, server-wide. */
export function storageActivity() {
  return { active, queued: queue.length };
}
/** The measurement in progress for a project, if any. */
export function storageMeasurement(owner: string, projectId: string) {
  return running.get(`${owner}:${projectId}`);
}
async function fingerprint(repository: string) {
  const refs = await gitRead(repository, ['for-each-ref', '--format=%(refname) %(objectname)']);
  return refs === null ? null : createHash('sha256').update(refs).digest('hex');
}
function cached(owner: string, projectId: string): any | null {
  try {
    return get(KIND, owner, projectId);
  } catch {
    return null;
  }
}
function hostedRepository(owner: string, projectId: string) {
  const project = get('project', owner, projectId);
  const ready = (project.repositoryStatus || 'ready') === 'ready';
  return ready && project.repositoryPath && existsSync(project.repositoryPath) ? project : null;
}
function measure(owner: string, project: any) {
  const key = `${owner}:${project.id}`;
  const existing = running.get(key);
  if (existing) return existing;
  const work = slot(async () => {
    const attemptedAt = now();
    const previous = cached(owner, project.id);
    try {
      const refs = await fingerprint(project.repositoryPath);
      const checkpoints = new Map<string, string>();
      for (const checkpoint of listCheckpointMetadata(owner))
        if (checkpoint.baseRef && checkpoint.taskId)
          checkpoints.set(checkpoint.baseRef, checkpoint.taskId);
      const result = await measureRepositoryStorage(project.repositoryPath, {
        defaultBranch: project.defaultBranch,
        taskOfRef: (ref) => checkpoints.get(ref),
      });
      save(KIND, owner, {
        id: project.id,
        projectId: project.id,
        measuredAt: now(),
        attemptedAt,
        fingerprint: refs,
        ...result,
      });
    } catch (error: any) {
      save(KIND, owner, {
        ...(previous ?? { id: project.id, projectId: project.id, measuredAt: null }),
        attemptedAt,
        error: String(error?.message || error).slice(0, 500),
      });
    }
  }).finally(() => running.delete(key));
  running.set(key, work);
  return work;
}
/** Start a measurement when there is none, it is old, the refs moved, or the last one failed. */
async function refreshIfStale(owner: string, project: any, record: any) {
  if (running.has(`${owner}:${project.id}`)) return;
  if (!record) return void measure(owner, project);
  const attempted = Date.parse(record.attemptedAt || record.measuredAt || '') || 0;
  const age = Date.now() - attempted;
  if (age < storageSettings.minimumIntervalMs) return;
  if (record.error || age >= storageSettings.staleAfterMs) return void measure(owner, project);
  if ((await fingerprint(project.repositoryPath)) !== record.fingerprint)
    void measure(owner, project);
}

/** The summary the Settings tab shows. Never waits for a measurement. */
export async function repositoryStorage(owner: string, projectId: string): Promise<StorageSummary> {
  const project = hostedRepository(owner, projectId);
  if (!project) return { available: false };
  const record = cached(owner, projectId);
  await refreshIfStale(owner, project, record);
  const measuring = running.has(`${owner}:${projectId}`);
  if (!record?.measuredAt)
    return {
      available: true,
      measuredAt: null,
      measuring,
      ...(record?.error && !measuring ? { error: record.error } : {}),
    };
  return {
    available: true,
    measuredAt: record.measuredAt,
    measuring,
    ...(record.error ? { error: record.error } : {}),
    total: record.total,
    largeFiles: record.largeFiles,
    history: record.history,
    work: record.work,
    other: record.other,
  };
}

/** The file list behind one row, from the last measurement. */
export async function repositoryStorageFiles(owner: string, projectId: string, kind: unknown) {
  if (kind !== 'lfs' && kind !== 'history')
    throw Object.assign(new Error('kind must be lfs or history'), { status: 400 });
  const project = hostedRepository(owner, projectId);
  if (!project)
    throw Object.assign(new Error('This project has no hosted repository'), { status: 404 });
  const record = cached(owner, projectId);
  if (!record?.measuredAt)
    throw Object.assign(new Error('This repository has not been measured yet'), { status: 409 });
  return kind === 'lfs'
    ? {
        kind,
        measuredAt: record.measuredAt,
        count: record.largeFiles.count,
        bytes: record.largeFiles.bytes,
        files: record.lfs,
        truncated: record.lfs.length < record.largeFiles.count,
      }
    : {
        kind,
        measuredAt: record.measuredAt,
        count: record.history.files,
        commits: record.history.commits,
        bytes: record.history.bytes,
        files: record.historyFiles,
        truncated: record.historyFiles.length < record.history.files,
      };
}
