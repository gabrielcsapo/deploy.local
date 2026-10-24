'use client';
import { useState } from 'react';
import { Button, ConfirmDialog, WorkspaceIcon } from '@/components/ui';
import type { RunRecovery } from './run-recovery';

/** Shown above the composer for a run a computer restart interrupted. */
export function RunRecoveryNotice({
  recovery,
  disabled = false,
  markStopped,
}: {
  recovery: RunRecovery;
  disabled?: boolean;
  markStopped?: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const waiting = recovery.state !== 'resolved';
  return (
    <div
      className={`pw-queued pw-run-recovery ${waiting ? 'is-held' : ''}`}
      role="status"
      data-recovery={recovery.state}
    >
      <WorkspaceIcon name={waiting ? 'alert' : 'stop'} />
      <div>
        <strong>{recovery.title}</strong>
        <p>{recovery.detail}</p>
      </div>
      {recovery.canMarkStopped && markStopped && (
        <Button disabled={disabled} onClick={() => setConfirming(true)}>
          Mark as stopped…
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        title="Mark this run as stopped?"
        message="Only do this after checking that nothing from this run is still running on that computer. Its last changes stay in the task workspace, and your next message continues the conversation."
        confirmLabel="I’ve checked — mark stopped"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          markStopped?.();
        }}
      />
    </div>
  );
}
