'use client';
import { useEffect, useState } from 'react';
import { Button, TextField } from '@/components/ui';
import { taskTitle } from '../../../shared/task-title';
type Row = Record<string, any>;
export function TaskPublish({
  task,
  pulls,
  diff,
  busy,
  api,
  published,
}: {
  task: Row;
  pulls: Row[];
  diff: Row | null;
  busy: boolean;
  api: (path: string, body?: Row) => Promise<any>;
  published: (pull: Row) => void;
}) {
  const pull = pulls.find((p) => p.status === 'open') || pulls.find((p) => p.status === 'merged');
  const [title, setTitle] = useState(() => taskTitle(task.title));
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setTitle(taskTitle(task.title));
    setError('');
  }, [task.id, task.title]);
  const branch = pull?.sourceBranch || `task/${task.id.replaceAll('-', '').slice(0, 8)}`;
  const merged = pull?.status === 'merged' || task.status === 'merged';
  const changed = diff?.hasUnpublishedChanges === true;
  const disabled =
    busy ||
    publishing ||
    !diff ||
    diff.truncated ||
    diff.excluded?.length ||
    !diff.patch ||
    !title.trim() ||
    (task.workspaceStatus && task.workspaceStatus !== 'ready');
  const reason = !diff
    ? 'Loading changes…'
    : busy
      ? 'Wait for the active operation to finish.'
      : task.workspaceStatus && task.workspaceStatus !== 'ready'
        ? 'Workspace is not ready.'
        : diff.truncated || diff.excluded?.length
          ? 'The diff is incomplete. Refresh changes and resolve excluded files before publishing.'
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
        ...(pull ? {} : { title: title.trim() }),
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
            <TextField
              label="Pull request title"
              appearance="plain"
              value={title}
              maxLength={300}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
          <Button
            variant={!pull || changed ? 'primary' : 'link'}
            disabled={disabled || (!!pull && !changed)}
            onClick={() => void publish()}
          >
            {publishing
              ? 'Publishing…'
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
