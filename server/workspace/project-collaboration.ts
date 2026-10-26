import { cleanupTaskCheckpointRefs } from './checkpoint-retention.ts';
import { cancelTaskQuestions } from './question-lifecycle.ts';
import { queueTask } from './task-workspace.ts';
import { compileDeployYaml } from '../application-spec.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';
import { command, commandReplay, db, event, get, id, list, now, save } from './store.ts';
import { requireRepository, resolveCommit } from './repositories.ts';
import { gitText } from './repository-git.ts';
import { adoptMergedBaseline, refreshLocalBaselines } from './follow-up.ts';

const conflict = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
function text(value: unknown, field: string, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    throw new Error(
      `${field} must be ${required ? 'nonempty text' : 'text'} of at most ${max} characters`,
    );
  return required ? value.trim() : value;
}
function branch(value: unknown) {
  const name = text(value, 'Branch', 200, true);
  if (
    name.startsWith('-') ||
    name === '@' ||
    name.includes('..') ||
    name.includes('@{') ||
    [...name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /[\s~^:?*[\\]/.test(name) ||
    name
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new Error('Invalid branch name');
  return name;
}
function sha(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
    throw new Error('Expected a full Git commit ID');
  return value;
}
function kind(collection: string) {
  return collection === 'issues' ? 'issue' : 'pull-request';
}
function record(owner: string, projectId: string, collection: string, recordId: string) {
  get('project', owner, projectId);
  const row = get(kind(collection), owner, recordId);
  if (row.projectId !== projectId) throw Object.assign(new Error('Not found'), { status: 404 });
  return row;
}
function checkedRevision(row: any, input: any) {
  if (!Number.isInteger(input.revision) || row.revision !== input.revision)
    conflict('Record changed; refresh before retrying');
}
function linked(owner: string, projectId: string, type: string, values: unknown) {
  if (!Array.isArray(values) || values.length > 100 || values.some((v) => typeof v !== 'string'))
    throw new Error(`${type} links must be an array of at most 100 IDs`);
  return [...new Set(values)].map((value) => {
    const row = get(type, owner, value);
    if (row.projectId !== projectId) throw new Error(`Linked ${type} must belong to this project`);
    return value;
  });
}
function nextNumber(owner: string, projectId: string) {
  return (
    Math.max(
      0,
      ...['issue', 'pull-request'].flatMap((k) =>
        list(k, owner)
          .filter((r) => r.projectId === projectId)
          .map((r) => r.number),
      ),
    ) + 1
  );
}
const isAncestor = (repo: string, ancestor: string, descendant: string, runGit: typeof gitText) =>
  runGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant]).then(
    () => true,
    () => false,
  );

/**
 * The tree merging `head` into `base` produces, plus the paths that conflict.
 * `git merge-tree --write-tree` exits 1 when the merge conflicts, which is a result rather than
 * a failure, so that status is allowed and the conflicted-file section is parsed instead.
 */
export async function mergeTree(
  repo: string,
  base: string,
  head: string,
  runGit: typeof gitText,
): Promise<{ tree: string; conflicts: string[] }> {
  let output: string;
  try {
    output = await runGit(repo, ['merge-tree', '--write-tree', '--name-only', '-z', base, head], {
      allowStatus: [1],
    });
  } catch (error) {
    throw new Error(
      `Could not test-merge the branches: ${(error as Error).message}. Merging diverged branches needs Git 2.38 or newer on the coordinator.`,
      { cause: error },
    );
  }
  // `<tree> NUL` for a clean merge; conflicts add `<path> NUL ... NUL` before the messages.
  const fields = output.split('\0');
  const end = fields.indexOf('', 1);
  return {
    tree: fields[0],
    conflicts: [...new Set(fields.slice(1, end === -1 ? undefined : end).filter(Boolean))],
  };
}

const conflictReason = (pull: any, conflicts: string[]) => {
  const shown = conflicts.slice(0, 10);
  const rest = conflicts.length - shown.length;
  return `${pull.targetBranch} has moved and ${pull.sourceBranch} conflicts with it in ${shown.join(', ')}${
    rest > 0 ? ` and ${rest} more ${rest === 1 ? 'file' : 'files'}` : ''
  }. Ask the task to merge ${pull.targetBranch} into its branch and resolve those files, then merge again.`;
};

/** Whether the pull request's required pipeline checks have passed for `headCommit`. A manifest
 * that does not compile fails the merge, but must not break the read that explains mergeability. */
async function requiredChecksPassed(
  owner: string,
  project: any,
  headCommit: string,
  runGit: typeof gitText,
  onInvalidManifest: 'throw' | 'ignore',
) {
  const manifest = await runGit(project.repositoryPath, [
    'show',
    `${headCommit}:deploy.yaml`,
  ]).catch(() => null);
  if (manifest === null) return true;
  let pipeline;
  try {
    pipeline = compileDeployYaml(manifest).spec.pipeline;
  } catch (error) {
    if (onInvalidManifest === 'throw') throw error;
    return true;
  }
  if (!pipeline?.on.includes('pull_request')) return true;
  const check = list('pipeline-run', owner)
    .filter((run) => run.projectId === project.id && run.commit === headCommit)
    .at(-1);
  return check?.status === 'succeeded';
}

function mergeOperation(owner: string, pull: any) {
  return pull.mergeOperationId ? get('repository-operation', owner, pull.mergeOperationId) : null;
}
function editable(owner: string, pull: any) {
  if (['queued', 'running', 'unknown'].includes(mergeOperation(owner, pull)?.status))
    conflict('Merge is pending or needs recovery; inspect its operation first');
}

export async function collaborationRead(
  owner: string,
  projectId: string,
  collection: string,
  recordId?: string,
  action?: string,
  params = new URLSearchParams(),
) {
  get('project', owner, projectId);
  if (!recordId) {
    const status = params.get('status') || 'all';
    if (!['all', 'open', 'closed', ...(collection === 'pulls' ? ['merged'] : [])].includes(status))
      throw new Error('Invalid status');
    const before = Number(params.get('before') || Number.MAX_SAFE_INTEGER);
    const limit = Math.min(100, Math.max(1, Number(params.get('limit')) || 50));
    const rows = list(kind(collection), owner)
      .filter(
        (r) =>
          r.projectId === projectId &&
          r.number < before &&
          (status === 'all' || r.status === status),
      )
      .sort((a, b) => b.number - a.number);
    const items = rows.slice(0, limit);
    return { items, nextBefore: rows.length > limit ? items.at(-1)?.number : null };
  }
  const row = record(owner, projectId, collection, recordId);
  if (action === 'diff') {
    if (collection !== 'pulls') throw new Error('Only pull requests have diffs');
    if (row.status === 'merged' && (!row.mergedBaseCommit || !row.mergedCommit))
      conflict(
        'Historical diff unavailable: the imported pull request did not retain its merge commit IDs',
      );
    const project = requireRepository(owner, projectId);
    const [baseCommit, headCommit] =
      row.status === 'merged'
        ? [row.mergedBaseCommit, row.mergedCommit]
        : await Promise.all([
            resolveCommit(project.repositoryPath, `refs/heads/${row.targetBranch}`),
            resolveCommit(project.repositoryPath, `refs/heads/${row.sourceBranch}`),
          ]);
    const mergeBase = await gitText(project.repositoryPath, ['merge-base', baseCommit, headCommit]);
    const patch = await gitText(project.repositoryPath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      mergeBase,
      headCommit,
      '--',
    ]);
    const fastForward = mergeBase === baseCommit;
    // Why Merge is unavailable, computed with the same rules the merge itself enforces, so a
    // client can say so instead of disabling the button silently. A diverged branch that merges
    // without conflicts is mergeable: the merge lands as a merge commit.
    const noChanges = baseCommit === headCommit || mergeBase === headCommit;
    const conflicts =
      row.status === 'open' && !fastForward && !noChanges
        ? (await mergeTree(project.repositoryPath, baseCommit, headCommit, gitText)).conflicts
        : [];
    let mergeBlock: string | null = null;
    if (row.status !== 'open') mergeBlock = `This pull request is ${row.status}.`;
    else if (noChanges)
      mergeBlock = `${row.sourceBranch} has no commits that ${row.targetBranch} does not already have.`;
    else if (conflicts.length) mergeBlock = conflictReason(row, conflicts);
    else if (!(await requiredChecksPassed(owner, project, headCommit, gitText, 'ignore')))
      mergeBlock = `Required pipeline checks have not passed for ${headCommit.slice(0, 7)}.`;
    return {
      baseCommit,
      headCommit,
      mergeBase,
      patch,
      fastForward,
      conflicts,
      mergeable: mergeBlock === null,
      mergeBlock,
    };
  }
  return {
    record: row,
    comments: list('project-comment', owner).filter(
      (c) => c.parentId === row.id && c.projectId === projectId,
    ),
    mergeOperation: collection === 'pulls' ? mergeOperation(owner, row) : null,
    checks:
      collection === 'pulls'
        ? list('pipeline-run', owner)
            .filter((run) => run.projectId === projectId && run.pullId === row.id)
            .slice(-20)
            .reverse()
        : [],
  };
}

