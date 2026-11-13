import { gitResultSync } from '../kernel/git.ts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

/** A full-tree checkpoint carries every workspace file, so it has to stay small. */
export const snapshotLimit = 8 * 1024 * 1024;
/** A checkpoint over a repository commit carries only changes, so it can be much larger. */
export const deltaLimit = 64 * 1024 * 1024;
/** One changed file inside a delta. Keeps a single huge artifact out of the conversation. */
export const deltaFileLimit = 16 * 1024 * 1024;
/** JSON and base64 overhead for the largest delta an agent may send to the coordinator. */
export const snapshotRequestLimit = 96 * 1024 * 1024;

export type Snapshot = {
  /** Set when `files`/`deleted` are a delta over a commit the coordinator's repository has. */
  base?: { commit: string };
  files: { path: string; content: string; executable: boolean }[];
  /** Paths the delta removes from the base tree. Only meaningful together with `base`. */
  deleted?: string[];
  excluded: string[];
  digest: string;
};
type Sized = { path: string; size: number; executable: boolean };

const privatePath = (path: string) =>
  path
    .split('/')
    .map((part) => part.normalize('NFC').toLowerCase())
    .some(
      (p) =>
        p === '.git' ||
        p === '.ssh' ||
        p === '.aws' ||
        p === '.npmrc' ||
        p === '.netrc' ||
        /^(\.env($|\.)|id_rsa|id_ed25519)/i.test(p) ||
        /\.(pem|key|p12|pfx)$/i.test(p),
    );
const validPath = (path: string) =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length < 1024 &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  !path.startsWith('/') &&
  path.split('/').every((p) => p !== '.' && p !== '..' && p !== '') &&
  !privatePath(path);
export const checkpointCommitId = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;
const portableKey = (path: string) => path.normalize('NFC').toLowerCase();
const byPath = (a: string, b: string) => a.localeCompare(b, 'en');
/** Canonical base64 encodes three bytes per four characters; the round trip below proves it. */
const encodedBytes = (content: string) =>
  content.length % 4 === 0
    ? (content.length / 4) * 3 - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0)
    : 0;

function digest(snapshot: Pick<Snapshot, 'files'> & Partial<Pick<Snapshot, 'base' | 'deleted'>>) {
  // Full-tree checkpoints keep the original digest so checkpoints stored before deltas existed
  // still validate; anything with a base or deletions commits to all three fields.
  const covered =
    !snapshot.base && !snapshot.deleted?.length
      ? snapshot.files
      : {
          base: snapshot.base ?? null,
          files: snapshot.files,
          deleted: snapshot.deleted ?? [],
        };
  return createHash('sha256').update(JSON.stringify(covered)).digest('hex');
}

const mib = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
/** An oversized checkpoint must say what to remove, not only that it is too big. */
function oversized(
  subject: string,
  total: number,
  limit: number,
  entries: Sized[],
  advice: string,
) {
  const largest = [...entries]
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
    .map((entry) => `${entry.path} (${mib(entry.size)})`)
    .join(', ');
  return new Error(
    `${subject} is ${mib(total)}, above the ${mib(limit)} limit. Largest files: ${largest}. ${advice}`,
  );
}
const tooBig = (entry: Sized, limit: number, advice: string) =>
  new Error(
    `Checkpoint file ${entry.path} is ${mib(entry.size)}, above the ${mib(limit)} limit for one file. ${advice}`,
  );
const reduceWorkspace =
  'This conversation has no repository commit to measure changes against, so the checkpoint carries every file; remove, ignore or shrink these files before retrying.';
const reduceChanges =
  'Remove or ignore these files, or commit them to the repository first, then capture again.';

