// Shared by the coordinator and the remote worker; it must not import the store.

/** The error a run keeps once a restart that interrupted it has been resolved. */
export const restartInterruptedError =
  'The computer restarted during this run; its last changes are in the task workspace';
export const restartInterruptedTitle = 'Interrupted — the computer restarted during this run';
export const restartUnknownError =
  'Remote worker restarted; previous process must be reconciled before assigning another writer';

/** What a restarted worker can say about the agent process it lost track of. */
export type PreviousProcess = 'alive' | 'unverified';
export const previousProcess = (value: unknown): PreviousProcess | null =>
  value === 'alive' || value === 'unverified' ? value : null;

/**
 * Whether anything in the detached agent's process group still exists. Agents are spawned with
 * `detached: true`, so their pid is also their process-group id and their own children share it.
 * `false` is definitive (no process in that group exists); `true` may be a reused id, which only
 * errs toward waiting; `null` means no pid was recorded, so nothing can be said.
 */
export function processGroupAlive(pid: unknown): boolean | null {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== 'ESRCH';
  }
}
