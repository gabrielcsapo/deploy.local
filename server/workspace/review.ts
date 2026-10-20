import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve, basename } from 'node:path';
function readGit(cwd: string, args: string[], raw = false) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(r.stderr || 'Git review failed');
  return raw ? r.stdout : r.stdout.trimEnd();
}
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
  const files = entries
    .filter((e) => e.length > 3)
    .map((e) => ({ status: e.slice(0, 2), path: e.slice(3) }));
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
      const r = spawnSync(
        'git',
        [
          '-C',
          cwd,
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
          encoding: 'utf8',
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
