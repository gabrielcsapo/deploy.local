/**
 * Liveness signal to the supervisor. A process whose event loop is wedged (a deadlock, a
 * synchronous call that never returns) stays alive, so the supervisor's restart-on-exit never
 * fires. Each supervised process sends a heartbeat from its event loop; the supervisor kills
 * and restarts one whose heartbeat goes stale (server/supervisor.ts).
 *
 * A no-op without a supervisor: `pnpm dev`, `start:single`, tests and worker threads have no
 * IPC channel.
 */
const HEARTBEAT_MS = 3000;

let timer: ReturnType<typeof setInterval> | null = null;

export function startSupervisorHeartbeat(intervalMs = HEARTBEAT_MS) {
  if (timer || typeof process.send !== 'function') return;
  const beat = () => {
    if (!process.connected) {
      if (timer) clearInterval(timer);
      return;
    }
    // The callback keeps a closed channel from surfacing as an uncaught error.
    process.send!({ type: 'heartbeat' }, undefined, undefined, () => {});
  };
  timer = setInterval(beat, intervalMs);
  // Neither the timer nor the channel may keep a stopping process alive.
  timer.unref();
  beat();
}
