import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { activeCheck } from './checks.ts';
import { cleanupTaskCheckpointRefs } from './checkpoint-retention.ts';
import { deleteAttachment } from './attachments.ts';
import { linkedPulls } from './follow-up.ts';
import { gitSync } from './repository-git.ts';
import {
  db,
  event,
  get,
  list,
  listCheckpointMetadata,
  now,
  remove,
  revise,
  root,
  save,
} from './store.ts';

// Deleting a task is permanent: its conversation (messages, events, work log), its saved
// checkpoints and its branches go, and an open pull request for it is closed. Merged work,
// pull request history and releases stay.

/** Records that outlive the task: shipped or merged history, and design reviews. */
const kept = (kind: string) =>
  [
    'task',
    'checkpoint',
    'pull-request',
    'issue',
    'project-comment',
    'application-deployment',
    'pipeline-run',
    'v2-release',
    'v2-rollback',
    'v2-upload-release',
  ].includes(kind) || kind.startsWith('design-');

const busy = () => Object.assign(new Error('Stop the task before deleting it'), { status: 409 });

/** The same guard as closing a task, plus the background work that would read a missing task. */
function assertIdle(owner: string, task: any) {
  const active = (status: string) => ['queued', 'starting', 'running', 'unknown'].includes(status);
  if (
    list('run', owner).some((run) => run.taskId === task.id && active(run.status)) ||
    activeCheck(owner, task.id) ||
    list('job', owner).some((job) => job.taskId === task.id && active(job.status)) ||
    list('repository-operation', owner).some(
      (operation) => operation.taskId === task.id && active(operation.status),
    ) ||
    (task.baseUpdate && ['queued', 'preparing'].includes(task.baseUpdate.status))
  )
    throw busy();
}

/** Whether the task's delete is refused right now; the menus leave the item out then. */
export function taskRunning(owner: string, task: any) {
  try {
    assertIdle(owner, task);
    return false;
  } catch {
    return true;
  }
}

function repository(owner: string, task: any): string | null {
  if (!task.projectId) return null;
  try {
    return get('project', owner, task.projectId).repositoryPath || null;
  } catch {
    return null;
  }
}

/** The branch the task's work is saved on, as the task page names it. */
const shownBranch = (task: any): string | null =>
  task.workspaceCommit?.branch || task.publishedBranch || null;

const commitOf = (repo: string, ref: string) =>
  gitSync(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);

/**
 * Every ref the task owns in its project repository: its hosted branches (`task/<id8>` and
 * follow-ups), the branch its coordinator workspace checked out (`task/<id>`, per generation)
 * and its source baseline ref. A branch a merged pull request came from stays with that history.
 */
function ownedRefs(owner: string, repo: string, task: any) {
  const short = task.id.replaceAll('-', '').slice(0, 8);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const owned = new RegExp(
    `^refs/heads/task/(?:${escape(short)}|${escape(task.id)})(?:-\\d+)?$|^refs/deploy/tasks/${escape(task.id)}$`,
  );
  const merged = new Set(
    linkedPulls(owner, task)
      .filter((pull) => pull.status === 'merged' && pull.sourceBranch)
      .map((pull) => `refs/heads/${pull.sourceBranch}`),
  );
  const output = gitSync(repo, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/heads/task/',
    'refs/deploy/tasks/',
  ]);
  return (output || '')
    .split('\n')
    .map((line) => line.split(' '))
    .filter(([ref, commit]) => ref && commit && owned.test(ref) && !merged.has(ref))
    .map(([ref, commit]) => ({ ref, commit }));
}

export type TaskDeletion = {
  id: string;
  title: string;
  /** Null when the task has no branch in its project repository. */
  branch: string | null;
  /** Commits on that branch that are not on the project's default branch. */
  unmergedCommits: number;
  /** A running task cannot be deleted; stop it first. */
  running: boolean;
};

/** What deleting the task removes, for the confirmation. */
export function taskDeletion(owner: string, taskId: string): TaskDeletion {
  const task = get('task', owner, taskId);
  const repo = repository(owner, task);
  const named = shownBranch(task);
  const branch = repo && named && commitOf(repo, `refs/heads/${named}`) ? named : null;
  let unmergedCommits = 0;
  if (repo && branch) {
    const target = get('project', owner, task.projectId).defaultBranch || 'main';
    const count = commitOf(repo, `refs/heads/${target}`)
      ? gitSync(repo, [
          'rev-list',
          '--count',
          `refs/heads/${branch}`,
          '--not',
          `refs/heads/${target}`,
        ])
      : gitSync(repo, ['rev-list', '--count', `refs/heads/${branch}`]);
    unmergedCommits = Number(count) || 0;
  }
  return {
    id: task.id,
    title: task.title,
    branch,
    unmergedCommits,
    running: taskRunning(owner, task),
  };
}

