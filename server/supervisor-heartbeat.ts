import { performance } from 'node:perf_hooks';
import { createProcessSampler } from './process-metrics.ts';

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

export function startSupervisorHeartbeat(intervalMs = HEARTBEAT_MS, sampleMs = 60000) {
  if (timer || typeof process.send !== 'function') return;
  const sampler = createProcessSampler();
  let sampledAt = performance.now();
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    sampler.close();
  };
  // No 'disconnect' listener: a listener on the channel keeps a stopping process alive, and
  // the workers stop by letting their event loop empty. The next beat notices the closed channel.
  const beat = () => {
    if (!process.connected) {
      stop();
      return;
    }
    // The callback keeps a closed channel from surfacing as an uncaught error.
    const now = performance.now();
    const metrics = now - sampledAt >= sampleMs ? sampler.sample() : undefined;
    if (metrics) sampledAt = now;
    process.send!(
      { type: 'heartbeat', ...(metrics ? { metrics } : {}) },
      undefined,
      undefined,
      () => {},
    );
  };
  timer = setInterval(beat, intervalMs);
  // Neither the timer nor the channel may keep a stopping process alive.
  timer.unref();
  // No heartbeat until the timer first fires: the supervisor watches from the first one, and
  // startup (migrations, certificates) may block for longer than it would wait. A process that
  // has not finished starting is not yet one that can be called wedged.
}
