import { setTimeout as delay } from 'node:timers/promises';
import { computers } from '../../workspace/coordination.ts';
import { workerLoad } from '../../workspace/run-queue.ts';
import { askTools, answerLocalTools, hasTools, toolAnswer } from '../../workspace/tool-probes.ts';
import { toolNames } from '../../workspace/worker-capabilities.ts';
import type { TaskRequirementsSnapshot } from '../../../shared/v2/contracts.ts';
import { workerRoleEnabled, assertWorkerRole } from '../../workspace/computer-role-policy.ts';
import { taskTitle } from '../../../shared/task-title.ts';
import { resolve } from 'node:path';
import { root, db, list, get, save, event, id, now } from '../../workspace/store.ts';
import { requireRepository } from '../../workspace/repositories.ts';
import { git, startRun } from '../../workspace/service.ts';

function taskComputers(owner: string, tools: string[], workerId?: string) {
  return computers(owner)
    .filter(
      (worker) =>
        (!workerId || worker.id === workerId) &&
        workerRoleEnabled(owner, worker.id, 'tasks') &&
        hasTools(owner, worker.id, tools),
    )
    .sort((a, b) => {
      const load = (candidateId: string) => {
        const count = workerLoad(owner, candidateId);
        return count.activeTaskCount + count.queuedTaskCount;
      };
      return load(a.id) - load(b.id) || a.id.localeCompare(b.id);
    });
}
function askComputers(owner: string, tools: string[]) {
  for (const worker of computers(owner))
    if (worker.status === 'online' && workerRoleEnabled(owner, worker.id, 'tasks'))
      askTools(owner, worker.id, tools);
}
function namedComputerMissing(owner: string, tools: string[], workerId?: string) {
  if (!workerId) return null;
  const missing = tools.filter((tool) => toolAnswer(owner, workerId, tool) === false);
  const worker = computers(owner).find((candidate) => candidate.id === workerId);
  return missing.length ? `${worker?.name || workerId} is missing: ${missing.join(', ')}` : null;
}
export function taskRequirementsSnapshot(owner: string, task: any): TaskRequirementsSnapshot {
  if (!task.needs?.tools.length) return {};
  return {
    needs: {
      tools: task.needs.tools,
      ...(task.needs.why ? { why: task.needs.why } : {}),
      waiting: Boolean(task.pendingPlacement),
      asked: computers(owner).map((worker) => ({
        id: worker.id,
        name: worker.name,
        online: worker.status === 'online',
        has: Object.fromEntries(
          task.needs.tools.map((tool: string) => [tool, toolAnswer(owner, worker.id, tool)]),
        ),
      })),
    },
  };
}
function prepareTask(owner: string, task: any, workerId: string) {
  assertWorkerRole(owner, workerId, 'tasks');
  const moving = task.pendingPlacement.runId;
  const checkpointId = task.pendingPlacement.checkpointId;
  const generation = moving ? id() : undefined;
  const prepare = workerId === 'local' || !task.projectId;
  const operationId = prepare ? id() : null;
  const ready = save('task', owner, {
    ...task,
    workerId,
    status: prepare ? 'preparing' : 'ready',
    workspaceStatus: prepare ? 'preparing' : 'ready',
    workspaceOperationId: operationId,
    ...(moving
      ? {
          workspaceGeneration: generation,
          workspacePath: resolve(root, 'tasks', `${task.id}-${generation}`),
          resumeCheckpointId: checkpointId,
          resumeBaseRevision:
            get('checkpoint', owner, checkpointId).snapshot.base?.commit || task.baseRevision,
          remoteWorkspacePath: null,
        }
      : {}),
    pendingPlacement: undefined,
    pendingLaunch: undefined,
    updatedAt: now(),
  });
  if (prepare)
    save('repository-operation', owner, {
      id: operationId,
      projectId: task.projectId,
      taskId: task.id,
      kind: 'workspace',
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
    });
  if (task.pendingLaunch) {
    const run = startRun(
      owner,
      task.id,
      { ...task.pendingLaunch, revision: ready.revision },
      undefined,
      Boolean(moving),
    );
    if (moving) save('run', owner, { ...run, sessionId: null });
  }
  event(owner, task.id, null, 'task.assigned', { workerId });
}