export function validateSnapshot(value: Snapshot): Snapshot {
  if (
    !Array.isArray(value?.files) ||
    value.files.length > 10000 ||
    !Array.isArray(value.excluded) ||
    value.excluded.length > 10000 ||
    (value.deleted !== undefined && (!Array.isArray(value.deleted) || value.deleted.length > 10000))
  )
    throw new Error('Invalid checkpoint');
  let base: Snapshot['base'];
  if (value.base !== undefined && value.base !== null) {
    const commit = checkpointCommitId((value.base as any).commit);
    if (!commit) throw new Error('Checkpoint base must name a Git commit');
    base = { commit };
  }
  const removals = value.deleted ?? [];
  if (!base && removals.length) throw new Error('Checkpoint deletions require a base commit');
  const seen = new Set<string>();
  const sizes: Sized[] = [];
  let total = 0;
  const files = value.files
    .map((f) => {
      if (
        !f ||
        !validPath(f.path) ||
        seen.has(portableKey(f.path)) ||
        typeof f.content !== 'string' ||
        typeof f.executable !== 'boolean'
      )
        throw new Error('Unsafe checkpoint path or entry');
      seen.add(portableKey(f.path));
      const size = encodedBytes(f.content);
      total += size;
      sizes.push({ path: f.path, size, executable: f.executable });
      return { path: f.path, content: f.content, executable: f.executable };
    })
    .sort((a, b) => byPath(a.path, b.path));
  const fileLimit = base ? deltaFileLimit : snapshotLimit;
  const single = sizes.find((entry) => entry.size > fileLimit);
  if (single) throw tooBig(single, fileLimit, base ? reduceChanges : reduceWorkspace);
  const limit = base ? deltaLimit : snapshotLimit;
  if (total > limit)
    throw oversized(
      base ? 'This checkpoint’s changed content' : 'This checkpoint',
      total,
      limit,
      sizes,
      base ? reduceChanges : reduceWorkspace,
    );
  for (const file of files) {
    const bytes = Buffer.from(file.content, 'base64');
    if (bytes.toString('base64') !== file.content) throw new Error('Invalid checkpoint encoding');
  }
  // A delta may delete a file and add a directory in its place, so deletions are checked
  // against each other and the written files, never against the file/directory shape.
  const removed = new Set<string>();
  const deleted = removals
    .map((entry) => {
      const path = String(entry);
      if (!validPath(path) || removed.has(portableKey(path)) || seen.has(portableKey(path)))
        throw new Error('Unsafe checkpoint deletion');
      removed.add(portableKey(path));
      return path;
    })
    .sort(byPath);
  for (const f of files) {
    const parts = f.path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (seen.has(portableKey(parts.join('/'))))
        throw new Error('Checkpoint file/directory collision');
    }
  }
  const excluded = value.excluded.map((p) => String(p).slice(0, 1024));
  const hash = digest({ base, files, deleted });
  if (value.digest !== hash) throw new Error('Checkpoint digest mismatch');
  return {
    ...(base ? { base } : {}),
    files,
    ...(deleted.length ? { deleted } : {}),
    excluded,
    digest: hash,
  };
}

const git = (cwd: string, args: string[]) =>
  gitResultSync(cwd, args, { literalPathspecs: true, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });

/** Where a worker records the commit the coordinator prepared this workspace from. It lives in
 * the per-worktree Git directory: never inside the tree, never shared between worktrees, and
 * never part of a checkpoint. */
function basePath(cwd: string) {
  const result = git(cwd, ['rev-parse', '--absolute-git-dir']);
  return result.status === 0 ? join(result.stdout.trim(), 'deploy-checkpoint-base') : null;
}

/** Workers call this after checking out or installing a baseline. Metadata only. */
export function recordCheckpointBase(cwd: string, commit: unknown) {
  const value = checkpointCommitId(commit);
  if (!value) return false;
  try {
    const path = basePath(cwd);
    if (!path) return false;
    writeFileSync(path, value + '\n', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The recorded base, or null when this workspace cannot be diffed against one. */
export function readCheckpointBase(cwd: string): string | null {
  const path = basePath(cwd);
  if (!path) return null;
  let commit: string | null = null;
  try {
    commit = checkpointCommitId(readFileSync(path, 'utf8').trim());
  } catch {
    return null;
  }
  if (!commit || git(cwd, ['cat-file', '-e', `${commit}^{commit}`]).status !== 0) return null;
  return commit;
}

/** Workspace files a checkpoint can carry, with the review/privacy exclusions applied. */
function describeFiles(cwd: string, paths: string[], excluded: string[]) {
  const entries: Sized[] = [];
  for (const path of paths) {
    if (!validPath(path)) {
      excluded.push(path);
      continue;
    }
    let stat;
    try {
      // Never follow symlink parents (including submodules or replaced directories).
      let parent = cwd;
      for (const part of path.split('/')) {
        parent = resolve(parent, part);
        if (lstatSync(parent).isSymbolicLink()) throw new Error('Symlink');
      }
      stat = lstatSync(resolve(cwd, path));
    } catch {
      excluded.push(path);
      continue;
    }
    if (!stat.isFile()) {
      excluded.push(path);
      continue;
    }
    entries.push({ path, size: stat.size, executable: Boolean(stat.mode & 0o111) });
  }
  return entries;
}
const readFiles = (cwd: string, entries: Sized[]): Snapshot['files'] =>
  entries
    .map((entry) => ({
      path: entry.path,
      content: readFileSync(resolve(cwd, entry.path)).toString('base64'),
      executable: entry.executable,
    }))
    .sort((a, b) => byPath(a.path, b.path));

/** Every workspace file. Used by conversations without a repository and as the fallback when
 * no usable base commit was recorded. */
function captureTree(cwd: string): Snapshot {
  const listed = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (listed.status !== 0) throw new Error('Checkpoint requires a Git workspace');
  const excluded: string[] = [];
  const entries = describeFiles(
    cwd,
    [...new Set(listed.stdout.split('\0').filter(Boolean))].sort(byPath),
    excluded,
  );
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > snapshotLimit)
    throw oversized('This checkpoint', total, snapshotLimit, entries, reduceWorkspace);
  const files = readFiles(cwd, entries);
  return validateSnapshot({ files, excluded, digest: digest({ files }) });
}

/** Changes against a commit the coordinator has, so a checkpoint's size follows the change
 * rather than the repository. Renames arrive as a deletion plus an addition. */
function captureDelta(cwd: string, commit: string): Snapshot {
  const changed = git(cwd, [
    'diff',
    '--name-status',
    '-z',
    '--no-renames',
    '--ignore-submodules=all',
    commit,
    '--',
  ]);
  const others = git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']);
  if (changed.status !== 0 || others.status !== 0)
    throw new Error('Checkpoint requires a Git workspace');
  const fields = changed.stdout.split('\0').filter(Boolean);
  const removals: string[] = [],
    candidates: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2)
    (fields[i].startsWith('D') ? removals : candidates).push(fields[i + 1]);
  for (const path of others.stdout.split('\0').filter(Boolean)) candidates.push(path);
  const excluded: string[] = [];
  const entries = describeFiles(cwd, [...new Set(candidates)].sort(byPath), excluded);
  const single = entries.find((entry) => entry.size > deltaFileLimit);
  if (single) throw tooBig(single, deltaFileLimit, reduceChanges);
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total > deltaLimit)
    throw oversized('This checkpoint’s changed content', total, deltaLimit, entries, reduceChanges);
  const present = new Set(entries.map((entry) => entry.path));
  const deleted: string[] = [];
  for (const path of [...new Set(removals)].sort(byPath)) {
    // A path dropped from the index but still on disk is carried, not removed.
    if (present.has(path)) continue;
    if (!validPath(path)) excluded.push(path);
    else deleted.push(path);
  }
  const files = readFiles(cwd, entries);
  const base = { commit };
  return validateSnapshot({
    base,
    files,
    deleted,
    excluded,
    digest: digest({ base, files, deleted }),
  });
}

