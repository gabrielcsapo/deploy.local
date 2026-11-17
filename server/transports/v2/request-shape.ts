/** What a request's range, path and sender look like, shared by Requests and Traffic. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const REQUEST_RANGES = {
  '1h': { ms: HOUR, bucketMs: MINUTE },
  '24h': { ms: DAY, bucketMs: 15 * MINUTE },
  '7d': { ms: 7 * DAY, bucketMs: 2 * HOUR },
  '30d': { ms: 30 * DAY, bucketMs: 6 * HOUR },
} as const;
export type RequestRange = keyof typeof REQUEST_RANGES;

/** A path with its IDs (numbers, UUIDs, long hex or tokens) folded to :id. */
export function normalizePath(path: string) {
  return path
    .split('/')
    .map((segment) =>
      /^\d+$/.test(segment) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
      /^[0-9a-f]{16,}$/i.test(segment) ||
      (segment.length >= 24 && /^[A-Za-z0-9_-]+$/.test(segment) && /\d/.test(segment))
        ? ':id'
        : segment,
    )
    .join('/');
}

/** "Safari on iPhone" from a user agent; the raw value when nothing matches. */
export function describeBrowser(agent: string | null): string | null {
  if (!agent) return null;
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\/|CriOS\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : /^curl\//.test(agent)
            ? 'curl'
            : null;
  const system = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? 'Android'
        : /Mac OS X|Macintosh/.test(agent)
          ? 'Mac'
          : /Windows/.test(agent)
            ? 'Windows'
            : /Linux/.test(agent)
              ? 'Linux'
              : null;
  if (!browser) return agent;
  return system ? `${browser} on ${system}` : browser;
}
