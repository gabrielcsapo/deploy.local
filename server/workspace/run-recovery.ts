import { db, get, list, save, event, now, revise } from './store.ts';
import { releaseQueuedMessage } from './queued-message.ts';
import {
  previousProcess,
  restartInterruptedError,
  restartInterruptedTitle,
} from './restart-recovery.ts';

// A run is 'unknown' when its worker restarted and could not tell whether the agent process it
// launched is still writing to the task workspace. It keeps the task's single writer slot until
// one of these resolves it, so a second writer can never start beside a survivor:
//  - worker-attested: the run's worker, as a process other than the one that started the run,
//    states it holds no assignment state (`noAssignment` on poll), or reports that the agent's
//    process group no longer exists (complete with 'interrupted').
//  - stopped-after-restart: the user pressed Stop and an older worker build that cannot attest
//    polled from a new process. Older workers only poll when they hold no assignment state.
//  - user-confirmed: the user explicitly confirmed nothing from the run is still running. Refused
//    while the worker's last report says the agent process is still alive.

type Method = 'worker-attested' | 'stopped-after-restart' | 'user-confirmed';
const writerStatuses = ['starting', 'running', 'unknown'];

/** Move a run left behind by a restart to 'interrupted' and free its task and worker. */
export function resolveRestartedRun(
  owner: string,
  runId: string,
  method: Method,
  details: Record<string, unknown> = {},
) {
  const run = get('run', owner, runId);
  if (!writerStatuses.includes(run.status)) return run;
  const resolved = save('run', owner, {
    ...run,
    status: 'interrupted',
    error: restartInterruptedError,
    // Duration ends where the restart was recorded, not when someone resolved it.
    updatedAt: run.status === 'unknown' ? run.updatedAt : now(),
    recovery: {
      ...run.recovery,
      ...details,
      method,
      resolvedAt: now(),
      previousStatus: run.status,
      previousError: run.error ?? null,
    },
  });
  const task = get('task', owner, run.taskId);
  save('task', owner, { ...task, status: 'review', revision: task.revision + 1, updatedAt: now() });
  event(owner, run.taskId, run.id, 'run.interrupted', {
    status: 'interrupted',
    error: restartInterruptedError,
    recovery: method,
  });
  releaseQueuedMessage(owner, run.taskId, 'interrupted');
  return resolved;
}

/**
 * A poll for a run that a different process of this worker started. Returns true when the run
 * was resolved, so the poll can hand out new work instead of the stale assignment.
 */
export function reconcileStalePoll(
  owner: string,
  run: any,
  instanceId: string | undefined,
  attestsNoAssignment: boolean,
) {
  if (!instanceId || run.assignedInstanceId === instanceId) return false;
  if (attestsNoAssignment) {
    resolveRestartedRun(owner, run.id, 'worker-attested', { attestedBy: instanceId });
    return true;
  }
  if (run.status === 'unknown' && run.stopRequested) {
    resolveRestartedRun(owner, run.id, 'stopped-after-restart', { attestedBy: instanceId });
    return true;
  }
  // An older worker build: remember that a stateless process polled, so Stop resolves at once.
  if (run.status === 'unknown' && run.recovery?.idleInstanceId !== instanceId)
    save('run', owner, {
      ...run,
      recovery: { ...run.recovery, idleInstanceId: instanceId, idleAt: now() },
    });
  return false;
}

/** The restarted worker's report about a run it could not reconcile on its own. */
export function unknownReport(instanceId: string | undefined, process: unknown) {
  return { process: previousProcess(process), reportedBy: instanceId ?? null, reportedAt: now() };
}

/** Stop on a restarted run resolves it when a stateless worker process has already polled. */
export function stopRestartedRun(owner: string, run: any) {
  if (
    run.status === 'unknown' &&
    run.recovery?.idleInstanceId &&
    run.recovery.idleInstanceId !== run.assignedInstanceId
  )
    return resolveRestartedRun(owner, run.id, 'stopped-after-restart', {
      attestedBy: run.recovery.idleInstanceId,
    });
  return null;
}

/** The explicit "I've checked — mark stopped" confirmation. */
export function markRunStopped(owner: string, taskId: string, input: any) {
  const task = get('task', owner, taskId);
  revise(task, input.revision);
  const run = list('run', owner).find((r) => r.taskId === taskId && r.status === 'unknown');
  if (!run)
    throw Object.assign(new Error('This task has no interrupted run to resolve'), { status: 409 });
  if (input.confirm !== true)
    throw new Error('Confirm that nothing from the previous run is still running');
  if (run.recovery?.process === 'alive')
    throw Object.assign(
      new Error(
        'The computer reports the previous agent process is still running. Stop it on that computer; this resolves once it exits.',
      ),
      { status: 409 },
    );
  resolveRestartedRun(owner, run.id, 'user-confirmed', {
    confirmedBy: owner,
    confirmedAt: now(),
  });
  return get('task', owner, taskId);
}

function workerOnline(owner: string, workerId: string) {
  const heartbeat =
    !workerId || workerId === 'local'
      ? (db.prepare("SELECT heartbeat FROM worker WHERE id='local'").get() as any)?.heartbeat
      : list('worker', owner).find((worker) => worker.id === workerId)?.heartbeat;
  return Boolean(heartbeat) && Date.now() - Date.parse(heartbeat) < 10000;
}
function workerName(owner: string, workerId: string) {
  if (!workerId || workerId === 'local') return 'This computer';
  return list('worker', owner).find((worker) => worker.id === workerId)?.name || 'The computer';
}

export type RecoveryView = {
  state: 'waiting-for-computer' | 'process-running' | 'needs-confirmation' | 'resolved';
  title: string;
  detail: string;
  canMarkStopped: boolean;
  stopRequested: boolean;
};

/** How clients present a run left behind by a restart; undefined for every other run. */
export function recoveryView(owner: string, run: any): RecoveryView | undefined {
  const base = { title: restartInterruptedTitle, stopRequested: Boolean(run.stopRequested) };
  if (run.status !== 'unknown')
    return run.recovery?.resolvedAt && run.status === 'interrupted'
      ? {
          ...base,
          state: 'resolved',
          detail: 'Its last changes are in the task workspace. Send a message to continue.',
          canMarkStopped: false,
        }
      : undefined;
  const name = workerName(owner, run.workerId);
  const alive = run.recovery?.process === 'alive';
  if (!workerOnline(owner, run.workerId))
    return {
      ...base,
      state: 'waiting-for-computer',
      detail: alive
        ? `${name} is offline. It last reported that the previous agent is still running, so this waits until it comes back online.`
        : `${name} is offline. When it comes back online it confirms the previous agent is gone and this resolves. If you've checked that nothing from this run is still running there, you can mark it stopped now.`,
      canMarkStopped: !alive,
    };
  if (alive)
    return {
      ...base,
      state: 'process-running',
      detail: `${name} reports the previous agent is still running. Stop it on that computer; this resolves once it exits.`,
      canMarkStopped: false,
    };
  return {
    ...base,
    state: 'needs-confirmation',
    detail: run.recovery?.idleInstanceId
      ? `${name} restarted and isn't running this anymore, but its version can't confirm that on its own. Mark it stopped to continue.`
      : `${name} can't confirm whether the previous agent stopped. Check that computer, then mark it stopped to continue.`,
    canMarkStopped: true,
  };
}

export function presentRun(owner: string, run: any) {
  const view = recoveryView(owner, run);
  return view ? { ...run, recoveryView: view } : run;
}
