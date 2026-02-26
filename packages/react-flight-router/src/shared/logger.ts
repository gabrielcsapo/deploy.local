import type { TimingEntry } from "./types.js";

const supportsColor =
  typeof process !== "undefined" && process.stdout?.isTTY === true && !process.env.NO_COLOR;

const c = {
  bold: (s: string) => (supportsColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (supportsColor ? `\x1b[2m${s}\x1b[22m` : s),
  cyan: (s: string) => (supportsColor ? `\x1b[36m${s}\x1b[39m` : s),
  green: (s: string) => (supportsColor ? `\x1b[32m${s}\x1b[39m` : s),
  magenta: (s: string) => (supportsColor ? `\x1b[35m${s}\x1b[39m` : s),
  yellow: (s: string) => (supportsColor ? `\x1b[33m${s}\x1b[39m` : s),
};

export interface FlightTimer {
  /** Record the start of a named phase */
  time(label: string): void;
  /** Record the end of a named phase, returns duration in ms */
  timeEnd(label: string): number;
  /** Print all collected timings to stderr (skipped in silent mode) */
  flush(headline: string): void;
  /**
   * Wrap a ReadableStream so that timing is flushed when the stream finishes.
   * Calls timeEnd("total") and flush(headline) after the last chunk is consumed.
   * Use this for streams returned directly to the client (RSC navigation, actions)
   * where the actual rendering happens lazily during stream consumption.
   *
   * If `streamLabel` is provided (e.g. "rsc:stream"), a timing entry is recorded
   * from the first chunk to the last chunk — capturing async rendering time that
   * happens inside the stream (Suspense boundaries, data fetching, etc.).
   *
   * The optional onComplete callback fires after timing is flushed.
   */
  wrapStream(
    stream: ReadableStream,
    headline: string,
    onComplete?: () => void,
    streamLabel?: string,
  ): ReadableStream;
  /**
   * Return a copy of the collected timing entries. Closes any still-open entries.
   * The "total" entry is included; filter it out if you only want sub-phases.
   */
  getEntries(): TimingEntry[];
}

/** FlightLogger is either a timer or undefined (disabled). Use optional chaining at callsites. */
export type FlightLogger = FlightTimer | undefined;

/** Internal timing entry with start time for duration calculation */
interface InternalTimingEntry {
  label: string;
  startMs: number;
  durationMs?: number;
  depth: number;
}

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Pick headline color based on request type: SSR=green, RSC=cyan, ACTION=magenta */
function headlineColor(headline: string): string {
  if (headline.startsWith("SSR")) return c.green(`[flight] ${headline}`);
  if (headline.startsWith("ACTION")) return c.magenta(`[flight] ${headline}`);
  return c.cyan(`[flight] ${headline}`);
}

/**
 * Mask dynamic route param values in a pathname to avoid exposing PII in logs.
 * Replaces each matched param value with `****`.
 *
 * @example maskParams("/posts/hello-world", { id: "hello-world" }) → "/posts/****"
 */
export function maskParams(pathname: string, params: Record<string, string>): string {
  if (!params || Object.keys(params).length === 0) return pathname;
  const paramValues = new Set(Object.values(params));
  return pathname
    .split("/")
    .map((segment) => (paramValues.has(segment) ? "****" : segment))
    .join("/");
}

export function createFlightLogger(options?: { silent?: boolean }): FlightTimer {
  const silent = options?.silent ?? false;
  const entries: InternalTimingEntry[] = [];
  const active = new Map<string, InternalTimingEntry>();
  let currentDepth = 0;

  function closeOpenEntries() {
    for (const [, entry] of active) {
      entry.durationMs = performance.now() - entry.startMs;
    }
    active.clear();
  }

  const timer: FlightTimer = {
    time(label: string) {
      const entry: InternalTimingEntry = { label, startMs: performance.now(), depth: currentDepth };
      active.set(label, entry);
      entries.push(entry);
      currentDepth++;
    },

    timeEnd(label: string): number {
      const entry = active.get(label);
      if (!entry) return 0;
      entry.durationMs = performance.now() - entry.startMs;
      active.delete(label);
      currentDepth = Math.max(0, currentDepth - 1);
      return entry.durationMs;
    },

    flush(headline: string) {
      closeOpenEntries();

      if (silent) return;

      // Find total duration from a "total" entry if present
      const totalEntry = entries.find((e) => e.label === "total");
      const totalStr =
        totalEntry?.durationMs != null ? `  ${formatDuration(totalEntry.durationMs)}` : "";

      console.error(headlineColor(headline) + c.bold(totalStr));

      for (const entry of entries) {
        if (entry.durationMs == null || entry.label === "total") continue;
        const dur = formatDuration(entry.durationMs);
        const indent = "  " + "  ".repeat(entry.depth);
        const padLen = Math.max(1, 34 - indent.length - entry.label.length);
        const colorFn = entry.durationMs > 100 ? c.yellow : c.dim;
        console.error(`${indent}${entry.label}${" ".repeat(padLen)} ${colorFn(dur)}`);
      }
    },

    wrapStream(
      stream: ReadableStream,
      headline: string,
      onComplete?: () => void,
      streamLabel?: string,
    ): ReadableStream {
      const self = timer;
      let streamTimerStarted = false;
      return stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (!streamTimerStarted && streamLabel) {
              self.time(streamLabel);
              streamTimerStarted = true;
            }
            controller.enqueue(chunk);
          },
          flush() {
            if (streamLabel) {
              self.timeEnd(streamLabel);
            }
            self.timeEnd("total");
            self.flush(headline);
            onComplete?.();
          },
        }),
      );
    },

    getEntries(): TimingEntry[] {
      closeOpenEntries();
      return entries.map((e) => ({ label: e.label, durationMs: e.durationMs, depth: e.depth }));
    },
  };

  return timer;
}

/** Check if debug mode is enabled via env var or programmatic option */
export function isDebugEnabled(programmatic?: boolean): boolean {
  if (programmatic !== undefined) return programmatic;
  return process.env.FLIGHT_DEBUG === "1" || process.env.FLIGHT_DEBUG === "true";
}

/**
 * Create a logger if debug mode is enabled or a callback needs timing data.
 * When undefined, all timing callsites are skipped via optional chaining.
 *
 * @param programmatic - Explicit debug flag from options
 * @param hasCallback - Whether an onRequestComplete callback is registered
 */
export function maybeCreateLogger(programmatic?: boolean, hasCallback?: boolean): FlightLogger {
  const debugOn = isDebugEnabled(programmatic);
  if (debugOn) return createFlightLogger();
  if (hasCallback) return createFlightLogger({ silent: true });
  return undefined;
}
