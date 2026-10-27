import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { refreshCommitBaseline } from './commit-baseline.ts';
import { gitEnvironment, gitText } from './repository-git.ts';
import { patchDigest } from './review.ts';
import { event, get, list, now, save } from './store.ts';
import type { Snapshot } from './checkpoint.ts';

// A task is a conversation: once its pull request merges, later work in the same task is
// published as a new pull request built on what the target branch already contains.

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};

/** The deterministic hosted branch for a task; follow-ups may add a `-<n>` suffix. */
export const taskBranch = (taskId: string) => `task/${taskId.replaceAll('-', '').slice(0, 8)}`;

/** Whether `branch` is the task's own hosted branch or one of its follow-up branches. */
export const isTaskBranch = (taskId: string, branch: unknown) =>
  typeof branch === 'string' &&
  (branch === taskBranch(taskId) || new RegExp(`^${taskBranch(taskId)}-\\d+$`).test(branch));

/** The branch a task's next publication or deploy_commit continues by default. */
export const currentTaskBranch = (task: any) =>
  isTaskBranch(task.id, task.workspaceCommit?.branch)
    ? task.workspaceCommit.branch
    : taskBranch(task.id);

/** The commit the task's own work is based on, and therefore the tree a new commit replaces. */
export const taskBaseline = (task: any) =>
  task.pendingMergeCommit ||
  task.publishedCommit ||
  task.workspaceCommit?.commit ||
  task.baseRevision;

/**
 * The parent of the task's next commit, shared by deploy_commit and publish.
 *
 * A follow-up after a merge builds on the target head it was placed on; an existing task branch
 * continues from its own tip; a branch that does not exist yet starts from the task's own
 * baseline. Starting a new branch from the current `main` tip instead would make every open task
 * unpublishable the moment anyone pushes to main, because its first commit would replace main's
 * newer tree. Branching from the baseline keeps the task's commit a clean delta over what it
 * actually worked from, and its pull request merges into the newer main like any other branch.
 */
export const commitParent = (task: any, head: string, placement?: { parent: string } | null) =>
  task.pendingMergeCommit && (!head || head === task.publishedCommit)
    ? task.pendingMergeCommit
    : placement?.parent || head || taskBaseline(task);

export function linkedPulls(owner: string, task: any) {
  return list('pull-request', owner).filter(
    (pull) => pull.projectId === task.projectId && pull.taskIds?.includes(task.id),
  );
}

/** The merged pull request that already contains the task's latest publication, if any.
 * Then the next publication is a follow-up: a new pull request, not an update of a merged one. */
export function mergedPublication(owner: string, task: any, pulls = linkedPulls(owner, task)) {
  if (!task.publishedCommit) return null;
  return (
    pulls
      .filter((pull) => pull.status === 'merged' && pull.mergedCommit === task.publishedCommit)
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
      .at(-1) ?? null
  );
}

const isAncestor = (repo: string, ancestor: string, descendant: string) =>
  gitText(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).then(
    () => true,
    () => false,
  );

/**
 * Where follow-up work after a merge goes. The commit builds on the target head, so the new
 * pull request fast-forwards. The task branch is reused when it is gone or already contained in
 * the target (the normal state after a fast-forward merge): moving it forward loses nothing,
 * and the merged pull request keeps its own recorded commits. A task branch that gained commits
 * the target lacks is never rewritten; the follow-up then uses the first free `task/<id>-<n>`.
 */
