/**
 * In-memory window of Docker RestartCount samples per deployment.
 *
 * Docker's RestartCount is cumulative — it monotonically increases over a
 * container's lifetime. To detect a crash loop ("restarted 3+ times in the
 * last 5 minutes") we keep a rolling history of (count, ts) samples and
 * compare the current count to the oldest sample inside the window.
 *
 * No DB state — restart history rebuilds itself within a window after a
 * server restart. That's fine because a fresh container starts at
 * RestartCount=0 anyway; we'd see the climb from there.
 */

const WINDOW_MS = 5 * 60 * 1000;
const CRASH_THRESHOLD = 3;
const MAX_SAMPLES_PER_APP = 32;

interface Sample {
  count: number;
  ts: number;
}

const history = new Map<string, Sample[]>();

export function setRestartCount(name: string, count: number) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const samples = history.get(name) ?? [];

  // Append the new sample, drop anything older than the window. Cap the
  // array length so a pathological loop can't grow it unbounded between
  // ticks (e.g. if WINDOW_MS gets raised).
  samples.push({ count, ts: now });
  while (samples.length > 0 && samples[0].ts < cutoff) {
    samples.shift();
  }
  while (samples.length > MAX_SAMPLES_PER_APP) {
    samples.shift();
  }
  history.set(name, samples);
}

/** True if the container's RestartCount climbed by 3+ inside the last 5 minutes. */
export function isCrashLooping(name: string): boolean {
  const samples = history.get(name);
  if (!samples || samples.length < 2) return false;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  return newest.count - oldest.count >= CRASH_THRESHOLD;
}

/** Drop tracking state for a deleted deployment so old data doesn't linger. */
export function forgetApp(name: string) {
  history.delete(name);
}

/** Test/debug helper. */
export function _resetCrashTracker() {
  history.clear();
}