export function captureSnapshot(cwd: string): Snapshot {
  const base = readCheckpointBase(cwd);
  return base ? captureDelta(cwd, base) : captureTree(cwd);
}

/** A materialized base tree can contain symlinks and directories where the delta writes
 * files; never write through a symlink, and replace whatever occupies the path. */
function target(destination: string, path: string, materialized: boolean) {
  const resolved = resolve(destination, path);
  if (materialized) {
    let parent = destination;
    for (const part of path.split('/').slice(0, -1)) {
      parent = resolve(parent, part);
      let stat;
      try {
        stat = lstatSync(parent);
      } catch {
        break;
      }
      if (stat.isSymbolicLink())
        throw new Error(`Checkpoint path ${path} crosses a symlink in its base tree`);
    }
  }
  return resolved;
}

function applySnapshot(snapshot: Snapshot, destination: string, materialized: boolean) {
  for (const path of snapshot.deleted ?? [])
    rmSync(target(destination, path, materialized), { recursive: true, force: true });
  for (const file of snapshot.files) {
    const path = target(destination, file.path, materialized);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (materialized) rmSync(path, { recursive: true, force: true });
    writeFileSync(path, Buffer.from(file.content, 'base64'), {
      flag: 'wx',
      mode: file.executable ? 0o700 : 0o600,
    });
  }
}

/** Writes a full-tree checkpoint into a new directory. */
export function restoreSnapshot(value: Snapshot, destination: string) {
  const snapshot = validateSnapshot(value);
  if (snapshot.base)
    throw new Error(
      `This checkpoint is a delta over ${snapshot.base.commit}; restore it with restoreCheckpoint so its base tree is materialized first`,
    );
  // A fresh directory is mandatory; never reuse a possibly modified job checkout.
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  applySnapshot(snapshot, destination, false);
}

/** Writes any checkpoint into a new directory. `base` materializes the base commit's tree,
 * which the caller reads from the coordinator's repository. */
export async function restoreCheckpoint(
  value: Snapshot,
  destination: string,
  base?: (commit: string, destination: string) => Promise<void> | void,
) {
  const snapshot = validateSnapshot(value);
  mkdirSync(destination, { recursive: false, mode: 0o700 });
  if (snapshot.base) {
    if (!base)
      throw new Error(
        `This checkpoint is a delta over ${snapshot.base.commit} and needs that base tree`,
      );
    await base(snapshot.base.commit, destination);
  }
  applySnapshot(snapshot, destination, Boolean(snapshot.base));
}

/** Apply a validated handoff to a newly prepared Git workspace, before any agent starts. */
export function restoreTaskCheckpoint(value: Snapshot, destination: string) {
  const snapshot = validateSnapshot(value);
  const markerResult = gitResultSync(destination, [
    'rev-parse',
    '--git-path',
    'deploy-task-checkpoint',
  ]);
  if (markerResult.status !== 0) throw new Error('Task checkpoint needs a Git workspace');
  const marker = resolve(destination, markerResult.stdout.toString().trim());
  try {
    if (readFileSync(marker, 'utf8') === snapshot.digest) return;
  } catch {}
  if (snapshot.base) {
    const result = gitResultSync(destination, ['rev-parse', 'HEAD']);
    if (result.status !== 0 || result.stdout.toString().trim() !== snapshot.base.commit)
      throw new Error('Task checkpoint base does not match the prepared workspace');
  }
  applySnapshot(snapshot, destination, true);
  writeFileSync(marker, snapshot.digest, { mode: 0o600 });
}
