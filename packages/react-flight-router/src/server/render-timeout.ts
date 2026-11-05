/**
 * Race a render Promise against a timeout. If the timeout fires first,
 * `onTimeout()` runs (typically aborts an AbortController so in-progress
 * work can wind down) and the result is `{ timedOut: true }`. If the
 * promise settles first, the timer is cleared and the result is
 * `{ timedOut: false, value }` (or the rejection propagates).
 *
 * When `timeoutMs` is undefined or 0, the helper is a no-op pass-through
 * — the wrapped Promise is awaited normally with no timer overhead.
 *
 * The default behavior is opt-in via the `renderTimeoutMs` server option:
 * a 504 response if a route's render exceeds the bound. Without this,
 * a single misbehaving server component (e.g. `await fetch(...)` against
 * an unreachable upstream with no timeout) would pin the request slot
 * until the client gave up, exhausting connections under load.
 */
export type RenderTimeoutResult<T> = { timedOut: false; value: T } | { timedOut: true };

export async function withRenderTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  onTimeout?: () => void,
): Promise<RenderTimeoutResult<T>> {
  if (!timeoutMs || timeoutMs <= 0) {
    return { timedOut: false, value: await promise };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // Defensive: an onTimeout that throws should not poison the
        // race result. A 504 is more useful than an unhandled rejection.
      }
      resolve({ timedOut: true });
    }, timeoutMs);
  });

  try {
    const winner = await Promise.race<RenderTimeoutResult<T>>([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
