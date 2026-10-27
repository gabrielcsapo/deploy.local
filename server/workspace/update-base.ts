import { activeCheck } from './checks.ts';
import { filePatchBundle } from './protocol.ts';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCheckpointCommit } from './checkpoint-commit.ts';
import { validateSnapshot } from './checkpoint.ts';
import { currentTaskBranch, linkedPulls, taskBaseline } from './follow-up.ts';
import { mergeTree } from './project-collaboration.ts';
import { requireRepository } from './repositories.ts';
import { gitText, gitSync } from './repository-git.ts';
import { command, event, get, list, now, save, remove } from './store.ts';
import { startRun } from './service.ts';
import { executeBaseUpdate } from './update-base-worker.ts';

const reject = (message: string): never => {
  throw Object.assign(new Error(message), { status: 409 });
};
const active = (owner: string, taskId: string) =>
  list('run', owner).filter(
    (r) => r.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(r.status),
  );
export const updatingBase = (task: any) =>
  task.baseUpdate && !['succeeded', 'aborted'].includes(task.baseUpdate.status);

/** No caller-supplied project, branch, URL or revision: scope is always the task's review target. */
export async function updateBase(owner: string, taskId: string, args: any, runId?: string) {
  if (!args.operationId) throw new Error('operationId required');
  if (Object.keys(args).some((key) => !['operationId', 'action'].includes(key)))
    throw new Error('Update only accepts operationId and action');
  const action = args.action || 'update';
  if (!['update', 'continue', 'abort', 'status'].includes(action))
    throw new Error('Invalid update action');
  let task = get('task', owner, taskId);
  const project = requireRepository(owner, task.projectId);
  if (action === 'status') return task.baseUpdate || { status: 'succeeded', conflicts: [] };
  if (active(owner, taskId).some((r) => r.id !== runId) || activeCheck(owner, taskId))
    reject('Stop the active run or check before updating');
  if (task.workspaceStatus && task.workspaceStatus !== 'ready') reject('Workspace is not ready');
  const signature = JSON.stringify(['update-base', taskId, action]);
  const result = command(
    owner,
    args.operationId,
    () => {
      task = get('task', owner, taskId);
      if (action === 'update') {
        if (updatingBase(task)) reject('An update is pending; resume it or abort it');
        const pull = linkedPulls(owner, task).find((p) => p.status === 'open');
        const targetBranch = pull?.targetBranch || 'main';
        const target = requireTarget(project.repositoryPath, targetBranch);
        const baseline = taskBaseline(task);
        const upToDate = ancestor(project.repositoryPath, target, baseline);
        const operation = {
          id: args.operationId,
          generation: args.operationId,
          taskId,
          projectId: project.id,
          workerId: task.workerId || 'local',
          action,
          status: upToDate ? 'succeeded' : 'queued',
          targetBranch,
          target,
          conflicts: [],
          ownerAction: !runId,
          previous: {
            baseRevision: task.baseRevision,
            workspaceCommit: task.workspaceCommit || null,
            pendingMergeCommit: task.pendingMergeCommit || null,
          },
          createdAt: now(),
        };
        save('base-update', owner, operation);
        save('task', owner, { ...task, baseUpdate: operation, updatedAt: now() });
        return operation;
      }
      if (!updatingBase(task)) reject('No update to continue or abort');
      const previous = task.baseUpdate;
      if (action === 'continue' && ['queued', 'preparing', 'prepared'].includes(previous.status))
        return previous;
      const retry = action === 'continue' && previous.status === 'failed';
      const operation = {
        ...previous,
        generation: args.operationId,
        action: retry ? previous.action : action,
        status: retry && previous.preparedAction === previous.action ? 'prepared' : 'queued',
        error: null,
      };
      save('base-update', owner, operation);
      save('task', owner, { ...task, baseUpdate: operation, updatedAt: now() });
      return operation;
    },
    signature,
  );
  if (['queued', 'prepared'].includes(result.status) && result.workerId === 'local')
    await runLocalUpdate(owner, result);
  return get('task', owner, taskId).baseUpdate;
}

