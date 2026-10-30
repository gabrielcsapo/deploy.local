import { assembleAgentContext } from './agent-context.ts';
import { allComputerRoles, computers } from './coordination.ts';
import { get, list, now } from './store.ts';
import { agentInstructions } from '../v2/agent-instructions.ts';

/** Coordinator-owned snapshot, captured at assignment/start and carried unchanged to workers. */
export function runAgentContext(owner: string, run: { taskId: string; workerId?: string }) {
  const task = get('task', owner, run.taskId);
  const agent = agentInstructions(owner, task);
  const context = assembleAgentContext({
    task,
    project: task.projectId ? get('project', owner, task.projectId) : null,
    workerId: run.workerId || 'local',
    computers: allComputerRoles(owner),
    workers: computers(owner),
    origins: list('application-origin', owner),
    deployments: list('application-deployment', owner),
    coordinatorUrl: process.env.DEPLOY_COORDINATOR_URL || 'https://deploy.local',
  });
  return {
    agentContext: agent ? `${context}\n\n${agent}` : context,
    agentContextAt: now(),
  };
}
