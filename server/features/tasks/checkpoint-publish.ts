import {
  activityEvents,
  get,
  list,
  listCheckpointMetadata,
  checkpointInfo,
} from '../../workspace/store.ts';
import { validateSnapshot } from './checkpoint.ts';
import { checkpointChangedFileCount } from './follow-up.ts';

export const staleCheckpointMessage =
  'Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step';
const active = (run: any) => ['queued', 'starting', 'running', 'unknown'].includes(run.status);
const timestamp = (value: unknown) => (typeof value === 'string' ? Date.parse(value) : NaN);

/** Checkpoints come from an authenticated task/run capture or a completed base update whose
 * installed commit still matches the task. Worker paths are not portable provenance. */
function provenance(owner: string, taskId: string, checkpoint: any) {
  if (checkpoint.taskId !== taskId) return false;
  if (checkpoint.baseUpdateId) {
    const task = get('task', owner, taskId);
    const update = list('base-update', owner).find((op) => op.id === checkpoint.baseUpdateId);
    return (
      update?.status === 'succeeded' &&
      update.id === checkpoint.baseUpdateId &&
      update.generation === checkpoint.baseUpdateGeneration &&
      update.taskId === taskId &&
      update.commit === checkpointInfo(checkpoint).baseCommit &&
      task.workspaceCommit?.commit === update.commit &&
      checkpoint.createdAt === update.completedAt
    );
  }
  return list('run', owner).some((run) => run.id === checkpoint.runId && run.taskId === taskId);
}

export function checkpointPublishReason(
  owner: string,
  taskId: string,
  checkpoint: any,
  // A caller that already loaded this task's activity passes it in; task detail reads it anyway.
  events?: any[],
): string | null {
  if (!provenance(owner, taskId, checkpoint))
    return 'Checkpoint was not captured from this task workspace';
  const update = get('task', owner, taskId).baseUpdate;
  if (
    update?.status === 'succeeded' &&
    update.beforeCommit &&
    !checkpoint.baseUpdateId &&
    timestamp(checkpoint.createdAt) <= timestamp(update.completedAt)
  )
    return 'Update from main changed the workspace; capture a new checkpoint before publishing';
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
  if (
    latest &&
    (checkpoint.baseUpdateId ? started(latest) > captured : latest.id !== checkpoint.runId)
  )
    return staleCheckpointMessage;
  const later = (events ?? activityEvents(owner, taskId)).some(
    (event) =>
      (checkpoint.baseUpdateId || event.runId === checkpoint.runId) &&
      ['command_execution', 'file_change'].includes(event.payload?.item?.type) &&
      timestamp(event.createdAt) > captured,
  );
  if (later) return staleCheckpointMessage;
  if (checkpointInfo(checkpoint).excludedCount)
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

const latestCheckpoint = (owner: string, taskId: string) =>
  listCheckpointMetadata(owner, taskId)
    .sort((a, b) => timestamp(a.createdAt) - timestamp(b.createdAt))
    .at(-1) ?? null;

/**
 * The version a publication would carry, and how a recorded run says it ran against it.
 *
 * `digest` is the content of the task's latest checkpoint, and only while that checkpoint still
 * stands for the workspace: once a command or edit lands after it, nothing recorded against it
 * describes what would be published, so the digest is empty and only runs at the current edit
 * watermark are current. `title` and `summary` are the agent's own naming of its change, which
 * publication prefers over anything derived from the request.
 */
export function publishHead(owner: string, taskId: string, events?: any[]) {
  const checkpoint = latestCheckpoint(owner, taskId);
  const fresh = Boolean(
    checkpoint && checkpointPublishReason(owner, taskId, checkpoint, events) === null,
  );
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    checkpointId: fresh ? checkpoint!.id : null,
    digest: fresh ? (checkpointInfo(checkpoint).digest ?? null) : null,
    title: text(checkpoint?.title),
    summary: text(checkpoint?.summary),
  };
}

export function latestCheckpointSummary(owner: string, taskId: string) {
  const checkpoint = latestCheckpoint(owner, taskId);
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
        get('checkpoint', owner, checkpoint.id).snapshot,
        task.baseRevision,
      );
  } catch {
    changedFileCount = null;
  }
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    fileCount: checkpointInfo(checkpoint).fileCount,
    changedFileCount,
    fresh: reason === null,
    reason,
  };
}
