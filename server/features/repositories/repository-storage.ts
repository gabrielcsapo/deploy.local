// What a hosted repository takes on disk, and what it is made of: Git LFS objects, the code and
// history branches and tags hold, the work deploy.local keeps under refs/deploy, and the rest.
// Measuring reads every object's size, so it runs in the background and its answer is kept as a
// store record; reads serve that record and start a new measurement when it is missing or stale.
// The summary record stays small: the two file lists (every file, tens of thousands in a large
// repository) are records of their own, read only when a dialog asks for a page of them.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { gitEnvironment, gitRead } from '../../kernel/git.ts';
import { get, save } from '../../kernel/db/records.ts';
import { listCheckpointMetadata, now } from '../../workspace/store.ts';

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
  commandTimeoutMs: 10 * 60 * 1000,
};

const KIND = 'repository-storage';
/** One record per list: `<project>/lfs` and `<project>/history`. */
const FILES_KIND = 'repository-storage-files';
/** Summary records whose lists are stored apart; older ones held the largest 1,000 inline. */
const LISTS_VERSION = 2;
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
  const paths = new Map<string, { bytes: number; versions: number; changed: number }>();
  await reachableObjects(repository, ['--branches', '--tags'], (object) => {
    historyBytes += object.disk;
    if (object.type === 'commit') commits++;
    if (object.type !== 'blob') return;
    candidate(object);
    const entry = paths.get(object.path) ?? { bytes: 0, versions: 0, changed: 0 };
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
    .sort((a, b) => b.bytes - a.bytes);

  // Every path in history, when each last changed (one pass over the log) and whether the
  // default branch has it.
  if (paths.size)
    await gitLines(
      repository,
      ['log', '--branches', '--tags', '--name-only', '--no-renames', '--format=%x01%ct'],
      (() => {
        let time = 0;
        return (line: string) => {
          if (line.startsWith('\x01')) time = Number(line.slice(1)) * 1000;
          else if (line) {
            const entry = paths.get(line);
            if (entry && time > entry.changed) entry.changed = time;
          }
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
  const historyFiles: HistoryFile[] = [...paths.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([path, entry]) => ({
      path,
      bytes: entry.bytes,
      versions: entry.versions,
      lastChangedAt: entry.changed ? new Date(entry.changed).toISOString() : null,
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
      const { lfs, historyFiles, ...result } = await measureRepositoryStorage(
        project.repositoryPath,
        { defaultBranch: project.defaultBranch, taskOfRef: (ref) => checkpoints.get(ref) },
      );
      const measuredAt = now();
      // The lists first: a summary is only ever read with lists of its own measurement beside it.
      for (const [kind, files] of [
        ['lfs', lfs],
        ['history', historyFiles],
      ] as const)
        save(FILES_KIND, owner, {
          id: `${project.id}/${kind}`,
          projectId: project.id,
          kind,
          measuredAt,
          files,
        });
      save(KIND, owner, {
        id: project.id,
        projectId: project.id,
        measuredAt,
        attemptedAt,
        fingerprint: refs,
        lists: LISTS_VERSION,
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
async function refreshIfStale(owner: string, project: any, record: any, listsMissing = false) {
  if (running.has(`${owner}:${project.id}`)) return;
  if (!record) return void measure(owner, project);
  const attempted = Date.parse(record.attemptedAt || record.measuredAt || '') || 0;
  const age = Date.now() - attempted;
  if (age < storageSettings.minimumIntervalMs) return;
  // A measurement from before every file was kept is redone, so its dialogs list every file.
  if (
    record.error ||
    age >= storageSettings.staleAfterMs ||
    record.lists !== LISTS_VERSION ||
    listsMissing
  )
    return void measure(owner, project);
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

export type StorageSortKey = 'file' | 'added' | 'versions' | 'changed' | 'size';
export type StorageFilesQuery = {
  kind?: unknown;
  sort?: unknown;
  direction?: unknown;
  query?: unknown;
  page?: unknown;
};
/** Rows a dialog shows at once. */
export const STORAGE_PAGE_SIZE = 50;
const sortKeys: Record<'lfs' | 'history', StorageSortKey[]> = {
  lfs: ['file', 'added', 'size'],
  history: ['file', 'versions', 'changed', 'size'],
};
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

type Listed = { name: string; lower: string; bytes: number; at: number; versions: number };
type ListEntry = {
  measuredAt: string;
  files: (LargeFile | HistoryFile)[];
  rows: Listed[];
  /** Orders already worked out, by `<key> <direction>`: indexes into `files`. */
  orders: Map<string, number[]>;
};
/** Lists recently paged through, so each page, sort or search does not read and parse again. */
const lists = new Map<string, ListEntry>();
const LISTS_KEPT = 8;
const collator = new Intl.Collator();
function listEntry(key: string, measuredAt: string, kind: 'lfs' | 'history', files: any[]) {
  const existing = lists.get(key);
  if (existing?.measuredAt === measuredAt) {
    lists.delete(key);
    lists.set(key, existing);
    return existing;
  }
  const time = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);
  const rows = files.map((file): Listed => {
    // The name the dialog shows: an object no pointer names is listed by the start of its id.
    const name = kind === 'lfs' ? (file.path ?? file.oid.slice(0, 12)) : file.path;
    return {
      name,
      lower: name.toLowerCase(),
      bytes: file.bytes,
      at: time(kind === 'lfs' ? file.addedAt : file.lastChangedAt),
      versions: file.versions ?? 0,
    };
  });
  const entry: ListEntry = { measuredAt, files, rows, orders: new Map() };
  lists.set(key, entry);
  while (lists.size > LISTS_KEPT) lists.delete(lists.keys().next().value!);
  return entry;
}
/** The dialog's order: by the column, ties by name; the same order the browser once sorted in. */
function ordered(entry: ListEntry, key: StorageSortKey, direction: 'ascending' | 'descending') {
  const id = `${key} ${direction}`;
  const known = entry.orders.get(id);
  if (known) return known;
  const sign = direction === 'ascending' ? 1 : -1;
  const rows = entry.rows;
  const value = (row: Listed): number | string =>
    key === 'file'
      ? row.lower
      : key === 'size'
        ? row.bytes
        : key === 'versions'
          ? row.versions
          : row.at;
  const order = rows
    .map((_, index) => index)
    .sort((a, b) => {
      const x = value(rows[a]),
        y = value(rows[b]);
      const compared = x < y ? -1 : x > y ? 1 : 0;
      return compared * sign || collator.compare(rows[a].name, rows[b].name);
    });
  entry.orders.set(id, order);
  return order;
}

/** A list of the last measurement, kept apart from the summary; null when there is none. */
function storedList(owner: string, projectId: string, kind: 'lfs' | 'history', record: any) {
  try {
    const list = get(FILES_KIND, owner, `${projectId}/${kind}`);
    if (list?.measuredAt === record.measuredAt && Array.isArray(list.files)) return list.files;
  } catch {
    // Not written: a measurement from before lists were kept apart.
  }
  return null;
}

/** One page of the file list behind a row, from the last measurement: sorted, searched, paged. */
export async function repositoryStorageFiles(
  owner: string,
  projectId: string,
  options: StorageFilesQuery,
) {
  const kind = options.kind;
  if (kind !== 'lfs' && kind !== 'history') throw invalid('kind must be lfs or history');
  const key = (options.sort ?? 'size') as StorageSortKey;
  if (!sortKeys[kind].includes(key))
    throw invalid(`sort must be one of ${sortKeys[kind].join(', ')}`);
  const direction = options.direction ?? (key === 'file' ? 'ascending' : 'descending');
  if (direction !== 'ascending' && direction !== 'descending')
    throw invalid('direction must be ascending or descending');
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  const asked = Number(options.page ?? 1);
  if (!Number.isInteger(asked) || asked < 1) throw invalid('page must be a whole number from 1');

  const project = hostedRepository(owner, projectId);
  if (!project)
    throw Object.assign(new Error('This project has no hosted repository'), { status: 404 });
  const record = cached(owner, projectId);
  if (!record?.measuredAt)
    throw Object.assign(new Error('This repository has not been measured yet'), { status: 409 });
  const stored = storedList(owner, projectId, kind, record);
  // Until it is measured again, a record from before every file was kept shows the largest
  // 1,000 it held; the new measurement lists every file.
  if (!stored) await refreshIfStale(owner, project, record, true);
  const inline = kind === 'lfs' ? record.lfs : record.historyFiles;
  const entry = listEntry(
    `${owner}:${projectId}:${kind}`,
    record.measuredAt,
    kind,
    stored ?? (Array.isArray(inline) ? inline : []),
  );
  const order = ordered(entry, key, direction);
  const needle = query.toLowerCase();
  const matched = needle
    ? order.filter((index) => entry.rows[index].lower.includes(needle))
    : order;
  let matchedBytes = 0;
  for (const index of matched) matchedBytes += entry.rows[index].bytes;
  // A page past the end shows the last one.
  const pages = Math.max(1, Math.ceil(matched.length / STORAGE_PAGE_SIZE));
  const page = Math.min(asked, pages);
  const start = (page - 1) * STORAGE_PAGE_SIZE;
  const files = matched.slice(start, start + STORAGE_PAGE_SIZE).map((index) => entry.files[index]);
  const shared = {
    measuredAt: record.measuredAt as string,
    query,
    sort: key,
    direction,
    page,
    pageSize: STORAGE_PAGE_SIZE,
    matches: matched.length,
    matchedBytes,
    files,
  };
  return kind === 'lfs'
    ? {
        kind,
        count: record.largeFiles.count as number,
        bytes: record.largeFiles.bytes as number,
        ...shared,
      }
    : {
        kind,
        count: record.history.files as number,
        commits: record.history.commits as number,
        bytes: record.history.bytes as number,
        ...shared,
      };
}