export async function collaborationCommand(
  owner: string,
  projectId: string,
  collection: string,
  recordId: string | undefined,
  action: string | undefined,
  input: any,
  signature: string,
) {
  get('project', owner, projectId);
  const replay = commandReplay(owner, input.operationId, signature);
  if (replay.found) return replay.result;
  let sourceBranch: string | undefined, targetBranch: string | undefined;
  if (!recordId && collection === 'pulls') {
    const project = requireRepository(owner, projectId);
    sourceBranch = branch(input.sourceBranch);
    targetBranch = branch(input.targetBranch || project.defaultBranch || 'main');
    if (sourceBranch === targetBranch) throw new Error('Source and target branches must differ');
    // Git IO stays outside the short SQLite transaction. Branches may change afterwards;
    // comparison returns current commit IDs and merging verifies both refs atomically.
    await Promise.all([
      resolveCommit(project.repositoryPath, `refs/heads/${sourceBranch}`),
      resolveCommit(project.repositoryPath, `refs/heads/${targetBranch}`),
    ]);
  }
  return command(
    owner,
    input.operationId,
    () => {
      const type = kind(collection);
      if (!recordId) {
        if (action) throw new Error('Record ID required');
        return save(type, owner, {
          id: id(),
          projectId,
          number: nextNumber(owner, projectId),
          author: owner,
          title: text(input.title, 'Title', 300, true),
          body: text(input.body ?? '', 'Body', 50000),
          status: 'open',
          revision: 0,
          taskIds: linked(owner, projectId, 'task', input.taskIds ?? []),
          ...(collection === 'pulls'
            ? {
                sourceBranch,
                targetBranch,
                issueIds: linked(owner, projectId, 'issue', input.issueIds ?? []),
              }
            : {}),
          createdAt: now(),
          updatedAt: now(),
        });
      }
      const row = record(owner, projectId, collection, recordId);
      if (action === 'comments') {
        return save('project-comment', owner, {
          id: id(),
          projectId,
          parentId: row.id,
          parentKind: type,
          author: owner,
          body: text(input.body, 'Comment', 50000, true),
          createdAt: now(),
        });
      }
      checkedRevision(row, input);
      if (action === 'task' && collection === 'issues') {
        const task = queueTask(owner, { projectId, title: row.title });
        save('task', owner, { ...task, issueId: row.id });
        const issue = save(type, owner, {
          ...row,
          taskIds: [...row.taskIds, task.id],
          revision: row.revision + 1,
          updatedAt: now(),
        });
        return { task, issue };
      }
      if (action === 'retry-merge') {
        if (collection !== 'pulls' || !['open', 'merged'].includes(row.status))
          conflict('Pull request cannot recover a merge');
        const operation = mergeOperation(owner, row);
        if (!operation || !['unknown', 'failed'].includes(operation.status))
          conflict('No merge to retry');
        if (operation.gitPid) {
          try {
            process.kill(operation.gitPid, 0);
            conflict('Previous Git process is still alive; resolve it before retrying');
          } catch (error: any) {
            if (error.code !== 'ESRCH') throw error;
          }
        }
        save('repository-operation', owner, {
          ...operation,
          status: 'queued',
          error: null,
          updatedAt: now(),
          completedAt: null,
        });
        return save(type, owner, { ...row, revision: row.revision + 1, updatedAt: now() });
      }
      if (collection === 'pulls') editable(owner, row);
      if (action === 'merge') {
        if (collection !== 'pulls' || row.status !== 'open') conflict('Pull request is not open');
        requireRepository(owner, projectId);
        const operation = save('repository-operation', owner, {
          id: id(),
          projectId,
          pullId: row.id,
          kind: 'pull-merge',
          status: 'queued',
          baseCommit: sha(input.baseCommit),
          headCommit: sha(input.headCommit),
          createdAt: now(),
          updatedAt: now(),
        });
        return save(type, owner, {
          ...row,
          mergeOperationId: operation.id,
          revision: row.revision + 1,
          updatedAt: now(),
        });
      }
      if (!['update', 'close', 'reopen'].includes(action || ''))
        throw new Error('Unknown collaboration command');
      if (row.status === 'merged') conflict('Merged pull requests cannot be changed');
      return save(type, owner, {
        ...row,
        ...(action === 'update'
          ? {
              ...(input.title !== undefined
                ? { title: text(input.title, 'Title', 300, true) }
                : {}),
              ...(input.body !== undefined ? { body: text(input.body, 'Body', 50000) } : {}),
              ...(input.taskIds !== undefined
                ? { taskIds: linked(owner, projectId, 'task', input.taskIds) }
                : {}),
              ...(collection === 'pulls' && input.issueIds !== undefined
                ? { issueIds: linked(owner, projectId, 'issue', input.issueIds) }
                : {}),
            }
          : { status: action === 'close' ? 'closed' : 'open' }),
        revision: row.revision + 1,
        updatedAt: now(),
      });
    },
    signature,
  );
}

