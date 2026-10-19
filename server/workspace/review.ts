import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve, basename } from 'node:path';
function readGit(cwd: string, args: string[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(r.stderr || 'Git review failed');
  return r.stdout.trimEnd();
}
export function inspectWorkspace(cwd: string, baseRevision: string, limit = 512000) {
  // readGit trims output; keep every section newline-terminated so the patch applies.
  const tracked = readGit(cwd, ['diff', baseRevision, '--']);
  let patch = tracked ? tracked + '\n' : '',
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
    const name = basename(file.path);
    if (
      (/^\.env(?:\.|$)/.test(name) && !/(example|sample|template)$/.test(name)) ||
      /\.(pem|key)$/.test(name) ||
      /^id_(rsa|ed25519)$/.test(name)
    ) {
      excluded.push(file.path);
      continue;
    }
    const path = resolve(cwd, file.path);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > 256000) {
        excluded.push(file.path);
        continue;
      }
      const r = spawnSync('git', ['-C', cwd, 'diff', '--no-index', '--', '/dev/null', file.path], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5000,
      });
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
