import { gitResultSync, gitStringSync } from '../../kernel/git.ts';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  filePatchLimit,
  privateReviewPath,
  reviewFilePath,
  untrackedReviewLimit,
  type FilePatch,
} from '../../workspace/review.ts';

const git = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  gitStringSync(cwd, args, {
    literalPathspecs: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30000,
    env: { ...process.env, ...env },
    input,
    fallback: 'Git checkpoint failed',
    trim: 'none',
  });

/**
 * Record the workspace as a Git tree without touching its index, HEAD or refs.
 * Untracked files follow the review rules: credential-like and oversized files stay out.
 */
export function captureTurnCheckpoint(cwd: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-turn-'));
  const env = { GIT_INDEX_FILE: join(directory, 'index') };
  try {
    // Start from the real index so unchanged files keep their stat cache and are not rehashed.
    const index = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']).trim());
    if (existsSync(index)) copyFileSync(index, env.GIT_INDEX_FILE);
    else git(cwd, ['read-tree', 'HEAD'], env);
    git(cwd, ['add', '-u'], env);
    const untracked = git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], env)
      .split('\0')
      .filter((path) => {
        if (!path || privateReviewPath(path)) return false;
        try {
          const stat = lstatSync(resolve(cwd, path));
          return stat.isFile() && stat.size <= untrackedReviewLimit;
        } catch {
          return false;
        }
      });
    if (untracked.length)
      git(cwd, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], env, untracked.join('\0'));
    return git(cwd, ['write-tree'], env).trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export const checkpointId = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;

function requireCheckpoints(cwd: string, trees: string[]) {
  for (const tree of trees)
    if (
      !checkpointId(tree) ||
      gitResultSync(cwd, ['cat-file', '-e', `${tree}^{tree}`]).status !== 0
    )
      throw Object.assign(new Error('Checkpoint is no longer available'), { code: 'missing' });
}

/** One file's complete patch between two checkpoints, for the turn scope of a review. */
export function turnFilePatch(
  cwd: string,
  from: string,
  to: string,
  path: string,
  limit = filePatchLimit,
): FilePatch {
  const file = reviewFilePath(path);
  requireCheckpoints(cwd, [from, to]);
  const patch = git(cwd, ['diff', '--no-renames', '--no-ext-diff', from, to, '--', file]);
  return {
    path: file,
    patch: patch.slice(0, limit),
    bytes: Buffer.byteLength(patch),
    truncated: patch.length > limit,
  };
}

/** The patch and file list between two checkpoints, shaped like the task review diff. */
export function diffTurnCheckpoints(cwd: string, from: string, to: string, limit = 512000) {
  requireCheckpoints(cwd, [from, to]);
  const patch = git(cwd, ['diff', '--no-renames', '--no-ext-diff', from, to]);
  const names = git(cwd, ['diff', '--no-renames', '--name-status', '-z', from, to])
    .split('\0')
    .filter(Boolean);
  const files: { status: string; path: string }[] = [];
  for (let i = 0; i + 1 < names.length; i += 2)
    files.push({ status: names[i] === 'T' ? 'M' : names[i], path: names[i + 1] });
  return {
    baseRevision: from,
    headRevision: to,
    patch: patch.slice(0, limit),
    truncated: patch.length > limit,
    status: files.length ? '' : 'This turn made no file changes.',
    files,
    excluded: [],
  };
}
