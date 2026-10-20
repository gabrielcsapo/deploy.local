import { taskTitle } from '../../shared/task-title.ts';
import { resolve } from 'node:path';
import { root, get, save, event, id, now } from './store.ts';
import { requireRepository } from './repositories.ts';
import { git, startRun } from './service.ts';

export function queueTask(owner: string, input: any) {
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
  const remote = input.workerId && input.workerId !== 'local';
  // Remote projectless tasks still need their deterministic baseline; prepare only a tiny local scratch repository.
  const prepare = !remote || !project;
  const task = save('task', owner, {
    id: taskId,
    projectId: project?.id ?? null,
    title: taskTitle(String(input.title || 'New task')),
    status: prepare ? 'preparing' : 'ready',
    revision: 0,
    workspacePath: resolve(root, 'tasks', taskId),
    workerId: input.workerId || 'local',
    baseRevision,
    sourceRef,
    workspaceStatus: prepare ? 'preparing' : 'ready',
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
  if (input.prompt)
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
