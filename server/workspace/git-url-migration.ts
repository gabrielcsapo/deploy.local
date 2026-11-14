import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

// Git remote rewrite: old stored addresses are input data only, never served routes.
const oldGitPath = '/api/workspace/git/';
export function rewriteManagedGitUrl(
  value: string,
  origins: readonly string[],
  relativeAssignment = false,
): string {
  if (relativeAssignment && value.startsWith(oldGitPath))
    return '/api/git/' + value.slice(oldGitPath.length);
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !origins.includes(url.origin) ||
      !url.pathname.startsWith(oldGitPath)
    )
      return value;
    return value.replace(oldGitPath, '/api/git/');
  } catch {
    return value;
  }
}

/** Preserve credentials, comments, duplicate push URLs and unrelated remotes verbatim. */
export function rewriteManagedGitConfig(config: string, origins: readonly string[]): string {
  let section = '',
    remote = '';
  return config
    .split(/(?<=\n)/)
    .map((line) => {
      const header = line.match(/^\s*\[\s*([\w.-]+)(?:\s+"([^"]*)")?\s*\]/);
      if (header) {
        section = header[1].toLowerCase();
        remote = header[2] || '';
        return line;
      }
      const entry = line.match(/^(\s*([\w.-]+)\s*=\s*)("(?:[^"\\]|\\.)*"|[^\s#;]+)(.*)$/s);
      if (!entry) return line;
      const key = entry[2].toLowerCase();
      if (
        !(
          (section === 'remote' &&
            ((key === 'url' && remote === 'origin') ||
              ['pushurl', 'lfsurl', 'lfspushurl'].includes(key))) ||
          (section === 'lfs' && ['url', 'pushurl'].includes(key))
        )
      )
        return line;
      const quoted = entry[3].startsWith('"');
      const value = quoted ? entry[3].slice(1, -1) : entry[3];
      const updated = rewriteManagedGitUrl(value, origins);
      return updated === value
        ? line
        : entry[1] + (quoted ? '"' + updated + '"' : updated) + entry[4];
    })
    .join('');
}

/** Scan only managed storage, never symlinks, external worktrees, or user source checkouts. */
export function migrateManagedGitCheckouts(
  root: string,
  origins: readonly string[],
  failed: string[] = [],
): string[] {
  if (!existsSync(root)) return [];
  const boundary = realpathSync(root),
    changed: string[] = [],
    visited = new Set<string>();
  const inside = (path: string) => {
    const rel = relative(boundary, path);
    return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
  };
  // One checkout that cannot be rewritten now (a config lock held by a running git, a file that
  // vanished) must not stop the rest or the server's start. It is reported and retried next start.
  const config = (file: string) => {
    try {
      rewrite(file);
    } catch {
      failed.push(file);
    }
  };
  const rewrite = (file: string) => {
    if (!existsSync(file)) return;
    const real = realpathSync(file);
    if (!inside(real) || visited.has(real)) return;
    visited.add(real);
    const before = readFileSync(real, 'utf8'),
      after = rewriteManagedGitConfig(before, origins);
    if (before === after) return;
    // Git's lock protocol: never overwrite a concurrent config writer.
    const lock = real + '.lock';
    const fd = openSync(lock, 'wx', statSync(real).mode);
    try {
      writeFileSync(fd, after);
      closeSync(fd);
      renameSync(lock, real);
    } catch (error) {
      try {
        closeSync(fd);
      } catch {}
      if (existsSync(lock)) unlinkSync(lock);
      throw error;
    }
    changed.push(real);
  };
  const gitDirectory = (path: string) => {
    if (!existsSync(path) || !inside(realpathSync(path))) return;
    config(resolve(path, 'config'));
    config(resolve(path, 'config.worktree'));
    const common = resolve(path, 'commondir');
    if (existsSync(common)) {
      const directory = resolve(path, readFileSync(common, 'utf8').trim());
      if (inside(directory)) config(resolve(directory, 'config'));
    }
  };
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name === '.git') {
        if (entry.isDirectory()) gitDirectory(path);
        else if (entry.isFile()) {
          const pointer = readFileSync(path, 'utf8').match(/^gitdir: (.+)\s*$/);
          if (pointer) gitDirectory(resolve(dirname(path), pointer[1]));
        }
      } else if (
        entry.isDirectory() &&
        !['node_modules', '.pnpm', 'objects', 'providers', 'agent-packages'].includes(entry.name)
      ) {
        if (existsSync(resolve(path, 'HEAD')) && existsSync(resolve(path, 'config')))
          gitDirectory(path);
        walk(path);
      } else if (entry.isFile() && entry.name === '.lfsconfig') config(path);
    }
  };
  walk(boundary);
  return changed;
}