/** A transaction claims each durable wait, only after the previous process has stopped. */
export async function startWaitingTasks() {
  const rows = db
    .prepare(
      "SELECT owner,id FROM records WHERE kind='task' AND json_type(data,'$.pendingPlacement')='object'",
    )
    .all() as { owner: string; id: string }[];
  for (const row of rows) {
    try {
      const current = get('task', row.owner, row.id);
      askComputers(row.owner, current.needs.tools);
      await answerLocalTools(row.owner);
      db.transaction(() => {
        const task = get('task', row.owner, row.id);
        if (!task.pendingPlacement) return;
        // Tasks closed before closing cleared the wait still carry one.
        if (task.status === 'done') {
          save('task', row.owner, {
            ...task,
            pendingPlacement: undefined,
            pendingLaunch: undefined,
          });
          return;
        }
        if (
          list('run', row.owner).some(
            (run) =>
              run.taskId === task.id &&
              ['queued', 'starting', 'running', 'unknown'].includes(run.status),
          )
        )
          return;
        const missing = namedComputerMissing(row.owner, task.needs.tools, task.requestedWorkerId);
        if (missing) {
          save('task', row.owner, {
            ...task,
            pendingPlacement: undefined,
            status: 'blocked',
            placementError: missing,
          });
          event(row.owner, task.id, null, 'task.placement_refused', { error: missing });
          return;
        }
        const worker = taskComputers(row.owner, task.needs.tools, task.requestedWorkerId).find(
          (candidate) => candidate.status === 'online',
        );
        if (worker) prepareTask(row.owner, task, worker.id);
      }).immediate();
    } catch (error) {
      console.error('Waiting task will retry:', row.id, error);
    }
  }
}
export function startTaskPlacement() {
  let scanning = false;
  const scan = async () => {
    if (scanning) return;
    scanning = true;
    try {
      await startWaitingTasks();
    } finally {
      scanning = false;
    }
  };
  void scan();
  const timer = setInterval(() => void scan(), 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Called by the agent with a checkpoint captured at the tool boundary. Needs accumulate. */
export async function requireTaskTools(
  scope: { owner: string; taskId: string; runId: string },
  input: any,
): Promise<TaskRequirementsSnapshot & { checkpointRequired?: boolean }> {
  const tools = toolNames(input.needs);
  if (
    input.why !== undefined &&
    (typeof input.why !== 'string' || input.why.length > 300 || /[\r\n]/.test(input.why))
  )
    throw new Error('why must be one line, at most 300 characters');
  const { owner, taskId, runId } = scope;
  const current = get('run', owner, runId);
  const requested = [
    ...new Set([...(get('task', owner, taskId).needs?.tools ?? []), ...tools]),
  ] as string[];
  askComputers(owner, requested);
  if ((current.workerId || 'local') === 'local') await answerLocalTools(owner);
  else {
    // The tool call holds the agent at its boundary while the busy worker answers its heartbeat.
    const deadline = Date.now() + 8000;
    while (
      requested.some((tool) => toolAnswer(owner, current.workerId, tool) === null) &&
      computers(owner).some(
        (worker) => worker.id === current.workerId && worker.status === 'online',
      ) &&
      Date.now() < deadline
    )
      await delay(100);
  }
  return db
    .transaction(() => {
      const task = get('task', owner, taskId);
      const run = get('run', owner, runId);
      if (
        run.taskId !== taskId ||
        !['starting', 'running'].includes(run.status) ||
        run.stopRequested
      )
        throw new Error('This task is not running');
      const needs = {
        tools: [...new Set([...(task.needs?.tools ?? []), ...tools])],
        ...(task.needs?.why ? { why: task.needs.why } : {}),
        ...(input.why ? { why: input.why } : {}),
      };
      askComputers(owner, needs.tools);
      if (hasTools(owner, run.workerId || 'local', needs.tools)) {
        const saved = save('task', owner, { ...task, needs, updatedAt: now() });
        return taskRequirementsSnapshot(owner, saved);
      }
      if (!input.checkpointId) return { checkpointRequired: true };
      const checkpoint = get('checkpoint', owner, input.checkpointId);
      if (checkpoint.taskId !== taskId || checkpoint.runId !== runId)
        throw new Error('Capture a checkpoint of this running task before changing computers');
      const history = list('message', owner)
        .filter((message) => message.taskId === taskId && !message.shell)
        .slice(-20)
        .map((message) => `${message.role}: ${message.content}`)
        .join('\n')
        .slice(-40000);
      save('run', owner, { ...run, stopRequested: true });
      const saved = save('task', owner, {
        ...task,
        needs,
        status: 'waiting',
        requestedWorkerId: undefined,
        pendingPlacement: { runId, checkpointId: checkpoint.id },
        pendingLaunch: {
          adapter: run.adapter,
          model: run.model,
          effort: run.effort,
          attachmentIds: run.attachmentIds ?? [],
          content:
            `Continue this task from its checkpoint on a computer with ${needs.tools.join(', ')}. ${needs.why ?? ''}\nShared conversation:\n${history}\nInterrupted instruction:\n${run.prompt}`.slice(
              -100000,
            ),
        },
        updatedAt: now(),
      });
      event(owner, taskId, runId, 'run.stopRequested', {});
      return taskRequirementsSnapshot(owner, saved);
    })
    .immediate();
}

export function queueTask(owner: string, input: any) {
  const needs = input.needs === undefined ? [] : toolNames(input.needs);
  let workerId = input.workerId || 'local';
  if (needs.length) {
    if (input.workerId) assertWorkerRole(owner, input.workerId, 'tasks');
    const missing = namedComputerMissing(owner, needs, input.workerId);
    if (missing) throw new Error(missing);
    askComputers(owner, needs);
    workerId =
      taskComputers(owner, needs, input.workerId).find((worker) => worker.status === 'online')
        ?.id ?? null;
  } else assertWorkerRole(owner, workerId, 'tasks');
  if (input.workerId && input.workerId !== 'local') get('worker', owner, input.workerId);
  const project = input.projectId ? requireRepository(owner, input.projectId) : null;
  const ref = input.ref ?? 'HEAD';
  if (
    typeof ref !== 'string' ||
    !ref ||
    ref.length > 250 ||
    ref.startsWith('-') ||
    [...ref].some((c) => c.charCodeAt(0) <= 32)
  )
    throw new Error('Invalid Git revision');
  // Resolving an object ID is small; all checkout/file copying happens in the repository service.
  const baseRevision = project
    ? git(project.repositoryPath, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    : '';
  const taskId = id(),
    operationId = id();
  const sourceRef = project ? `refs/deploy/tasks/${taskId}` : null;
  if (project)
    git(project.repositoryPath, [
      'update-ref',
      sourceRef!,
      baseRevision,
      '0'.repeat(baseRevision.length),
    ]);
  const waiting = !workerId;
  const remote = workerId && workerId !== 'local';
  // Remote projectless tasks still need their deterministic baseline; prepare only a tiny local scratch repository.
  const prepare = !waiting && (!remote || !project);
  const task = save('task', owner, {
    id: taskId,
    projectId: project?.id ?? null,
    title: taskTitle(String(input.title || 'New task')),
    status: waiting ? 'waiting' : prepare ? 'preparing' : 'ready',
    revision: 0,
    workspacePath: resolve(root, 'tasks', taskId),
    workerId,
    ...(needs.length ? { needs: { tools: needs } } : {}),
    ...(waiting
      ? {
          requestedWorkerId: input.workerId,
          pendingPlacement: {},
          pendingLaunch: input.prompt
            ? {
                content: input.prompt,
                adapter: input.adapter,
                model: input.model,
                effort: input.effort,
              }
            : undefined,
        }
      : {}),
    baseRevision,
    sourceRef,
    workspaceStatus: waiting ? 'waiting' : prepare ? 'preparing' : 'ready',
    workspaceOperationId: prepare ? operationId : null,
    createdAt: now(),
    updatedAt: now(),
  });
  if (prepare)
    save('repository-operation', owner, {
      id: operationId,
      projectId: project?.id ?? null,
      taskId,
      kind: 'workspace',
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
    });
  event(owner, taskId, null, 'task.created', task);
  if (input.prompt && !waiting)
    startRun(owner, taskId, {
      revision: 0,
      content: input.prompt,
      adapter: input.adapter,
      model: input.model,
      effort: input.effort,
    });
  return get('task', owner, taskId);
}
export function taskWorkspaceCommand(owner: string, taskId: string, action: string) {
  const task = get('task', owner, taskId);
  if (!task.workspaceOperationId) throw new Error('Task has no workspace preparation operation');
  const current = get('repository-operation', owner, task.workspaceOperationId);
  if (action === 'cancel') {
    if (!['queued', 'running'].includes(current.status))
      throw Object.assign(new Error('No active workspace preparation'), { status: 409 });
    if (current.status === 'queued')
      save('task', owner, {
        ...task,
        workspaceStatus: 'failed',
        status: 'blocked',
        updatedAt: now(),
      });
    return save('repository-operation', owner, {
      ...current,
      cancelRequested: true,
      updatedAt: now(),
      ...(current.status === 'queued' ? { status: 'cancelled', completedAt: now() } : {}),
    });
  }
  if (!['failed', 'cancelled', 'unknown'].includes(current.status))
    throw Object.assign(new Error('No failed workspace preparation to retry'), { status: 409 });
  if (current.gitPid) {
    try {
      process.kill(current.gitPid, 0);
      throw Object.assign(new Error('Previous Git process is still alive'), { status: 409 });
    } catch (error: any) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  const operation = save('repository-operation', owner, {
    id: id(),
    projectId: task.projectId,
    taskId,
    kind: 'workspace',
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
  });
  save('task', owner, {
    ...task,
    workspaceStatus: 'preparing',
    status: 'preparing',
    workspaceOperationId: operation.id,
    updatedAt: now(),
  });
  return operation;
}
