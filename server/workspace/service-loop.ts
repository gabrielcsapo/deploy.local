/**
 * A service's work loop with a heartbeat that does not wait for the work.
 *
 * The pipelines worker used to record its heartbeat at the start of each pass. A pass waits on
 * Git and can take longer than the 30 seconds readiness allows, so a busy but healthy worker
 * was reported stale. The heartbeat now ticks on every interval, whether or not a pass is still
 * running. It still stops when the event loop itself is blocked, which is what it is for.
 * Passes never overlap.
 */
export function startServiceLoop({
  beat,
  pass,
  intervalMs = 1000,
  onError = (error: unknown) => console.error(error),
}: {
  beat: () => void;
  pass: () => Promise<void> | void;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}): { stop(): void } {
  let busy = false;
  const timer = setInterval(async () => {
    try {
      beat();
    } catch (error) {
      onError(error);
    }
    if (busy) return;
    busy = true;
    try {
      await pass();
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
    }
  }, intervalMs);
  return { stop: () => clearInterval(timer) };
}
