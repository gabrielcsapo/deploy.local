type Row = Record<string, any>;

export type RunRecovery = {
  runId: string;
  state: 'waiting-for-computer' | 'process-running' | 'needs-confirmation' | 'resolved';
  title: string;
  detail: string;
  canMarkStopped: boolean;
  stopRequested: boolean;
};

const title = 'Interrupted — the computer restarted during this run';

/**
 * The latest run when a computer restart interrupted it. While its status is 'unknown' it still
 * holds the task's writer slot, so the composer waits until it is resolved.
 */
export function runRecovery(runs: Row[] | undefined): RunRecovery | null {
  const run = runs?.at(-1);
  if (!run) return null;
  if (run.recoveryView) return { runId: run.id, ...run.recoveryView };
  // A coordinator from before restart recovery still reports the bare status.
  if (run.status !== 'unknown') return null;
  return {
    runId: run.id,
    state: 'needs-confirmation',
    title,
    detail: 'Update deploy.local to resolve this run from here.',
    canMarkStopped: false,
    stopRequested: Boolean(run.stopRequested),
  };
}

/** True while an interrupted run still blocks new messages. */
export const recoveryBlocksComposer = (recovery: RunRecovery | null) =>
  Boolean(recovery && recovery.state !== 'resolved');
