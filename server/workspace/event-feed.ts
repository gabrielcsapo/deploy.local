import { setTimeout as delay } from 'node:timers/promises';
import { events } from './store.ts';

/** SQLite is shared with independent worker processes; do not rely on in-process emitters. */
export async function waitForEvents(
  owner: string,
  after: number,
  taskId: string | undefined,
  waitMs: number,
  signal: AbortSignal,
) {
  const deadline = Date.now() + Math.min(10_000, Math.max(0, waitMs));
  for (;;) {
    signal.throwIfAborted();
    const rows = events(owner, after, taskId);
    if (rows.length || Date.now() >= deadline)
      return { events: rows, cursor: rows.at(-1)?.cursor ?? after, supportsWait: true };
    await delay(Math.min(50, deadline - Date.now()), undefined, { signal });
  }
}
