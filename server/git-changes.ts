import { resolve, join } from 'node:path';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';

// Kept independent of the workspace DB: workers use the same Git helpers without loading views.
const listeners = new Set<(repository: string) => void>();
export function onRepositoryChange(listener: (repository: string) => void) {
  listeners.add(listener);
}
/** Worktrees and symlinked paths share refs; HEAD still belongs to each view's own cwd. */
export function repositoryIdentity(repository: string) {
  let directory = resolve(repository);
  try {
    const dotGit = join(directory, '.git');
    directory = statSync(dotGit).isDirectory()
      ? dotGit
      : resolve(
          directory,
          readFileSync(dotGit, 'utf8')
            .replace(/^gitdir: /, '')
            .trim(),
        );
  } catch {
    /* Bare or unavailable repository. */
  }
  try {
    directory = resolve(directory, readFileSync(join(directory, 'commondir'), 'utf8').trim());
  } catch {
    /* Main checkout or bare repository. */
  }
  try {
    return realpathSync(directory);
  } catch {
    return directory;
  }
}
/**
 * Where Git keeps refs, as modification times. Any process that moves, adds or deletes a ref
 * rewrites one of these, so a changed fingerprint means the refs changed, without starting Git.
 * This is what lets a view notice a push or a sync done by another process at once.
 */
export function refsFingerprint(repository: string) {
  const directory = repositoryIdentity(repository);
  const stamp = (path: string) => {
    try {
      const stat = statSync(path);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return '-';
    }
  };
  const parts = [stamp(join(directory, 'packed-refs')), stamp(join(directory, 'HEAD'))];
  const walk = (path: string, depth: number) => {
    parts.push(stamp(path));
    if (depth >= 4) return;
    try {
      for (const entry of readdirSync(path, { withFileTypes: true }))
        if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
    } catch {
      /* No loose refs here. */
    }
  };
  walk(join(directory, 'refs'), 0);
  return parts.join('|');
}
const fingerprints = new Map<string, string>();
/** Tell the views when a repository's refs were changed by anything, including other processes. */
export function noticeRepositoryChange(repository: string) {
  const identity = repositoryIdentity(repository);
  const print = refsFingerprint(repository);
  if (fingerprints.get(identity) === print) return;
  if (fingerprints.size > 1024) fingerprints.clear();
  fingerprints.set(identity, print);
  for (const listener of listeners) listener(identity);
}
export function repositoryChanged(repository: string) {
  if (!listeners.size) return;
  const identity = repositoryIdentity(repository);
  for (const listener of listeners) listener(identity);
}

const writes = new Set([
  'update-ref',
  'fetch',
  'pull',
  'push',
  'commit',
  'merge',
  'reset',
  'checkout',
  'switch',
  'branch',
  'tag',
  'init',
  'clone',
  'receive-pack',
  'worktree',
]);

/** A failed command may still have moved some refs. Invalidate before and after it runs. */
export function observeGitWrite(repository: string, args: string[]) {
  let offset = 0;
  while (args[offset]?.startsWith('-')) {
    offset += ['-c', '-C', '--git-dir', '--work-tree'].includes(args[offset]) ? 2 : 1;
  }
  const command = args[offset];
  const commandArgs = args.slice(offset + 1);
  const symbolicWrite =
    command === 'symbolic-ref' &&
    (commandArgs.includes('--delete') ||
      commandArgs.includes('-d') ||
      commandArgs.filter((arg) => !arg.startsWith('-')).length > 1);
  if (!writes.has(command) && !symbolicWrite) return () => {};
  repositoryChanged(repository);
  return () => repositoryChanged(repository);
}
