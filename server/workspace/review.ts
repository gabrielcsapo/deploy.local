import { gitResultSync, gitStringSync } from '../kernel/git.ts';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { resolve, basename } from 'node:path';
const readGit = (cwd: string, args: string[], raw = false) =>
  gitStringSync(cwd, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
    fallback: 'Git review failed',
    trim: raw ? 'none' : 'end',
  });
export const patchDigest = (base: string, patch: string) =>
  createHash('sha256').update(base).update('\0').update(patch).digest('hex');

/** Credential-like untracked files never leave the workspace in a review or turn checkpoint. */
export function privateReviewPath(path: string) {
  const name = basename(path);
  return (
    (/^\.env(?:\.|$)/.test(name) && !/(example|sample|template)$/.test(name)) ||
    /\.(pem|key)$/.test(name) ||
    /^id_(rsa|ed25519)$/.test(name)
  );
}
export const untrackedReviewLimit = 256000;
/** The summary patch a task review loads first; one file's full patch is fetched on demand. */
export const summaryPatchLimit = 50000;
/** One file's complete patch. Past this a reviewer downloads the patch or opens the file. */
export const filePatchLimit = 2 * 1024 * 1024;
/** The whole change as one downloadable patch, and the budget for an uploaded per-file bundle. */
export const fullPatchLimit = 4 * 1024 * 1024;
export function inspectWorkspace(cwd: string, baseRevision: string, limit = 512000) {
  // Preserve patch bytes, including blank context lines, so the patch applies exactly.
  const tracked = readGit(
    cwd,
    ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', baseRevision, '--'],
    true,
  );
  let patch = tracked,
    truncated = false;
  // List files inside new directories individually; otherwise `apple/` hides its contents.
  const entries = readGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    .split('\0')
    .filter(Boolean);
  const workspaceFiles = entries
    .filter((e) => e.length > 3)
    .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }));
  // HEAD can be an internal merge/checkpoint commit. Review paths must follow the task's
  // target baseline, including task changes already present in HEAD.
  const changed = readGit(cwd, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    baseRevision,
    '--',
  ]).split('\0');
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < changed.length; i += 2) {
    if (changed[i + 1]) files.push({ status: changed[i].slice(0, 1) + ' ', path: changed[i + 1] });
  }
  for (const file of workspaceFiles)
    if (file.status === '??' && !files.some((f) => f.path === file.path)) files.push(file);
  const excluded: string[] = [];
  for (const file of files.filter((f) => f.status === '??')) {
    if (privateReviewPath(file.path)) {
      excluded.push(file.path);
      continue;
    }
    const path = resolve(cwd, file.path);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > untrackedReviewLimit) {
        excluded.push(file.path);
        continue;
      }
      const r = gitResultSync(
        cwd,
        [
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-index',
          '--',
          '/dev/null',
          file.path,
        ],
        {
          maxBuffer: 1024 * 1024,
          timeout: 5000,
        },
      );
      if (r.status === 1) patch += r.stdout.endsWith('\n') ? r.stdout : r.stdout + '\n';
    } catch {
      excluded.push(file.path);
    }
    if (patch.length > limit) {
      truncated = true;
      break;
    }
  }
  return {
    baseRevision,
    headRevision: readGit(cwd, ['rev-parse', 'HEAD']),
    patch: patch.slice(0, limit),
    truncated: truncated || patch.length > limit,
    status: readGit(cwd, ['status', '--short']),
    files,
    excluded,
    checks: [],
  };
}

export interface FilePatch {
  path: string;
  patch: string;
  /** Bytes of the complete patch, even when `patch` holds only the first `limit` of them. */
  bytes: number;
  truncated: boolean;
}

/** A changed path a review can ask for, rejecting traversal and `.git` before Git sees it. */
export function reviewFilePath(path: string) {
  const value = (path || '').replace(/\/+$/, '');
  const parts = value.split('/');
  if (!value || parts.some((part) => !part || part === '.' || part === '..' || part === '.git'))
    throw Object.assign(new Error('Invalid workspace path'), { status: 400 });
  if (privateReviewPath(value))
    throw Object.assign(new Error('Credential-like files are never shown in a review'), {
      status: 403,
    });
  return value;
}

/**
 * One file's complete patch against the task's base revision, so a change larger than the
 * summary patch can still be reviewed file by file. An untracked file has no diff against the
 * base revision, so it is compared with `/dev/null` the way the summary patch does; a tracked
 * file with no changes keeps its empty patch rather than reading as newly added.
 */
export function workspaceFilePatch(
  cwd: string,
  baseRevision: string,
  path: string,
  limit = filePatchLimit,
): FilePatch {
  const file = reviewFilePath(path);
  const args = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv'];
  let patch = readGit(cwd, [...args, baseRevision, '--', file], true);
  if (!patch && !readGit(cwd, ['ls-files', '--', file])) {
    const r = gitResultSync(cwd, [...args, '--no-index', '--', '/dev/null', file], {
      maxBuffer: limit + 1024 * 1024,
      timeout: 30000,
    });
    if (r.status === 1) patch = r.stdout;
  }
  return {
    path: file,
    patch: patch.slice(0, limit),
    bytes: Buffer.byteLength(patch),
    truncated: patch.length > limit,
  };
}

/**
 * Every changed file's patch, bounded per file and in total. Workers upload this once a turn
 * ends so the coordinator, which cannot read another computer's workspace, can still serve a
 * file's full patch and the whole-change download.
 */
export function workspaceFilePatches(
  cwd: string,
  baseRevision: string,
  files: { status: string; path: string }[],
  patch: (path: string) => FilePatch = (path) => workspaceFilePatch(cwd, baseRevision, path),
) {
  const patches: FilePatch[] = [];
  let total = 0,
    truncated = false;
  for (const path of changedPaths(files)) {
    if (total >= fullPatchLimit) {
      truncated = true;
      break;
    }
    let file: FilePatch;
    try {
      file = patch(path);
    } catch {
      truncated = true;
      continue;
    }
    patches.push(file);
    total += file.patch.length;
    truncated ||= file.truncated;
  }
  return { patches, truncated };
}

/** Porcelain status lists renames as `old -> new`; the new path is the one with a patch. */
export function changedPaths(files: { status: string; path: string }[]) {
  const paths: string[] = [];
  for (const file of files || []) {
    const named = file.status?.includes('R') ? file.path.split(' -> ').at(-1)! : file.path;
    try {
      const path = reviewFilePath(named);
      if (!paths.includes(path)) paths.push(path);
    } catch {
      /* Credential-like and malformed paths never get a patch. */
    }
  }
  return paths;
}

/** The whole change as one patch, for "Download patch". */
export function workspacePatch(cwd: string, baseRevision: string, limit = fullPatchLimit) {
  const { patch, truncated, excluded } = inspectWorkspace(cwd, baseRevision, limit);
  return { patch, truncated, excluded, bytes: Buffer.byteLength(patch) };
}

/** One patch file assembled from uploaded per-file patches, in the review's file order. */
export function joinFilePatches(patches: FilePatch[], limit = fullPatchLimit) {
  let patch = '';
  let truncated = false;
  for (const file of patches) {
    if (patch.length + file.patch.length > limit) {
      truncated = true;
      break;
    }
    patch += file.patch.endsWith('\n') || !file.patch ? file.patch : file.patch + '\n';
    truncated ||= file.truncated;
  }
  return { patch, truncated, bytes: Buffer.byteLength(patch) };
}
