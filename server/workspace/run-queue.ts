import { hasTools } from './tool-probes.ts';
import { computers } from './coordination.ts';
import { workerRoleEnabled } from './computer-role-policy.ts';
import { db, event, get, list, now, revise, save } from './store.ts';

const holding = ['starting', 'running', 'unknown'];
export function workerLoad(owner: string, workerId: string, allRuns?: any[]) {
  const runs = (allRuns ?? list('run', owner)).filter((r) => r.workerId === workerId);
  return {
    activeTaskCount: new Set(runs.filter((r) => holding.includes(r.status)).map((r) => r.taskId))
      .size,
    queuedTaskCount: runs.filter((r) => r.status === 'queued' && !r.stopRequested).length,
  };
}

/** Match the worker's FIFO order, excluding work it cannot claim yet. */
export function runQueue(owner: string, run: any) {
  if (run.status !== 'queued') return null;
  const task = get('task', owner, run.taskId);
  const workers = computers(owner);
  const worker = workers.find((w) => w.id === run.workerId);
  const name = worker?.name || run.workerId;
  const runs = list('run', owner);
  const ready = (r: any) => {
    const t = get('task', owner, r.taskId);
    return !r.stopRequested && (!t.workspaceStatus || t.workspaceStatus === 'ready');
  };
  const queue = runs.filter(
    (r) => r.workerId === run.workerId && r.status === 'queued' && ready(r),
  );
  const blocker = runs.find((r) => r.workerId === run.workerId && holding.includes(r.status));
  const position = queue.findIndex((r) => r.id === run.id) + 1;
  const reason = run.stopRequested
    ? 'Waiting for cancellation'
    : task.workspaceStatus && task.workspaceStatus !== 'ready'
      ? 'Waiting for workspace preparation'
      : worker?.status !== 'online'
        ? `Waiting for ${name} — offline`
        : !workerRoleEnabled(owner, run.workerId, 'tasks')
          ? `Waiting for ${name} — tasks role is off`
          : blocker
            ? `Waiting for ${name} — ${blocker.status === 'unknown' ? 'resolving interrupted task' : 'busy with'} ${get('task', owner, blocker.taskId).title}`
            : `Waiting for ${name} to pick up this run`;
  // A previously used workspace may have uncommitted files and provider sessions on its
  // computer. Moving those requires a workspace transfer, not merely a new worker ID.
  const canMove =
    !runs.some((r) => r.taskId === task.id && r.id !== run.id) &&
    !list('message', owner).some((m) => m.taskId === task.id && m.shell) &&
    !db
      .prepare(
        "SELECT 1 FROM events WHERE owner=? AND taskId=? AND type='terminal.started' LIMIT 1",
      )
      .get(owner, task.id);
  const alternatives =
    canMove && !run.stopRequested
      ? workers
          .filter(
            (w) =>
              hasTools(owner, w.id, task.needs?.tools) &&
              w.id !== run.workerId &&
              w.id !== 'local' &&
              w.status === 'online' &&
              workerRoleEnabled(owner, w.id, 'tasks') &&
              w.capabilities.includes(run.adapter) &&
              (!w.connections?.length ||
                w.connections.some(
                  (c: any) => c.provider === run.adapter && c.available && c.enabled !== false,
                )),
          )
          .map((w) => ({ id: w.id, name: w.name, ...workerLoad(owner, w.id) }))
          .sort(
            (a, b) =>
              Number(a.activeTaskCount + a.queuedTaskCount > 0) -
                Number(b.activeTaskCount + b.queuedTaskCount > 0) ||
              a.activeTaskCount + a.queuedTaskCount - b.activeTaskCount - b.queuedTaskCount ||
              a.name.localeCompare(b.name),
          )
      : [];
  return {
    reason,
    position: position || null,
    total: queue.length,
    alternatives,
    moveUnavailableReason: canMove
      ? null
      : 'This task already has a workspace on its computer. Moving it requires a workspace transfer.',
  };
}

/**
 * A task with its queue position. A caller presenting many tasks passes the runs and pull
 * requests it already read, so they are not read again for every task.
 */
export function taskQueue(owner: string, task: any, loaded: { runs?: any[]; pulls?: any[] } = {}) {
  task = {
    ...task,
    ...(task.baseUpdate
      ? {
          baseUpdate: {
            ...task.baseUpdate,
            needsPublication:
              task.baseUpdate.status === 'succeeded' &&
              !!task.pendingMergeCommit &&
              (loaded.pulls ?? list('pull-request', owner)).some(
                (p) => p.status === 'open' && p.taskIds?.includes(task.id),
              ),
          },
        }
      : {}),
  };
  const run = (loaded.runs ?? list('run', owner)).find(
    (r) => r.taskId === task.id && r.status === 'queued',
  );
  return run
    ? { ...task, status: 'queued', queue: runQueue(owner, run) }
    : { ...task, queue: null };
}

export function moveQueuedRun(owner: string, taskId: string, input: any) {
  return db.transaction(() => {
    const task = get('task', owner, taskId);
    revise(task, input.revision);
    const run = list('run', owner).find((r) => r.taskId === taskId && r.status === 'queued');
    if (!run || !runQueue(owner, run)?.alternatives.some((w) => w.id === input.workerId))
      throw Object.assign(new Error('This queued run cannot move to that computer'), {
        status: 409,
      });
    save('run', owner, { ...run, workerId: input.workerId, sessionId: null, updatedAt: now() });
    const saved = save('task', owner, {
      ...task,
      workerId: input.workerId,
      revision: task.revision + 1,
      updatedAt: now(),
    });
    event(owner, taskId, run.id, 'run.moved', { from: run.workerId, workerId: input.workerId });
    return saved;
  })();
}
