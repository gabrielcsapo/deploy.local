'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
type Row = Record<string, any>;

export function UpdateBase({
  task,
  busy,
  api,
}: {
  task: Row;
  busy: boolean;
  api: (path: string, body?: Row) => Promise<any>;
}) {
  const [operation, setOperation] = useState<Row | null>(task.baseUpdate || null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setOperation(task.baseUpdate || null);
  }, [task.id, task.baseUpdate]);
  const pending = operation && !['succeeded', 'aborted'].includes(operation.status);
  const running = operation && ['queued', 'preparing', 'prepared'].includes(operation.status);
  useEffect(() => {
    if (!running) return;
    let disposed = false;
    const timer = setInterval(() => {
      void api(`/tasks/${task.id}`)
        .then((value) => {
          if (!disposed) setOperation(value.task.baseUpdate);
        })
        .catch((failure) => {
          if (!disposed) setError(failure.message);
        });
    }, 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [running, task.id, api]);
  async function update(action: string) {
    setSending(true);
    setError('');
    try {
      setOperation(await api(`/tasks/${task.id}/update-base`, { action }));
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSending(false);
    }
  }
  return (
    <div>
      <Button
        variant="link"
        disabled={busy || sending || !!running}
        onClick={() => void update(pending ? 'continue' : 'update')}
      >
        {running
          ? 'Updating from main…'
          : pending
            ? operation.status === 'failed'
              ? 'Resume update'
              : 'Continue update'
            : 'Update from main'}
      </Button>
      {pending && (
        <Button variant="link" disabled={busy || sending} onClick={() => void update('abort')}>
          Abort update
        </Button>
      )}
      {operation && (
        <p className="pw-muted" role="status">
          {operation.status === 'conflicted'
            ? `Resolve conflicts: ${operation.conflicts.join(', ')}`
            : operation.status === 'succeeded'
              ? `Up to date with ${operation.targetBranch}.`
              : operation.status === 'aborted'
                ? 'Update aborted; workspace restored.'
                : operation.status === 'failed'
                  ? operation.error
                  : 'Waiting for the task computer to finish the update.'}
        </p>
      )}
      {operation?.error && operation.status !== 'failed' && <p role="alert">{operation.error}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
