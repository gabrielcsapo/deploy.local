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
  /** Print all collected timings to stderr */
  flush(headline: string): void;
  /**
   * Wrap a ReadableStream so that timing is flushed when the stream finishes.
   * Calls timeEnd("total") and flush(headline) after the last chunk is consumed.
   * Use this for streams returned directly to the client (RSC navigation, actions)
   * where the actual rendering happens lazily during stream consumption.
   */
  wrapStream(stream: ReadableStream, headline: string): ReadableStream;
}

/** FlightLogger is either a timer or undefined (disabled). Use optional chaining at callsites. */
export type FlightLogger = FlightTimer | undefined;

interface TimingEntry {
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

export function createFlightLogger(): FlightTimer {
  const entries: TimingEntry[] = [];
  const active = new Map<string, TimingEntry>();
  let currentDepth = 0;

  const timer: FlightTimer = {
    time(label: string) {
      const entry: TimingEntry = { label, startMs: performance.now(), depth: currentDepth };
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
      // Close any still-open entries
      for (const [, entry] of active) {
        entry.durationMs = performance.now() - entry.startMs;
      }
      active.clear();

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

    wrapStream(stream: ReadableStream, headline: string): ReadableStream {
      const self = timer;
      return stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
          flush() {
            self.timeEnd("total");
            self.flush(headline);
          },
        }),
      );
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
 * Create a logger if debug mode is enabled, otherwise return undefined.
 * When undefined, all timing callsites are skipped via optional chaining.
 */
export function maybeCreateLogger(programmatic?: boolean): FlightLogger {
  return isDebugEnabled(programmatic) ? createFlightLogger() : undefined;
}