/** Permanently delete a task. The caller owns the command transaction. */
export function deleteTask(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  assertIdle(owner, task);
  const repo = repository(owner, task);
  const open = linkedPulls(owner, task).filter((pull) => pull.status === 'open');
  for (const pull of open)
    if (
      pull.mergeOperationId &&
      ['queued', 'running', 'unknown'].includes(
        get('repository-operation', owner, pull.mergeOperationId).status,
      )
    )
      throw Object.assign(new Error('A merge is active; wait for it before deleting the task'), {
        status: 409,
      });

  // An open pull request is closed like the Close pull request command does, with the commits
  // it pointed at recorded before its branch goes.
  for (const pull of open) {
    const commits = repo
      ? {
          closedBaseCommit: commitOf(repo, `refs/heads/${pull.targetBranch}`) ?? undefined,
          closedHeadCommit: commitOf(repo, `refs/heads/${pull.sourceBranch}`) ?? undefined,
        }
      : {};
    save('pull-request', owner, {
      ...pull,
      status: 'closed',
      closedBy: owner,
      closedAt: now(),
      ...commits,
      revision: pull.revision + 1,
      updatedAt: now(),
    });
  }

  // Without its task, retention no longer protects the task's checkpoint refs.
  remove('task', owner, taskId);
  cleanupTaskCheckpointRefs(owner, taskId);
  const released = new Set(
    list('application-deployment', owner).map((deployment) => deployment.checkpointId),
  );
  for (const checkpoint of listCheckpointMetadata(owner, taskId))
    if (!released.has(checkpoint.id)) remove('checkpoint', owner, checkpoint.id);

  // The conversation and everything recorded for it: runs, messages, questions, checks, jobs,
  // attachments, queued follow-ups, uploaded diffs and Waiting on you items.
  const runIds = list('run', owner)
    .filter((run) => run.taskId === taskId)
    .map((run) => run.id);
  const rows = db
    .prepare(
      `SELECT kind, id FROM records WHERE owner=? AND (
        json_extract(data,'$.taskId')=? OR json_extract(data,'$.item.taskId')=? OR id=?
        ${runIds.length ? `OR id IN (${runIds.map(() => '?').join(',')})` : ''})`,
    )
    .all(owner, taskId, taskId, taskId, ...runIds) as { kind: string; id: string }[];
  for (const row of rows) {
    if (kept(row.kind)) continue;
    if (row.kind === 'attachment') deleteAttachment(owner, row.id);
    else remove(row.kind, owner, row.id);
  }
  db.prepare('DELETE FROM events WHERE owner=? AND taskId=?').run(owner, taskId);

  // Compare-and-delete, so a ref another writer just moved is left alone.
  if (repo)
    for (const { ref, commit } of ownedRefs(owner, repo, task))
      gitSync(repo, ['update-ref', '-d', ref, commit]);

  event(owner, taskId, null, 'task.deleted', { id: taskId });
  const workspace = task.workspacePath;
  if (workspace && (!task.workerId || task.workerId === 'local'))
    setImmediate(() => removeWorkspace(owner, taskId, workspace, repo, task.workspaceGeneration));
  return { id: taskId, deleted: true };
}

/** The coordinator's working copy goes once the delete has committed. */
function removeWorkspace(
  owner: string,
  taskId: string,
  workspace: string,
  repo: string | null,
  generation?: number | string,
) {
  try {
    get('task', owner, taskId);
    return; // The surrounding transaction rolled back.
  } catch {
    // Deleted.
  }
  const tasks = resolve(root, 'tasks') + sep;
  if (!resolve(workspace).startsWith(tasks)) return;
  try {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(
      resolve(root, 'workspace-ready', `${taskId}${generation ? '-' + generation : ''}.json`),
      { force: true },
    );
    if (repo) gitSync(repo, ['worktree', 'prune']);
  } catch (error) {
    console.error('Task workspace cleanup:', (error as Error).message);
  }
}
