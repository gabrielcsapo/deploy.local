import { useLayoutEffect, useRef } from 'react';

/** Opt-in, bounded local diagnostics. Records timings only, never conversation text. */
export function useWorkspacePerformance(detail: unknown, selected: string) {
  const output = useRef<HTMLOutputElement>(null);
  const pending = useRef<{ taskId: string; start: number } | null>(null);
  const applied = useRef<{ detail: unknown; start: number } | null>(null);
  const frames = useRef(new Set<number>());
  const samples = useRef<number[]>([]);
  const enabled =
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('workspacePerformance') === '1';

  useLayoutEffect(() => {
    const sample = applied.current;
    if (!enabled || !sample || sample.detail !== detail) return;
    applied.current = null;
    // The second frame callback gives the committed DOM a paint opportunity.
    // This is not GPU presentation timing and excludes server-to-client transport.
    const first = requestAnimationFrame(() => {
      frames.current.delete(first);
      const second = requestAnimationFrame(() => {
        frames.current.delete(second);
        if (document.visibilityState !== 'visible') return;
        samples.current.push(performance.now() - sample.start);
        samples.current = samples.current.slice(-200);
        const sorted = [...samples.current].sort((a, b) => a - b);
        if (output.current)
          output.current.textContent = JSON.stringify({
            metric: 'received-event-to-render-frame',
            count: sorted.length,
            p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
            samplesMs: samples.current,
          });
      });
      frames.current.add(second);
    });
    frames.current.add(first);
  }, [detail, enabled]);
  useLayoutEffect(() => {
    pending.current = null;
    applied.current = null;
    samples.current = [];
    if (output.current) output.current.textContent = '';
    const scheduledFrames = frames.current;
    return () => {
      for (const frame of scheduledFrames) cancelAnimationFrame(frame);
      scheduledFrames.clear();
    };
  }, [selected]);
  return {
    output,
    enabled,
    received(taskId: string) {
      if (enabled && document.visibilityState === 'visible' && !pending.current)
        pending.current = { taskId, start: performance.now() };
    },
    applying(taskId: string, nextDetail: unknown) {
      if (pending.current?.taskId !== taskId) return;
      applied.current = { detail: nextDetail, start: pending.current.start };
      pending.current = null;
    },
  };
}
