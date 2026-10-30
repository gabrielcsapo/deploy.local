import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationEvent } from '../../shared/v2/contracts.ts';
import { cursor, events, get, list } from '../workspace/store.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import { mapConversationEvent } from './events.ts';

/** Read stored evidence only: this snapshot never starts a runner or touches a repository. */
export function taskSnapshot(owner: string, id: string) {
  const task = get('task', owner, id);
  const project = task.projectId ? get('project', owner, task.projectId) : undefined;
  const runs = list('run', owner).filter((run) => run.taskId === id);
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const conversation = new Map<string, ConversationEvent>();
  let after = 0;
  for (;;) {
    const rows = events(owner, after, id);
    for (const row of rows) {
      const mapped = mapConversationEvent(row, byRun.get(row.runId));
      // The task-created link belongs in its parent conversation, not its own transcript.
      if (mapped && !(mapped.kind === 'task' && mapped.taskId === id))
        conversation.set(mapped.id, mapped);
      after = row.cursor;
    }
    if (rows.length < 1000) break;
  }
  const worker = list('worker', owner).find((item) => item.id === task.workerId);
  const runsAs = task.agentId && list('agent', owner).find((item) => item.id === task.agentId);
  const run = runs.at(-1);
  const checkpoints = list('checkpoint', owner).filter((item) => item.taskId === id);
  const checkpoint = checkpoints.at(-1);
  const pulls = list('pull-request', owner).filter(
    (pull) => pull.projectId === task.projectId && pull.taskIds?.includes(id),
  );
  return {
    task: {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      status: task.status,
      revision: task.revision,
      sourceRef: task.sourceRef,
      createdAt: task.createdAt,
    },
    // A run of an agent shows which agent it runs as and links to the job, its standing instructions.
    agent: runsAs ? { id: runsAs.id, name: runsAs.name } : undefined,
    project: project && {
      id: project.id,
      name: project.name,
      repository: `/api/workspace/git/${encodeURIComponent(project.id)}`,
    },
    computer: worker?.name || (task.workerId === 'local' ? 'This computer' : undefined),
    run: run && {
      adapter: run.adapter,
      model: run.model,
      status: run.status,
      updatedAt: run.updatedAt,
    },
    checkpoint: checkpoint && { number: checkpoints.length, at: checkpoint.createdAt },
    events: [...conversation.values()],
    cursor: cursor(owner),
    firstTask: list('task', owner).length === 1,
    pulls,
    checks: list('check', owner).filter((check) => check.taskId === id),
    screenshots: list('screenshot', owner).filter((shot) => shot.taskId === id),
    releases: [],
    // Task sourceRef is its checkout baseline, not the agent's latest published work.
    // Ship a linked PR branch; the project default branch is resolved by tasksApi below.
    ship: project ? { ref: pulls.at(-1)?.sourceBranch } : undefined,
  };
}

export async function tasksApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const match = new URL(req.url!, 'http://localhost').pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/);
  if (!match || req.method !== 'GET') return false;
  const snapshot = taskSnapshot(owner, decodeURIComponent(match[1]));
  if (snapshot.project && !snapshot.ship?.ref) {
    try {
      const repository = await repositoryInfo(owner, snapshot.project.id);
      if ('defaultBranch' in repository && snapshot.ship)
        snapshot.ship.ref = repository.defaultBranch;
    } catch {
      // Keep the task readable when its repository is unavailable; Ship stays disabled.
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(snapshot));
  return true;
}
