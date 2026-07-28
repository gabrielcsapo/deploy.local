/**
 * Detect errors caused by the Vite dev server tearing down or replacing the
 * module runner that evaluated our modules.
 *
 * Vite restarts the dev server (and closes the old environments' module
 * runners) when the config or an env file changes, when a plugin calls
 * `server.restart()`, or when dependency re-optimization forces a reload. Any
 * import closure captured from a module the *old* runner evaluated throws once
 * that happens. The render that hits it is not broken — it just needs to be
 * retried against the new runner after dropping cached module references.
 */
const STALE_MODULE_MESSAGES = [
  "Vite module runner has been closed",
  "was mistakenly invalidated during fetch phase",
  "The server is being restarted",
  "server is being restarted",
  "Vite server has been closed",
  "The server is being closed",
  // The module runner talks to the dev server over an RPC transport. Closing
  // the server disconnects it and rejects every in-flight call — most often
  // `fetchModule`, issued while evaluating a module we imported. Same cause as
  // a closed runner, different message because the failure surfaces on the
  // transport rather than on the runner itself.
  "transport was disconnected",
];

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  // Vite revives RPC errors as plain objects when they don't survive
  // structured cloning as Error instances.
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { message?: unknown }).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return String(err ?? "");
}

export function isStaleModuleError(err: unknown): boolean {
  // A stale-module failure is often re-thrown wrapped — Vite's `reviveInvokeError`
  // attaches the original as `cause`, and a module that fails while several
  // imports are in flight surfaces as an AggregateError. Walk the whole chain so
  // the wrapper is not mistaken for an application error.
  const seen = new Set<unknown>();
  const queue = [err];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);

    const message = messageOf(current);
    if (STALE_MODULE_MESSAGES.some((m) => message.includes(m))) return true;

    if (typeof current === "object") {
      const cause = (current as { cause?: unknown }).cause;
      if (cause !== undefined) queue.push(cause);
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) queue.push(...errors);
    }
  }

  return false;
}

/**
 * Run `fn`, retrying when it fails because the module runner went away.
 *
 * A restart takes a moment to swap in new environments, so retries back off
 * slightly. `onStale` runs before each retry to evict caches holding modules
 * from the dead runner.
 */
export async function withStaleModuleRetry<T>(
  fn: () => Promise<T>,
  onStale: () => void,
  retryDelaysMs: readonly number[] = [0, 100, 300],
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isStaleModuleError(err) || attempt === retryDelaysMs.length) throw err;
      lastError = err;
      onStale();
      const delay = retryDelaysMs[attempt];
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable — the loop either returns or throws.
  throw lastError;
}
