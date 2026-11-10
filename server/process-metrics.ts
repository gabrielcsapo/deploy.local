import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export type ProcessMetrics = {
  sampledAt: number;
  windowMs: number;
  eventLoopDelayMs: { p50: number; p99: number; max: number };
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
};

/** Only supervised children create a histogram. Sampling resets its minute window. */
export function createProcessSampler() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let started = performance.now();
  return {
    sample(): ProcessMetrics {
      const now = performance.now();
      const memory = process.memoryUsage();
      const ms = (nanoseconds: number) => Math.round(nanoseconds / 100000) / 10;
      const sample = {
        sampledAt: Date.now(),
        windowMs: Math.round(now - started),
        eventLoopDelayMs: {
          p50: histogram.count ? ms(histogram.percentile(50)) : 0,
          p99: histogram.count ? ms(histogram.percentile(99)) : 0,
          max: histogram.count ? ms(histogram.max) : 0,
        },
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
      };
      histogram.reset();
      started = now;
      return sample;
    },
    close() {
      histogram.disable();
    },
  };
}

/** Malformed optional telemetry cannot interfere with heartbeat liveness. */
export function processMetrics(value: unknown): ProcessMetrics | null {
  if (!value || typeof value !== 'object') return null;
  const sample = value as ProcessMetrics;
  if (
    !sample.eventLoopDelayMs ||
    ![
      sample.sampledAt,
      sample.windowMs,
      sample.rssBytes,
      sample.heapUsedBytes,
      sample.heapTotalBytes,
      sample.eventLoopDelayMs.p50,
      sample.eventLoopDelayMs.p99,
      sample.eventLoopDelayMs.max,
    ].every((number) => typeof number === 'number' && Number.isFinite(number) && number >= 0)
  )
    return null;
  return {
    sampledAt: sample.sampledAt,
    windowMs: sample.windowMs,
    eventLoopDelayMs: {
      p50: sample.eventLoopDelayMs.p50,
      p99: sample.eventLoopDelayMs.p99,
      max: sample.eventLoopDelayMs.max,
    },
    rssBytes: sample.rssBytes,
    heapUsedBytes: sample.heapUsedBytes,
    heapTotalBytes: sample.heapTotalBytes,
  };
}

export function slowProcessLine(name: string, pid: number | undefined, sample: ProcessMetrics) {
  const { p50, p99, max } = sample.eventLoopDelayMs;
  if (p99 <= 200 && max <= 1000) return null;
  const mib = (bytes: number) => Math.round(bytes / 1024 / 1024);
  return `[supervisor] ${name} (pid ${pid}) event-loop p50=${p50}ms p99=${p99}ms max=${max}ms rss=${mib(sample.rssBytes)}MiB heap=${mib(sample.heapUsedBytes)}/${mib(sample.heapTotalBytes)}MiB window=${sample.windowMs}ms`;
}
