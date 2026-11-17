import { gitSync } from '../../workspace/repository-git.ts';

/**
 * A new project is seeded with an empty "Initialize project" commit, because tasks, design
 * and releases all start from a commit on the default branch. A person pushing a repository
 * they already have shares no history with that commit, so Git refuses the push as a
 * non-fast-forward before anything is sent.
 *
 * While a push runs against a repository that holds nothing but the placeholder, the
 * placeholder is set aside: HEAD keeps resolving through `refs/deploy/placeholder`, and the
 * default branch does not exist, so Git sees a branch to create. When the last such push ends,
 * either the branch now holds what was pushed and the placeholder is dropped, or the
 * placeholder goes back where it was.
 */
const PLACEHOLDER = 'refs/deploy/placeholder';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const pushing = new Map<string, number>();

/** Call before starting receive-pack; call the result exactly when it has exited. */
export function openFirstPush(repositoryPath: string, branch = 'main'): () => void {
  const held = pushing.get(repositoryPath) || 0;
  // A server that stopped mid-push leaves the placeholder aside; finish that first.
  if (!held && gitSync(repositoryPath, ['symbolic-ref', 'HEAD']) === PLACEHOLDER)
    settle(repositoryPath, branch);
  if (!held && !setAside(repositoryPath, branch)) return () => {};
  pushing.set(repositoryPath, held + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const left = pushing.get(repositoryPath)! - 1;
    if (left > 0) return void pushing.set(repositoryPath, left);
    pushing.delete(repositoryPath);
    settle(repositoryPath, branch);
  };
}

function setAside(repositoryPath: string, branch: string) {
  const main = `refs/heads/${branch}`;
  const refs = gitSync(repositoryPath, ['for-each-ref', '--format=%(refname) %(objectname)']);
  // Any other branch, tag or deploy.local ref means the project is already in use.
  if (!refs || refs.includes('\n')) return false;
  const [name, commit] = refs.split(' ');
  if (name !== main || gitSync(repositoryPath, ['symbolic-ref', 'HEAD']) !== main) return false;
  const seeded = gitSync(repositoryPath, ['log', '-1', '--format=%P|%T|%ae|%s', commit]);
  if (seeded !== `|${EMPTY_TREE}|workspace@deploy.local|Initialize project`) return false;
  if (
    gitSync(repositoryPath, ['update-ref', PLACEHOLDER, commit]) === null ||
    gitSync(repositoryPath, ['symbolic-ref', 'HEAD', PLACEHOLDER]) === null ||
    gitSync(repositoryPath, ['update-ref', '-d', main, commit]) === null
  ) {
    settle(repositoryPath, branch);
    return false;
  }
  return true;
}

function settle(repositoryPath: string, branch: string) {
  const main = `refs/heads/${branch}`;
  const placeholder = gitSync(repositoryPath, ['rev-parse', '-q', '--verify', PLACEHOLDER]);
  if (!placeholder) return;
  // Nothing arrived on the default branch: the project still needs its first commit.
  if (!gitSync(repositoryPath, ['rev-parse', '-q', '--verify', main]))
    gitSync(repositoryPath, ['update-ref', main, placeholder]);
  gitSync(repositoryPath, ['symbolic-ref', 'HEAD', main]);
  gitSync(repositoryPath, ['update-ref', '-d', PLACEHOLDER]);
}
