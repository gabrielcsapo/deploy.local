import { activityEvents, get, list } from './store.ts';
import { validateSnapshot } from './checkpoint.ts';
import { checkpointChangedFileCount } from './follow-up.ts';

export const staleCheckpointMessage =
  'Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step';
const active = (run: any) => ['queued', 'starting', 'running', 'unknown'].includes(run.status);
const timestamp = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);

/** Checkpoint provenance is the authenticated task/run pair recorded by deploy_checkpoint.
 * Worker paths are not portable and older workers do not send a workspace path with snapshots. */
function provenance(owner: string, taskId: string, checkpoint: any) {
  if (checkpoint.taskId !== taskId) return false;
  return list('run', owner).some((run) => run.id === checkpoint.runId && run.taskId === taskId);
}

export function checkpointPublishReason(
  owner: string,
  taskId: string,
  checkpoint: any,
): string | null {
  if (!provenance(owner, taskId, checkpoint))
    return 'Checkpoint was not captured from this task workspace';
  const runs = list('run', owner).filter((run) => run.taskId === taskId);
  if (runs.some(active)) return 'A run is active; stop it before publishing';
  const captured = timestamp(checkpoint.createdAt);
  if (!Number.isFinite(captured)) return staleCheckpointMessage;
  // Agents capture checkpoints during their run, so the run always ends after its last
  // checkpoint; run completion can't be the boundary. Instead the checkpoint must come
  // from the latest run, and no shell command or file change from that run may have been
  // recorded after it. Both timestamps are coordinator receive times (never worker clocks),
  // and events arrive no earlier than they happen, so a late-delivered event only errs
  // towards stale. Shell commands count because agents often write files with them.
  const started = (run: any) => timestamp(run.createdAt ?? run.updatedAt);
  const latest = [...runs].sort((a, b) => started(a) - started(b)).at(-1);
  if (latest && latest.id !== checkpoint.runId) return staleCheckpointMessage;
  const later = activityEvents(owner, taskId).some(
    (event) =>
      event.runId === checkpoint.runId &&
      ['command_execution', 'file_change'].includes(event.payload?.item?.type) &&
      timestamp(event.createdAt) > captured,
  );
  if (later) return staleCheckpointMessage;
  if (checkpoint.snapshot?.excluded?.length)
    return 'This checkpoint excludes files; ask the agent to capture a complete checkpoint';
  return null;
}

export function publishCheckpoint(owner: string, taskId: string, checkpointId: unknown) {
  if (typeof checkpointId !== 'string' || !checkpointId)
    throw new Error('checkpointId must be a nonempty string');
  const checkpoint = get('checkpoint', owner, checkpointId);
  if (!provenance(owner, taskId, checkpoint))
    throw Object.assign(new Error('Checkpoint was not captured from this task workspace'), {
      status: 403,
    });
  const reason = checkpointPublishReason(owner, taskId, checkpoint);
  if (reason) throw Object.assign(new Error(reason), { status: 409 });
  return { ...checkpoint, snapshot: validateSnapshot(checkpoint.snapshot) };
}

export function latestCheckpointSummary(owner: string, taskId: string) {
  const checkpoint = list('checkpoint', owner)
    .filter((row) => row.taskId === taskId)
    .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt))
    .at(-1);
  if (!checkpoint) return null;
  const reason = checkpointPublishReason(owner, taskId, checkpoint);
  // Files the checkpoint changes against the task's diff base (the merged commit after a
  // merge), so clients can tell new work from an already-merged change set.
  let changedFileCount: number | null = null;
  try {
    const task = get('task', owner, taskId);
    if (task.projectId && task.baseRevision)
      changedFileCount = checkpointChangedFileCount(
        get('project', owner, task.projectId).repositoryPath,
        checkpoint.id,
        checkpoint.snapshot,
        task.baseRevision,
      );
  } catch {
    changedFileCount = null;
  }
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.snapshot.files.length,
    changedFileCount,
    fresh: reason === null,
    reason,
  };
}
