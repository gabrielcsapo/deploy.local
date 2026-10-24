'use client';
import { useState } from 'react';
import { Button, TextField } from '@/components/ui';
import { publishTitle } from '../../../shared/task-title';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
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
  latestCheckpoint?: {
    id: string;
    createdAt: string;
    fileCount: number;
    fresh: boolean;
    reason?: string | null;
  } | null;
  diff: Row | null;
  busy: boolean;
  api: (path: string, body?: Row) => Promise<any>;
  published: (pull: Row) => void;
}) {
  const pull = pulls.find((p) => p.status === 'open') || pulls.find((p) => p.status === 'merged');
  const [editedTitle, setTitle] = useState<string | null>(null);
  const [editedBody, setBody] = useState<string | null>(null);
  // The suggested description is Markdown; show it rendered, as the pull request will, until edited.
  const [editingBody, setEditingBody] = useState(false);
  const title = editedTitle ?? defaults?.title ?? publishTitle(task.title);
  const body = editedBody ?? defaults?.body ?? '';
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  const branch = pull?.sourceBranch || `task/${task.id.replaceAll('-', '').slice(0, 8)}`;
  const merged = pull?.status === 'merged' || task.status === 'merged';
  const incomplete = !!(diff?.truncated || diff?.excluded?.length);
  const checkpoint = incomplete && latestCheckpoint?.fresh ? latestCheckpoint : null;
  const changed = !!checkpoint || diff?.hasUnpublishedChanges === true;
  const disabled =
    busy ||
    publishing ||
    !diff ||
    (!checkpoint && (incomplete || !diff.patch)) ||
    !title.trim() ||
    (task.workspaceStatus && task.workspaceStatus !== 'ready');
  const reason = !diff
    ? 'Loading changes…'
    : busy
      ? 'Wait for the active operation to finish.'
      : task.workspaceStatus && task.workspaceStatus !== 'ready'
        ? 'Workspace is not ready.'
        : diff.truncated || diff.excluded?.length
          ? checkpoint
            ? `Captured ${new Date(checkpoint.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${checkpoint.fileCount} files · the full change set`
            : latestCheckpoint
              ? latestCheckpoint.reason ||
                'Commands or edits ran after this checkpoint; ask the agent to capture a new checkpoint as its last step'
              : 'The diff is incomplete. Ask the agent to capture a new checkpoint to publish the full change set.'
          : !diff.patch
            ? diff.status?.includes('not been uploaded')
              ? diff.status
              : 'No changes to publish.'
            : pull && !changed
              ? diff.hasUnpublishedChanges === false
                ? 'No unpublished changes.'
                : 'Refresh changes to compare with the pull request.'
              : '';
  async function publish() {
    setPublishing(true);
    setError('');
    try {
      const result = await api(`/tasks/${task.id}/publish`, {
        revision: task.revision,
        ...(checkpoint ? { checkpointId: checkpoint.id } : {}),
        ...(pull ? {} : { title: title.trim(), body }),
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
      {!merged && (
        <>
          {!pull && (
            <>
              <TextField
                label="Pull request title"
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
            variant={!pull || changed ? 'primary' : 'link'}
            disabled={disabled || (!!pull && !changed)}
            onClick={() => void publish()}
          >
            {publishing
              ? 'Publishing…'
              : checkpoint
                ? 'Publish latest checkpoint'
                : pull?.status === 'open'
                  ? 'Update pull request'
                  : 'Publish as pull request'}
          </Button>
        </>
      )}
      {!merged && reason && (
        <p className="pw-muted" role="status">
          {reason}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