// The receipt and branch update share a Git transaction. A retry after a process crash
// can distinguish a completed merge from a branch that moved independently.
export async function executePullMerge(owner: string, operation: any, runGit: typeof gitText) {
  const pull = get('pull-request', owner, operation.pullId);
  if (pull.mergeOperationId !== operation.id) throw new Error('Merge operation was superseded');
  const project = requireRepository(owner, operation.projectId),
    repo = project.repositoryPath;
  const receipt = `refs/deploy/merges/${operation.id}`;
  const proof = await runGit(repo, ['rev-parse', '--verify', receipt]).catch(() => null);
  // The receipt records what the target branch landed on: the source head for a fast-forward,
  // the merge commit for a diverged merge. Either way it must contain what this operation merged.
  if (proof && !(await isAncestor(repo, operation.headCommit, proof, runGit)))
    throw new Error('Merge receipt does not match');
  let landed = proof ?? '';
  if (!landed) {
    if (pull.status !== 'open') throw new Error('Pull request is not open');
    if (!(await requiredChecksPassed(owner, project, operation.headCommit, runGit, 'throw')))
      throw new Error('Required pipeline checks have not passed for this commit');
    const base = await runGit(repo, ['merge-base', operation.baseCommit, operation.headCommit]);
    if (operation.baseCommit === operation.headCommit || base === operation.headCommit)
      throw new Error('Pull request has no new commits');
    landed = operation.headCommit;
    if (base !== operation.baseCommit) {
      // The target moved since the source branched. Merge the trees rather than refusing: a
      // clean merge lands as a merge commit, a conflicted one names the files that collide.
      const { tree, conflicts } = await mergeTree(
        repo,
        operation.baseCommit,
        operation.headCommit,
        runGit,
      );
      if (conflicts.length) throw new Error(conflictReason(pull, conflicts));
      landed = await runGit(
        repo,
        ['commit-tree', tree, '-p', operation.baseCommit, '-p', operation.headCommit],
        {
          identity: owner,
          committer: 'deploy.local',
          input: `Merge pull request #${pull.number} from ${pull.sourceBranch}\n\n${String(
            pull.title,
          )
            .replace(/\s+/g, ' ')
            .trim()}\n`,
        },
      );
    }
    await runGit(repo, ['update-ref', '--stdin'], {
      input: `start\nverify refs/heads/${pull.sourceBranch} ${operation.headCommit}\nupdate refs/heads/${pull.targetBranch} ${landed} ${operation.baseCommit}\ncreate ${receipt} ${landed}\nprepare\ncommit\n`,
    });
  }
  queuePushTrigger(owner, project.id, `refs/heads/${pull.targetBranch}`, landed);
  save('pull-request', owner, {
    ...get('pull-request', owner, pull.id),
    status: 'merged',
    mergedCommit: operation.headCommit,
    mergedBaseCommit: operation.baseCommit,
    // The target's new tip: the source head for a fast-forward, the merge commit otherwise.
    // Baselines and follow-ups key off mergedCommit, so that stays the commit that was merged.
    mergedTargetCommit: landed,
    mergedAt: pull.mergedAt || now(),
    updatedAt: now(),
    revision: pull.revision + (pull.status === 'merged' ? 0 : 1),
  });
  const merged = get('pull-request', owner, pull.id);
  const adopted = adoptMergedBaseline(owner, merged);
  closeMergedTasks(owner, merged);
  await refreshLocalBaselines(adopted, repo);
}

