import { queueTask } from './task-workspace.ts';
import { compileDeployYaml } from '../application-spec.ts';
import { queuePushTrigger } from './pipeline-triggers.ts';
import { command, commandReplay, get, id, list, now, save } from './store.ts';
import { requireRepository, resolveCommit } from './repositories.ts';
import { gitText } from './repository-git.ts';

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
    return { baseCommit, headCommit, mergeBase, patch, fastForward: mergeBase === baseCommit };
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
  if (proof && proof !== operation.headCommit) throw new Error('Merge receipt does not match');
  if (!proof) {
    if (pull.status !== 'open') throw new Error('Pull request is not open');
    const manifest = await runGit(repo, ['show', `${operation.headCommit}:deploy.yaml`]).catch(
      () => null,
    );
    if (manifest !== null) {
      const pipeline = compileDeployYaml(manifest).spec.pipeline;
      if (pipeline?.on.includes('pull_request')) {
        const check = list('pipeline-run', owner)
          .filter((run) => run.projectId === project.id && run.commit === operation.headCommit)
          .at(-1);
        if (!check || check.status !== 'succeeded')
          throw new Error('Required pipeline checks have not passed for this commit');
      }
    }
    const base = await runGit(repo, ['merge-base', operation.baseCommit, operation.headCommit]);
    if (base !== operation.baseCommit)
      throw new Error('Branches have diverged; rebase the source branch before merging');
    if (operation.baseCommit === operation.headCommit)
      throw new Error('Pull request has no new commits');
    await runGit(repo, ['update-ref', '--stdin'], {
      input: `start\nverify refs/heads/${pull.sourceBranch} ${operation.headCommit}\nupdate refs/heads/${pull.targetBranch} ${operation.headCommit} ${operation.baseCommit}\ncreate ${receipt} ${operation.headCommit}\nprepare\ncommit\n`,
    });
  }
  queuePushTrigger(owner, project.id, `refs/heads/${pull.targetBranch}`, operation.headCommit);
  save('pull-request', owner, {
    ...get('pull-request', owner, pull.id),
    status: 'merged',
    mergedCommit: operation.headCommit,
    mergedBaseCommit: operation.baseCommit,
    mergedAt: pull.mergedAt || now(),
    updatedAt: now(),
    revision: pull.revision + (pull.status === 'merged' ? 0 : 1),
  });
}
