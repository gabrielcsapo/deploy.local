import { get, list, save, event, id, now, revise } from './store.ts';
export function activeCheck(owner: string, taskId: string) {
  return list('check', owner).find(
    (check) => check.taskId === taskId && ['queued', 'running', 'unknown'].includes(check.status),
  );
}
export function queueCheck(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  if (task.baseUpdate && !['succeeded', 'aborted'].includes(task.baseUpdate.status))
    throw Object.assign(new Error('Finish or abort the workspace update before running checks'), {
      status: 409,
    });
  if (task.workspaceStatus && task.workspaceStatus !== 'ready')
    throw Object.assign(new Error('Workspace is not ready'), { status: 409 });
  if (task.workerId && task.workerId !== 'local')
    throw new Error('Remote command recipes are not supported yet');
  if (
    activeCheck(owner, taskId) ||
    list('run', owner).some(
      (run) =>
        run.taskId === taskId && ['queued', 'starting', 'running', 'unknown'].includes(run.status),
    )
  )
    throw Object.assign(new Error('Task already has an active writer or check'), { status: 409 });
  const command = String(input.command || '').trim();
  if (!command || command.length > 10000)
    throw new Error('Check command required (maximum 10000 characters)');
  const check = {
    id: id(),
    taskId,
    command,
    status: 'queued',
    exitCode: null,
    output: '',
    error: null,
    timeoutMs: Math.min(60000, Math.max(100, Number(input.timeoutMs) || 60000)),
    createdAt: now(),
    updatedAt: now(),
  };
  save('check', owner, check);
  save('task', owner, {
    ...task,
    status: 'checking',
    revision: task.revision + 1,
    updatedAt: now(),
  });
  event(owner, taskId, null, 'check.queued', check);
  return check;
}
