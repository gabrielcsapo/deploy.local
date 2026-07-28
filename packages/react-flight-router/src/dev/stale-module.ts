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
];

export function isStaleModuleError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  return STALE_MODULE_MESSAGES.some((m) => message.includes(m));
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
