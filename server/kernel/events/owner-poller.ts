/** One cheap SQLite head check per owner, regardless of the number of waiting requests. */
export function createOwnerEventPoller(deps: {
  head(owner: string): number;
  refresh(owner: string): Promise<void>;
}) {
  type Waiter = { after: number; deadline: number; finish(error?: unknown): void };
  type Owner = {
    waiters: Set<Waiter>;
    timer?: ReturnType<typeof setTimeout>;
    polling: boolean;
    nextAt?: number;
  };
  const owners = new Map<string, Owner>();

  function schedule(owner: string, state: Owner) {
    if (owners.get(owner) !== state || state.polling) return;
    const deadline = Math.min(...[...state.waiters].map((waiter) => waiter.deadline));
    const nextAt = Math.min(Date.now() + 50, deadline);
    // New arrivals must not keep postponing the existing check.
    if (state.timer && state.nextAt! <= nextAt) return;
    clearTimeout(state.timer);
    state.nextAt = nextAt;
    state.timer = setTimeout(() => void poll(owner, state), Math.max(0, nextAt - Date.now()));
  }
  async function poll(owner: string, state: Owner) {
    state.timer = undefined;
    state.polling = true;
    try {
      await deps.refresh(owner);
      if (owners.get(owner) !== state) return;
      const head = deps.head(owner);
      for (const waiter of state.waiters)
        if (head > waiter.after || Date.now() >= waiter.deadline) waiter.finish();
    } catch (error) {
      // Fail promptly; the next request can create a fresh poller after a transient DB error.
      for (const waiter of state.waiters) waiter.finish(error);
    } finally {
      state.polling = false;
      schedule(owner, state);
    }
  }

  return {
    wait(owner: string, after: number, deadline: number, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      let state = owners.get(owner);
      if (!state) {
        state = { waiters: new Set(), polling: false };
        owners.set(owner, state);
      }
      const current = state;
      return new Promise((resolve, reject) => {
        const abort = () => waiter.finish(signal.reason);
        const waiter: Waiter = {
          after,
          deadline,
          finish(error) {
            if (!current.waiters.delete(waiter)) return;
            signal.removeEventListener('abort', abort);
            if (!current.waiters.size) {
              clearTimeout(current.timer);
              owners.delete(owner);
            }
            if (error !== undefined) reject(error);
            else resolve();
          },
        };
        current.waiters.add(waiter);
        signal.addEventListener('abort', abort, { once: true });
        schedule(owner, current);
      });
    },
  };
}
