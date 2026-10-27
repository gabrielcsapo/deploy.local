'use client';
import { UpdateBase } from './update-base.client';
import { useState } from 'react';
import { Button, TextField } from '@/components/ui';
import { changeTitle } from '../../../shared/task-title';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
export type CheckpointSummary = {
  id: string;
  createdAt: string;
  fileCount: number;
  /** Files changed against the task's diff base; the merged commit once its pull request merged. */
  changedFileCount?: number | null;
  fresh: boolean;
  reason?: string | null;
};

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/**
 * What the Changes card offers. A task is a conversation: after its pull request merges, the
 * merged pull request stays as history and new work publishes as a follow-up pull request.
 */
export function taskPublishState({
  task,
  pulls,
  latestCheckpoint,
  diff,
  busy,
}: {
  task: Row;
  pulls: Row[];
  latestCheckpoint?: CheckpointSummary | null;
  diff: Row | null;
  busy: boolean;
}) {
  const open = pulls.find((p) => p.status === 'open');
  const mergedPull = pulls
    .filter((p) => p.status === 'merged')
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .at(-1);
  const pull = open || mergedPull;
  const merged = !open && (!!mergedPull || task.status === 'merged');
  const incomplete = !!(diff?.truncated || diff?.excluded?.length);
  // The task computer has not uploaded changes against the current baseline (for example the
  // merged commit) yet; a fresh checkpoint still holds the exact work.
  const pending = !!diff && !diff.patch && diff.baselinePending === true;
  const checkpointChanges =
    latestCheckpoint?.changedFileCount ??
    (merged && mergedPull?.mergedAt && latestCheckpoint
      ? latestCheckpoint.createdAt > mergedPull.mergedAt
        ? latestCheckpoint.fileCount
        : 0
      : latestCheckpoint?.fileCount);
  const updated = !!open && task.baseUpdate?.needsPublication === true;
  const checkpoint =
    (incomplete || pending || updated) &&
    latestCheckpoint?.fresh &&
    (updated || checkpointChanges !== 0)
      ? latestCheckpoint
      : null;
  const changed = updated || !!checkpoint || diff?.hasUnpublishedChanges === true;
  const followUp = merged && changed;
  const since = mergedPull ? `since #${mergedPull.number} merged` : 'since the merge';
  const nothingNew = merged ? `No changes ${since}.` : null;
  const time = (value: string) =>
    new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const reason = (() => {
    if (!diff) return 'Loading changes…';
    if (task.baseUpdate && !['succeeded', 'aborted'].includes(task.baseUpdate.status))
      return 'Finish or abort Update from main before publishing.';
    if (busy) return 'Wait for the active operation to finish.';
    if (task.workspaceStatus && task.workspaceStatus !== 'ready') return 'Workspace is not ready.';
    if (updated && checkpoint) return 'Main merged into this task — Update pull request.';
    if (checkpoint)
      return `Captured ${time(checkpoint.createdAt)} · ${files(checkpointChanges ?? checkpoint.fileCount)} · ${followUp ? since : 'the full change set'}`;
    if (incomplete || pending) {
      if (latestCheckpoint?.fresh && checkpointChanges === 0)
        return nothingNew || 'No changes to publish.';
      if (latestCheckpoint)
        return (
          latestCheckpoint.reason ||
          'Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step'
        );
      return incomplete
        ? 'The diff is incomplete. Ask the agent to capture a new checkpoint to publish the full change set.'
        : diff.status;
    }
    if (!diff.patch)
      return diff.status?.includes('not been uploaded')
        ? diff.status
        : nothingNew || 'No changes to publish.';
    if (pull && !changed)
      return diff.hasUnpublishedChanges === false
        ? nothingNew || 'No unpublished changes.'
        : 'Refresh changes to compare with the pull request.';
    return '';
  })();
  const disabled =
    busy ||
    (task.baseUpdate && !['succeeded', 'aborted'].includes(task.baseUpdate.status)) ||
    !diff ||
    (!checkpoint && (incomplete || !diff.patch)) ||
    (task.workspaceStatus && task.workspaceStatus !== 'ready');
  return {
    open,
    mergedPull,
    pull,
    merged,
    checkpoint,
    changed,
    followUp,
    /** Whether publish controls show: always before a merge, and after one only with new work. */
    offer: !merged || followUp,
    reason,
    disabled: Boolean(disabled),
    action: followUp
      ? 'Publish follow-up'
      : updated
        ? 'Update pull request'
        : checkpoint
          ? 'Publish latest checkpoint'
          : open
            ? 'Update pull request'
            : 'Publish as pull request',
  };
}

export function TaskPublish({
  task,
  pulls,
  defaults,
  latestCheckpoint,
  diff,
  busy,
  api,
  published,
}: {
  task: Row;
  pulls: Row[];
  defaults?: { title: string; body: string };
  latestCheckpoint?: CheckpointSummary | null;
  diff: Row | null;
  busy: boolean;
  api: (path: string, body?: Row) => Promise<any>;
  published: (pull: Row) => void;
}) {
  const state = taskPublishState({ task, pulls, latestCheckpoint, diff, busy });
  const { open, pull, merged, checkpoint, changed, reason } = state;
  const [editedTitle, setTitle] = useState<string | null>(null);
  const [editedBody, setBody] = useState<string | null>(null);
  // The suggested description is Markdown; show it rendered, as the pull request will, until edited.
  const [editingBody, setEditingBody] = useState(false);
  const title = editedTitle ?? defaults?.title ?? changeTitle(task.title);
  const body = editedBody ?? defaults?.body ?? '';
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const branch = pull?.sourceBranch || `task/${task.id.replaceAll('-', '').slice(0, 8)}`;
  const disabled = state.disabled || publishing || !title.trim();
  async function publish() {
    setPublishing(true);
    setError('');
    try {
      const result = await api(`/tasks/${task.id}/publish`, {
        revision: task.revision,
        ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
        ...(open ? {} : { title: title.trim(), body }),
      });
      published(result.pull);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPublishing(false);
    }
  }
  return (
    <div className="ph-composer">
      {pull && (
        <Button variant="link" onClick={() => published(pull)}>
          #{pull.number} {pull.title}
        </Button>
      )}
      <p className="pw-muted">
        {merged ? 'Merged' : pull?.status || 'Publish changes'} · <code>{branch}</code>
        {pull?.targetBranch ? ` → ${pull.targetBranch}` : ''}
      </p>
      {task.projectId && <UpdateBase task={task} busy={busy} api={api} />}
      {state.offer && (
        <>
          {!open && (
            <>
              <TextField
                label={state.followUp ? 'Follow-up pull request title' : 'Pull request title'}
                appearance="plain"
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
              />
              {body.trim() && !editingBody ? (
                <div className="ph-publish-description">
                  <MessageContent content={body} />
                  <Button variant="link" onClick={() => setEditingBody(true)}>
                    Edit description
                  </Button>
                </div>
              ) : (
                <label>
                  <span className="sr-only">Pull request description</span>
                  <textarea
                    placeholder="Pull request description (Markdown)"
                    rows={5}
                    maxLength={50000}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                </label>
              )}
            </>
          )}
          <Button
            variant={!open || changed ? 'primary' : 'link'}
            disabled={disabled || (!!open && !changed)}
            onClick={() => void publish()}
          >
            {publishing ? 'Publishing…' : state.action}
          </Button>
        </>
      )}
      {reason && (
        <p className="pw-muted" role="status">
          {reason}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
