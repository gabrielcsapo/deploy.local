import { taskRequirementsSnapshot } from '../workspace/task-workspace.ts';
import { approvedTaskDesign, taskDesignCheck } from './design-check.ts';
import { ensureDesignCheckBoards } from './design.ts';
import { mergingPackages } from '../packages/pipeline-read.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationEvent } from '../../shared/v2/contracts.ts';
import { cursor, events, get, list, listCheckpointMetadata } from '../workspace/store.ts';
import { gitText } from '../workspace/repository-git.ts';
import { repositoryInfo } from '../workspace/repositories.ts';
import { mapConversationEvent } from './events.ts';
import { scrubCheckText } from '../workspace/workspace-verification.ts';
import { publishedTaskChecks, taskWorkspaceChecks } from '../workspace/workspace-checks.ts';
import { checkAttempts } from '../../shared/check-attempts.ts';
import { projectsForOwner } from './projects.ts';
import { getDeployments } from '../store.ts';
import { pullFiles } from './pull-files.ts';

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
  const firstRun = runs[0];
  const firstWorker = list('worker', owner).find((item) => item.id === firstRun?.workerId);
  const startedModel =
    firstWorker?.modelOptions
      ?.find((option: any) => option.id === firstRun?.adapter)
      ?.models?.find((model: any) => model.id === firstRun?.model)?.name || firstRun?.model;
  const checkpoints = listCheckpointMetadata(owner, id);
  checkpoints.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const checkpoint = checkpoints.at(-1);
  const recorded = new Map(
    [...list('check', owner), ...list('job', owner)]
      .filter((check) => check.taskId === id)
      .map((check) => [check.id, check]),
  );
  // Use the same digest/watermark provenance as the published description, including shell checks.
  const history = checkpoints.map((item, index) => {
    const checks = publishedTaskChecks(
      owner,
      { ...task, publishedCheckRuns: [] },
      item,
      item.id,
    ).filter((check) => check.commit === item.id);
    return {
      id: item.id,
      number: index + 1,
      at: item.createdAt,
      published: item.id === task.publishedCheckpointId,
      commit: item.id === task.publishedCheckpointId ? task.publishedCommit : undefined,
      checks: checkAttempts(checks, (check) => check.label || check.command || check.id).map(
        ({ latest }) => {
          const detail = recorded.get(latest.id);
          return detail
            ? {
                ...latest,
                name: detail.name,
                output: scrubCheckText(String(detail.output || '')).slice(-64000),
                startedAt: detail.startedAt,
                finishedAt: detail.finishedAt || detail.completedAt,
              }
            : latest;
        },
      ),
    };
  });
  // Each pull request carries the files dropped into its description.
  const pulls = list('pull-request', owner)
    .filter((pull) => pull.projectId === task.projectId && pull.taskIds?.includes(id))
    .map((pull) => ({ ...pull, files: pullFiles(owner, pull.id) }));
  const designCheck = taskDesignCheck(owner, id);
  return {
    ...taskRequirementsSnapshot(owner, task),
    ...(designCheck ? { designCheck } : {}),
    task: {
      id: task.id,
      title: task.title,
      projectId: task.projectId,
      status: task.status,
      revision: task.revision,
      sourceRef: task.sourceRef,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      branch: task.workspaceCommit?.branch || task.publishedBranch,
      startedBy: task.startedBy,
      startedFrom: task.startedFrom,
      startedModel,
    },
    // A run of an agent shows which agent it runs as and links to the job, its standing instructions.
    agent: runsAs ? { id: runsAs.id, name: runsAs.name } : undefined,
    project: project && {
      id: project.id,
      name: project.name,
      kind: undefined as string | undefined,
      address: undefined as string | undefined,
    },
    computerId: worker?.id,
    computer: worker?.name || (task.workerId === 'local' ? 'This computer' : undefined),
    run: run && {
      adapter: run.adapter,
      model: run.model,
      modelName: worker?.modelOptions
        ?.find((option: any) => option.id === run.adapter)
        ?.models?.find((model: any) => model.id === run.model)?.name,
      status: run.status,
      updatedAt: run.updatedAt,
    },
    checkpoint: checkpoint && { number: checkpoints.length, at: checkpoint.createdAt },
    checkpoints: history,
    comparison: undefined as { ahead: number; behind: number } | undefined,
    events: [...conversation.values()],
    cursor: cursor(owner),
    firstTask: list('task', owner).length === 1,
    pulls,
    checks: [
      ...list('check', owner).filter((check) => check.taskId === id),
      ...(!checkpoint ? taskWorkspaceChecks(owner, id) : []),
    ],
    screenshots: list('screenshot', owner).filter((shot) => shot.taskId === id),
    releases: [],
    packages: [] as { name: string; version: string; previousVersion?: string }[],
    // Task sourceRef is its checkout baseline, not the agent's latest published work.
    // Ship a linked PR branch; the project default branch is resolved by tasksApi below.
    ship: project ? { ref: pulls.at(-1)?.sourceBranch } : undefined,
  };
}

export async function tasksApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const match = new URL(req.url!, 'http://localhost').pathname.match(/^\/api\/v2\/tasks\/([^/]+)$/);
  if (!match || req.method !== 'GET') return false;
  const taskId = decodeURIComponent(match[1]);
  const approved = approvedTaskDesign(owner, taskId);
  if (approved)
    await ensureDesignCheckBoards(
      owner,
      get('project', owner, approved.context.projectId),
      approved,
    );
  const snapshot = taskSnapshot(owner, taskId);
  if (snapshot.project) {
    try {
      const repository = await repositoryInfo(owner, snapshot.project.id);
      if ('defaultBranch' in repository && snapshot.ship && !snapshot.ship.ref)
        snapshot.ship.ref = repository.defaultBranch;
      const pull = snapshot.pulls.at(-1);
      if (pull && pull.status === 'open') {
        const project = get('project', owner, snapshot.project.id);
        snapshot.packages = await mergingPackages(owner, project, pull);
        const counts = await gitText(project.repositoryPath, [
          'rev-list',
          '--left-right',
          '--count',
          `refs/heads/${pull.targetBranch}...refs/heads/${pull.sourceBranch}`,
          '--',
        ]);
        const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
        snapshot.comparison = { ahead, behind };
      }
    } catch {
      // Keep the task readable when its repository is unavailable; Ship stays disabled.
    }
  }
  if (snapshot.project) {
    try {
      const project = (await projectsForOwner(owner)).find(
        (item) => item.id === snapshot.project!.id,
      );
      if (project?.apps.length === 1) {
        const app = project.apps[0];
        snapshot.project.kind = app.kind === 'web' ? 'Web app' : 'Worker';
        const deployment = getDeployments(owner).find((item) => item.name === app.name);
        if (app.kind === 'web' && deployment?.port)
          snapshot.project.address = `${deployment.name}.local`;
      }
    } catch {
      // App metadata is optional; an unlinked or unavailable app has no project subtitle.
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(snapshot));
  return true;
}
