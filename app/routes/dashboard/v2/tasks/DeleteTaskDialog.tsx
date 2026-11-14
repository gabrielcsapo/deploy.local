'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Icon, Skeleton } from '@/components/ui';
import { authenticatedFetch } from '../data/hooks';
import { requestJson, workspaceCommand } from './api';
import type { TaskDeletion } from '../../../../../server/workspace/task-delete.ts';

/** The sentence that says what goes. A task with no branch says the same without the branch. */
export function deletionText(title: string, branch: string | null) {
  return branch
    ? `“${title}” is removed for good: its conversation, its saved checkpoints and its branch, ${branch}.`
    : `“${title}” is removed for good: its conversation and its saved checkpoints.`;
}
export function unmergedText(count: number) {
  return count === 1
    ? 'The branch has 1 commit that is not on main. It is deleted with it.'
    : `The branch has ${count} commits that are not on main. They are deleted with it.`;
}

/**
 * Asks before a task is deleted for good. A failure stays in the dialog; after the delete the
 * task's own page goes to the start page.
 */
export function DeleteTaskDialog({
  task,
  onClose,
}: {
  task: { id: string; title: string } | null;
  onClose: () => void;
}) {
  const [deletion, setDeletion] = useState<TaskDeletion | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const id = task?.id;
  useEffect(() => {
    setDeletion(null);
    setError('');
    setPending(false);
    if (!id) return;
    const controller = new AbortController();
    requestJson<TaskDeletion>(
      authenticatedFetch,
      `/api/workspace/tasks/${encodeURIComponent(id)}/deletion`,
      { signal: controller.signal },
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setDeletion(value);
        if (value.running) setError('Stop the task before deleting it');
      })
      .catch((reason) => {
        if (!controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Could not load the task.');
      });
    return () => controller.abort();
  }, [id]);
  async function remove() {
    if (!deletion || pending) return;
    setPending(true);
    setError('');
    try {
      await workspaceCommand(
        authenticatedFetch,
        `/tasks/${encodeURIComponent(deletion.id)}/delete`,
        { revision: deletion.revision },
      );
      const page = `/dashboard/tasks/${encodeURIComponent(deletion.id)}`;
      const path = window.location.pathname;
      if (path === page || path.startsWith(page + '/')) {
        window.location.assign('/dashboard');
        return;
      }
      // Lists read again now rather than on their next poll.
      window.dispatchEvent(new Event('deploy:agents-changed'));
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete the task. Try again.');
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open={!!task}
      onClose={onClose}
      title="Delete this task?"
      actions={
        <>
          <Action variant="quiet" onClick={onClose}>
            Cancel
          </Action>
          <Action
            variant="danger"
            loading={pending}
            disabled={!deletion || deletion.running}
            onClick={() => void remove()}
          >
            Delete task
          </Action>
        </>
      }
    >
      {deletion ? (
        <p className="dl-soft">{deletionText(deletion.title, deletion.branch)}</p>
      ) : (
        !error && <Skeleton rows={2} label="Loading task" />
      )}
      {!!deletion?.unmergedCommits && (
        <div className="dl-notice">
          <Icon name="attention" />
          <span>{unmergedText(deletion.unmergedCommits)}</span>
        </div>
      )}
      {error && <Banner kind="danger" title={error} />}
    </Dialog>
  );
}