export async function followUpPlacement(repo: string, task: any, merged: any) {
  const targetBranch = merged.targetBranch || 'main';
  const target = await gitText(repo, ['rev-parse', '--verify', `refs/heads/${targetBranch}`]).catch(
    () => '',
  );
  if (!target || !(await isAncestor(repo, merged.mergedCommit, target)))
    conflict(
      `${targetBranch} no longer contains pull request #${merged.number}, so follow-up work has no merged base to build on. Restore ${targetBranch} to a commit that contains #${merged.number}, or start a new task from its current tip and redo this work there.`,
    );
  for (let n = 1; n <= 50; n++) {
    const branch = n === 1 ? taskBranch(task.id) : `${taskBranch(task.id)}-${n}`;
    const head = await gitText(repo, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${branch}`,
    ]).catch(() => '');
    if (!head || (await isAncestor(repo, head, target)))
      return { branch, head, parent: target, targetBranch };
  }
  return conflict('Every follow-up branch for this task has unmerged commits; merge or delete one');
}

/**
 * When a pull request merges the task's latest publication, the merged commit becomes the
 * task's diff base: "All changes" then shows only work that is not in the target yet. Workers
 * install it like a deploy_commit baseline (metadata only, never working files).
 *
 * The merged source head is the baseline even when the target landed on a merge commit: the
 * worker may not overwrite working files, so adopting the merge commit instead would report the
 * target's other changes as deletions this workspace is about to make. Follow-up work in the
 * task is then refused by the moved-target guard, which names what the owner can do.
 */
export function adoptMergedBaseline(owner: string, pull: any) {
  if (pull?.status !== 'merged' || !pull.mergedCommit) return [];
  const adopted: any[] = [];
  for (const taskId of pull.taskIds ?? []) {
    let task;
    try {
      task = get('task', owner, taskId);
    } catch {
      continue;
    }
    if (task.publishedCommit !== pull.mergedCommit || task.baseRevision === pull.mergedCommit)
      continue;
    const saved = save('task', owner, {
      ...task,
      baseRevision: pull.mergedCommit,
      publishedPatchDigest: patchDigest(pull.mergedCommit, ''),
      workspaceCommit: { commit: pull.mergedCommit, branch: pull.sourceBranch, pullId: pull.id },
      revision: task.revision + 1,
      updatedAt: now(),
    });
    event(owner, taskId, null, 'task.baseline', { commit: pull.mergedCommit, pullId: pull.id });
    adopted.push(saved);
  }
  return adopted;
}

/** Local workspaces share the coordinator's disk, so install the merged baseline right away. */
export async function refreshLocalBaselines(tasks: any[], repo: string) {
  for (const task of tasks)
    if ((!task.workerId || task.workerId === 'local') && task.workspacePath)
      await refreshCommitBaseline(task.workspacePath, task, repo).catch(() => false);
}

const changedCounts = new Map<string, number>();

/** Path to `mode object` for every blob in a commit, or null when the commit is unknown. */
function treeEntries(repo: string, commit: string) {
  const listing = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'ls-tree', '-r', '-z', '--full-tree', commit],
    { env: gitEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10000 },
  );
  if (listing.status !== 0) return null;
  const tree = new Map<string, string>();
  for (const entry of listing.stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, , object] = entry.slice(0, tab).split(' ');
    tree.set(entry.slice(tab + 1), `${mode} ${object}`);
  }
  return tree;
}

/** How many files a checkpoint changes relative to a commit, computed on the coordinator so it
 * is right even when the task computer has not refreshed its baseline. Works for both shapes:
 * a delta checkpoint is first materialized over its own base tree. */
export function checkpointChangedFileCount(
  repo: string,
  checkpointId: string,
  snapshot: Snapshot,
  base: string,
) {
  const key = `${repo}\0${checkpointId}\0${base}`;
  if (changedCounts.has(key)) return changedCounts.get(key)!;
  let count: number | null = null;
  const tree = treeEntries(repo, base);
  const checkpointTree = snapshot.base ? treeEntries(repo, snapshot.base.commit) : new Map();
  if (tree && checkpointTree) {
    const algorithm = base.length === 64 ? 'sha256' : 'sha1';
    for (const path of snapshot.deleted ?? []) checkpointTree.delete(path);
    for (const file of snapshot.files) {
      const bytes = Buffer.from(file.content, 'base64');
      const blob = createHash(algorithm)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      checkpointTree.set(file.path, `${file.executable ? '100755' : '100644'} ${blob}`);
    }
    count = 0;
    for (const [path, entry] of checkpointTree) if (tree.get(path) !== entry) count++;
    for (const path of tree.keys()) if (!checkpointTree.has(path)) count++;
  }
  // A failed listing (for example an unknown base) is retried on the next read.
  if (count === null) return null;
  if (changedCounts.size > 500) changedCounts.delete(changedCounts.keys().next().value!);
  changedCounts.set(key, count);
  return count;
}
