import { recordCheckpointBase } from './checkpoint.ts';
import { gitText } from '../../workspace/repository-git.ts';

const refreshing = new Map<string, Promise<boolean>>();

/** Worker-only metadata update. Never check out, reset, clean, or overwrite working files. */
export async function refreshCommitBaseline(
  cwd: string,
  task: any,
  repository: string,
  authentication?: { origin: string; header: string },
) {
  const previous = refreshing.get(cwd);
  const pending = (previous || Promise.resolve(false))
    .catch(() => false)
    .then(() => installBaseline(cwd, task, repository, authentication));
  refreshing.set(cwd, pending);
  try {
    return await pending;
  } finally {
    if (refreshing.get(cwd) === pending) refreshing.delete(cwd);
  }
}

async function installBaseline(
  cwd: string,
  task: any,
  repository: string,
  authentication?: { origin: string; header: string },
) {
  const baseline = task.workspaceCommit;
  if (!baseline) return false;
  const receipt = `refs/deploy/checkpoint-baseline/${task.id}`;
  const installed = await gitText(cwd, ['rev-parse', '--verify', '--quiet', receipt]).catch(
    () => '',
  );
  // Later checkpoints are a delta over the baseline, so the marker follows it even when the
  // refs are already in place (a workspace prepared before delta checkpoints existed).
  if (installed === baseline.commit) {
    recordCheckpointBase(cwd, baseline.commit);
    return false;
  }
  await gitText(cwd, ['fetch', '--no-tags', '--no-write-fetch-head', repository, baseline.commit], {
    authentication,
  });
  // Use the private workspace branch, not the hosted branch (local worktrees share refs).
  const branch = `refs/heads/task/${task.id}${task.workspaceGeneration ? '-' + task.workspaceGeneration : ''}`;
  await gitText(cwd, ['update-ref', branch, baseline.commit]);
  await gitText(cwd, ['symbolic-ref', 'HEAD', branch]);
  await gitText(cwd, ['read-tree', baseline.commit]);
  await gitText(cwd, ['update-ref', receipt, baseline.commit]);
  recordCheckpointBase(cwd, baseline.commit);
  return true;
}
