import { requireMergePermissionSource } from '../../workspace/merge-permission-port.ts';
import { createHash } from 'node:crypto';
import { get, command } from '../../workspace/store.ts';
import type { AgentScope } from '../../workspace/coordination.ts';
import { collaborationCommand, collaborationRead } from './project-collaboration.ts';
import { pipelineStart, pipelineRead, pipelineCancel } from '../../workspace/pipelines.ts';
export async function projectTool(scope: AgentScope, args: any) {
  const task = get('task', scope.owner, scope.taskId);
  if (!task.projectId) throw new Error('This conversation has no repository project');
  const projectId = task.projectId;
  if (!['issues', 'pulls', 'pipelines'].includes(args.resource))
    throw new Error('Invalid resource');
  if (args.action !== 'list' && args.action !== 'create' && typeof args.id !== 'string')
    throw new Error('Resource ID required');
  const signature = createHash('sha256')
    .update(JSON.stringify({ taskId: task.id, args }))
    .digest('hex');
  if (args.resource === 'pipelines') {
    if (args.action === 'list' || args.action === 'get')
      return pipelineRead(scope.owner, projectId, args.action === 'list' ? undefined : args.id);
    if (args.action === 'create')
      return pipelineStart(
        scope.owner,
        projectId,
        { ...args, trigger: 'manual', taskId: task.id },
        signature,
      );
    if (args.action === 'cancel')
      return command(
        scope.owner,
        args.operationId,
        () => pipelineCancel(scope.owner, projectId, args.id),
        signature,
      );
    throw new Error('Unsupported pipeline action');
  }
  if (['list', 'get', 'diff'].includes(args.action))
    return collaborationRead(
      scope.owner,
      projectId,
      args.resource,
      args.action === 'list' ? undefined : args.id,
      args.action === 'diff' ? 'diff' : undefined,
    );
  if (
    !['create', 'update', 'close', 'reopen', 'comment', 'merge', 'retry-merge'].includes(
      args.action,
    )
  )
    throw new Error('Unsupported project action');
  if (args.action === 'merge' || args.action === 'retry-merge') {
    // Loaded when used, like deploy_design: the release module is only needed to decide this.
    const isAllowed = await requireMergePermissionSource('workspace')();
    // Rules name saved agents and a task keeps its agent across follow-up runs. A conversation a
    // person started has no agent to hold a rule, so its merge stays with that person. People's
    // own merges come through the workspace API and never reach this check.
    if (!task.agentId || !isAllowed(scope.owner, task.agentId, 'merge', projectId))
      throw Object.assign(
        new Error(
          `This agent is not allowed to merge pull requests in this project, so nothing was queued. Tell the person the pull request is ready: they can merge it themselves.${
            task.agentId ? ' Its merge rule is in Settings, under Agents and approvals.' : ''
          }`,
        ),
        { status: 403 },
      );
  }
  return collaborationCommand(
    scope.owner,
    projectId,
    args.resource,
    args.action === 'create' ? undefined : args.id,
    args.action === 'create' ? undefined : args.action === 'comment' ? 'comments' : args.action,
    { ...args, ...(args.action === 'create' ? { taskIds: [task.id] } : {}) },
    signature,
  );
}
