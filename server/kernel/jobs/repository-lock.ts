/**
 * Bounds async work per key: at most `limit` run at once, the rest wait in arrival order. A waiter
 * is handed the finishing work's place directly, so the bound holds even if new work arrives
 * between the two.
 */
export function keyedSlots(limit: number) {
  const keys = new Map<string, { active: number; waiting: (() => void)[] }>();
  return async <T>(key: string, work: () => Promise<T>): Promise<T> => {
    let slots = keys.get(key);
    if (!slots) keys.set(key, (slots = { active: 0, waiting: [] }));
    const here = slots;
    if (here.active >= limit) await new Promise<void>((resolve) => here.waiting.push(resolve));
    else here.active += 1;
    try {
      return await work();
    } finally {
      const next = here.waiting.shift();
      if (next) next();
      else if (--here.active === 0) keys.delete(key);
    }
  };
}

/**
 * One writer at a time per repository, for sequences that read a ref, build on it and move it.
 * update-ref's expected value still guards against Git processes outside this server (a push, an
 * agent), which this does not stop. Hold it only across Git work: never while reading a request.
 */
export const withRepositoryWrites = keyedSlots(1);
