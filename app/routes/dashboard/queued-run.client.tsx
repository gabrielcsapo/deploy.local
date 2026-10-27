'use client';
import { Button } from '@/components/ui';

type QueueComputer = {
  id: string;
  name: string;
  activeTaskCount?: number;
  queuedTaskCount?: number;
};
type Queue = {
  reason: string;
  position: number | null;
  total: number;
  moveUnavailableReason?: string | null;
  alternatives: QueueComputer[];
};

export function QueuedRun({
  queue,
  busy,
  move,
}: {
  queue: Queue;
  busy: boolean;
  move: (workerId: string) => void;
}) {
  const allBusy =
    queue.alternatives.length > 0 &&
    queue.alternatives.every(
      (computer) => (computer.activeTaskCount ?? 0) + (computer.queuedTaskCount ?? 0) > 0,
    );
  return (
    <div>
      <strong>Queued</strong>
      <p>
        {queue.reason}
        {queue.total > 1 ? ` · Position ${queue.position ?? 'pending'} of ${queue.total}` : ''}
      </p>
      {queue.moveUnavailableReason && <p>{queue.moveUnavailableReason}</p>}
      {allBusy && <p>Every alternative is busy; moving won’t start this task sooner.</p>}
      {queue.alternatives.map((computer) => (
        <Button key={computer.id} variant="link" disabled={busy} onClick={() => move(computer.id)}>
          Move to {computer.name}
          {(computer.activeTaskCount ?? 0) > 0
            ? ` · busy with ${computer.activeTaskCount} ${computer.activeTaskCount === 1 ? 'task' : 'tasks'}`
            : ''}
          {(computer.queuedTaskCount ?? 0) > 0 ? ` · ${computer.queuedTaskCount} queued` : ''}
        </Button>
      ))}
    </div>
  );
}
