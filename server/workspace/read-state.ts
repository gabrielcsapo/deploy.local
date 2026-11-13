import type { WorkspaceState } from '../../shared/v2/contracts.ts';
import { list, cursor } from './store.ts';
import { addressedProjects } from './repositories.ts';
import { tasksWaitingForAnswer } from './questions.ts';
import { taskQueue } from './run-queue.ts';
import { taskPullSummary } from './task-presentation.ts';
import { pendingControlRequests } from './interactive.ts';
import { presentRun } from './run-recovery.ts';
import { capabilities } from './service.ts';
export async function readWorkspaceState(owner: string) {
  const pulls = list('pull-request', owner);
  const waitingForAnswer = tasksWaitingForAnswer(owner);
  const runs = list('run', owner);
  // The latest run's status, so a stopped agent run reads Stopped in lists, not Finished.
  const runStatus = new Map(
    [...runs]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((run) => [run.taskId, run.status]),
  );
  const state = {
    version: 1,
    cursor: cursor(owner),
    projects: addressedProjects(owner),
    tasks: ((controls) =>
      list('task', owner).map((task) => ({
        ...taskQueue(owner, taskPullSummary(task, pulls), { runs, pulls }),
        runStatus: runStatus.get(task.id) ?? null,
        controlRequest: controls.get(task.id) ?? null,
        waitingForAnswer: waitingForAnswer.has(task.id),
      })))(pendingControlRequests(owner)),
    // The instructions each run was started with are for its worker, which reads the run
    // itself. No client shows them, and they were most of this response.
    runs: runs.map((run) => {
      const { agentContext: _, ...shown } = presentRun(owner, run);
      return shown;
    }),
    ...(await capabilities(owner)),
  };

  return state satisfies WorkspaceState;
}
