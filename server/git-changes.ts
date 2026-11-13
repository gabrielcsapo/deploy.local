import { resolve, join } from 'node:path';
import { readFileSync, realpathSync, statSync } from 'node:fs';

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