// A merged pull request finishes the tasks linked to it. Tasks that are running again,
// or that someone already closed or reopened after the merge, are left alone.
export function closeMergedTasks(owner: string, pull: any) {
  if (pull?.status !== 'merged') return;
  for (const taskId of pull.taskIds ?? []) {
    let task;
    try {
      task = get('task', owner, taskId);
    } catch {
      continue;
    }
    if (!['review', 'blocked', 'failed'].includes(task.status)) continue;
    cancelTaskQuestions(owner, taskId);
    if (task.mergedPullId === pull.id) continue;
    save('task', owner, {
      ...task,
      status: 'merged',
      mergedPullId: pull.id,
      closedAt: pull.mergedAt || now(),
      revision: task.revision + 1,
      updatedAt: now(),
    });
    event(owner, taskId, null, 'task.merged', { pullId: pull.id, number: pull.number });
    cleanupTaskCheckpointRefs(owner, taskId);
  }
}

/** Startup backfill for pull requests merged before tasks closed on merge. */
export function closeTasksForMergedPulls() {
  for (const row of db
    .prepare("SELECT owner, data FROM records WHERE kind='pull-request'")
    .all() as any[]) {
    const pull = JSON.parse(row.data);
    // Tasks merged before follow-ups existed still measure changes from their original base.
    const adopted = adoptMergedBaseline(row.owner, pull);
    closeMergedTasks(row.owner, pull);
    if (adopted.length)
      void Promise.resolve()
        .then(() =>
          refreshLocalBaselines(
            adopted,
            requireRepository(row.owner, pull.projectId).repositoryPath,
          ),
        )
        .catch(() => {});
  }
}

/** Shared record creation for coordinator-published task branches. Caller owns the command transaction. */
export function createPublishedPull(
  owner: string,
  project: any,
  task: any,
  sourceBranch: string,
  title: string,
  body: string,
) {
  return {
    id: id(),
    projectId: project.id,
    number: nextNumber(owner, project.id),
    author: owner,
    title,
    body,
    status: 'open',
    revision: 0,
    taskIds: [task.id],
    issueIds: [],
    sourceBranch,
    targetBranch: project.defaultBranch || 'main',
    createdAt: now(),
    updatedAt: now(),
  };
}