function requireTarget(repo: string, branch: string) {
  const target = gitSync(repo, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
  if (!target) throw new Error('Review target branch is unavailable');
  return target;
}
const ancestor = (repo: string, a: string, b: string) =>
  gitSync(repo, ['merge-base', '--is-ancestor', a, b]) !== null;

/** Worker protocol: immutable plan first, installation acknowledgement second. Retries return the same plan. */
const preparations = new Map<string, Promise<any>>();
export async function baseUpdateWorker(
  owner: string,
  workerId: string,
  action: string,
  body: any,
): Promise<any> {
  if (action !== 'prepare') return handleBaseUpdateWorker(owner, workerId, action, body);
  const key = JSON.stringify([owner, workerId, body.id, body.generation]);
  const previous = preparations.get(key);
  if (previous) return previous;
  const pending = handleBaseUpdateWorker(owner, workerId, action, body);
  preparations.set(key, pending);
  try {
    return await pending;
  } finally {
    preparations.delete(key);
  }
}
async function handleBaseUpdateWorker(owner: string, workerId: string, action: string, body: any) {
  if (action === 'poll')
    return {
      operations: list('base-update', owner).filter(
        (op) => op.workerId === workerId && ['queued', 'preparing', 'prepared'].includes(op.status),
      ),
    };
  let op = get('base-update', owner, body.id);
  const task = get('task', owner, op.taskId);
  if (
    op.workerId !== workerId ||
    (task.workerId && task.workerId !== workerId) ||
    task.projectId !== op.projectId ||
    task.baseUpdate?.id !== op.id
  )
    throw Object.assign(new Error('Update does not belong to this worker task'), { status: 403 });
  if (body.generation !== op.generation) {
    if (action === 'fail') return op;
    reject('Update command changed; the worker must reload its plan');
  }
  const repo = requireRepository(owner, op.projectId).repositoryPath;
  const persist = (next: any) => {
    if (get('base-update', owner, op.id).generation !== next.generation)
      reject('Update command changed; the worker must reload its plan');
    save('base-update', owner, next);
    save('task', owner, { ...get('task', owner, task.id), baseUpdate: next, updatedAt: now() });
    event(owner, task.id, null, 'task.base-update', next);
    return next;
  };
  if (action === 'fail' && ['succeeded', 'conflicted', 'aborted'].includes(op.status)) return op;
  if (action === 'fail')
    return persist({
      ...op,
      status: 'failed',
      error: String(body.error || 'Worker update failed').slice(0, 2000),
    });
  if (action === 'prepare') {
    if (op.status === 'prepared' || ['succeeded', 'conflicted', 'aborted'].includes(op.status))
      return op;
    if (!['queued', 'preparing'].includes(op.status)) reject('Update is not queued');
    if (op.action === 'abort') return persist({ ...op, status: 'prepared' });
    const snapshot = validateSnapshot(body.snapshot);
    if (snapshot.excluded.length) reject('Resolve excluded workspace files before updating');
    const expected = task.workspaceCommit?.commit || task.baseRevision;
    if (snapshot.base?.commit !== expected)
      reject('Worker baseline changed; refresh before updating');
    persist({ ...op, status: 'preparing' });
    const directory = await mkdtemp(join(tmpdir(), 'deploy-update-'));
    try {
      const built = await buildCheckpointCommit(
        repo,
        snapshot,
        op.action === 'continue' ? op.commit : taskBaseline(task),
        'Preserve task workspace before update',
        owner,
        { indexFile: join(directory, 'index'), limit: 64 * 1024 * 1024 },
      );
      if (op.action === 'update') {
        const merged = await mergeTree(repo, built.commit, op.target, gitText);
        const commit = await gitText(
          repo,
          ['commit-tree', merged.tree, '-p', built.commit, '-p', op.target],
          { identity: owner, input: `Merge ${op.targetBranch} into task workspace` },
        );
        op = { ...op, beforeCommit: built.commit, commit, conflicts: merged.conflicts };
      } else if (op.action === 'continue') {
        for (const path of op.conflicts) {
          if (snapshot.deleted?.includes(path)) continue;
          const file = snapshot.files.find((file) => file.path === path);
          const content = file
            ? Buffer.from(file.content, 'base64').toString()
            : await gitText(repo, ['show', `${snapshot.base!.commit}:${path}`]).catch(() => '');
          if (/^(<{7} |={7}\r?$|>{7} )/m.test(content))
            reject(`Resolve conflict markers in ${path} before continuing`);
        }
        op = { ...op, commit: built.commit, conflicts: [] };
      }
      for (const [suffix, commit] of [
        ['before', op.beforeCommit],
        ['result', op.commit],
      ])
        if (commit)
          await gitText(repo, [
            'update-ref',
            `refs/deploy/base-updates/${createHash('sha256').update(op.id).digest('hex')}/${suffix}`,
            commit,
          ]);
      return persist({
        ...op,
        snapshotDigest: snapshot.digest,
        preparedAction: op.action,
        status: 'prepared',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (action !== 'complete') throw new Error('Unknown update worker action');
  if (['succeeded', 'conflicted', 'aborted'].includes(op.status)) return op;
  if (op.status !== 'prepared') reject('Update has no prepared plan');
  const aborted = op.action === 'abort';
  const status = aborted ? 'aborted' : op.conflicts.length ? 'conflicted' : 'succeeded';
  const fields = aborted
    ? op.previous
    : {
        baseRevision: op.target,
        workspaceCommit: { commit: op.commit, branch: currentTaskBranch(task) },
        pendingMergeCommit: op.commit,
      };
  save('task', owner, { ...task, ...fields, revision: task.revision + 1, updatedAt: now() });
  const result = persist({
    ...op,
    status,
    conflicts: aborted ? [] : op.conflicts,
    completedAt: now(),
  });
  if (body.diff) {
    const receivedAt = now();
    save('remote-diff', owner, { ...body.diff, id: task.id, taskId: task.id, receivedAt });
    const patches = filePatchBundle(body.filePatches);
    if (patches)
      save('remote-diff-files', owner, { id: task.id, taskId: task.id, patches, receivedAt });
    else remove('remote-diff-files', owner, task.id);
  }
  if (status === 'conflicted' && op.ownerAction && !active(owner, task.id).length) {
    const latest = list('run', owner)
      .filter((r) => r.taskId === task.id)
      .at(-1);
    try {
      startRun(owner, task.id, {
        revision: get('task', owner, task.id).revision,
        adapter: latest?.adapter,
        model: latest?.model,
        effort: latest?.effort,
        content: `Resolve the Update from main conflicts in: ${op.conflicts.join(', ')}. Edit the workspace files, then call deploy_update_base with action continue. The merge must preserve both histories. Use action abort to restore the pre-update workspace if needed.`,
      });
    } catch (error: any) {
      return persist({
        ...result,
        error: `Conflicts need resolution; could not start agent: ${error.message}`,
      });
    }
  }
  return result;
}
const localUpdates = new Map<string, Promise<void>>();
async function runLocalUpdate(owner: string, op: any) {
  const key = JSON.stringify([owner, op.taskId]);
  const previous = localUpdates.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => executeLocalUpdate(owner, op));
  localUpdates.set(key, pending);
  try {
    await pending;
  } finally {
    if (localUpdates.get(key) === pending) localUpdates.delete(key);
  }
}
async function executeLocalUpdate(owner: string, op: any) {
  const task = get('task', owner, op.taskId);
  if (task.baseUpdate?.id !== op.id) return;
  op = get('base-update', owner, op.id);
  if (!['queued', 'preparing', 'prepared'].includes(op.status)) return;
  try {
    await executeBaseUpdate(
      task.workspacePath,
      op,
      requireRepository(owner, task.projectId).repositoryPath,
      (action, body) => baseUpdateWorker(owner, 'local', action, body),
    );
  } catch (error: any) {
    await baseUpdateWorker(owner, 'local', 'fail', {
      id: op.id,
      generation: op.generation,
      error: error.message,
    });
  }
}
