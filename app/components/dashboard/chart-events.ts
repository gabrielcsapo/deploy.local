/**
 * Shared shape for events that decorate a time-series chart — deploys,
 * restarts, recreates, config changes. Every chart with a time axis can
 * accept `ChartEvent[]` and render them as vertical marker lines at the
 * corresponding x-positions, so spikes in traffic / latency can be tied
 * back to "what was happening on the server right then".
 */

export type ChartEventKind =
  | 'deploy'
  | 'restart'
  | 'recreate'
  | 'delete'
  | 'backup'
  | 'restore'
  | 'env-update'
  | 'volumes-update'
  | 'ports-update'
  | 'memory-update'
  | 'gpu-update'
  | 'privileged-docker-update';

export interface ChartEvent {
  /** epoch ms timestamp */
  ts: number;
  /** machine-readable kind for color/grouping */
  kind: string;
  /** short uppercase label rendered in tooltips, e.g. "DEPLOY" */
  label: string;
  /** optional human-readable detail; e.g. "medius" or "by gabriel" */
  detail?: string;
  /** explicit color override */
  color?: string;
}

/**
 * Defaults match the ACTION_TONE map used in FleetActivityPanel so the
 * markers visually agree with the activity feed.
 */
export const EVENT_COLORS: Record<string, string> = {
  deploy: 'var(--color-accent)',
  restart: 'var(--color-warning)',
  recreate: 'var(--color-warning)',
  delete: 'var(--color-danger)',
  restore: 'var(--color-warning)',
  backup: 'var(--color-success)',
};

export function colorForEvent(e: ChartEvent): string {
  return e.color ?? EVENT_COLORS[e.kind] ?? 'var(--color-text-secondary)';
}

/**
 * Filter + sort events into the chart's time window. Returns events in
 * ascending timestamp order, which is what the renderer wants.
 */
export function eventsInRange(
  events: ChartEvent[] | undefined,
  fromMs: number,
  toMs: number,
): ChartEvent[] {
  if (!events || events.length === 0) return [];
  return events.filter((e) => e.ts >= fromMs && e.ts <= toMs).sort((a, b) => a.ts - b.ts);
}

/**
 * Find events that fall near a hover bucket (typically the bucket the
 * crosshair is sitting on). Used to merge them into the chart tooltip
 * so users see "Deployed medius" alongside the value reading.
 */
export function eventsNear(
  events: ChartEvent[] | undefined,
  bucketMs: number,
  windowMs: number,
): ChartEvent[] {
  if (!events || events.length === 0) return [];
  const half = windowMs / 2;
  return events.filter((e) => e.ts >= bucketMs - half && e.ts <= bucketMs + half);
}

/**
 * Compact relative timestamp ("3m", "2h", "1d") suitable for inline
 * rendering inside a chart tooltip.
 */
export function formatRelative(tsMs: number, nowMs = Date.now()): string {
  const ms = nowMs - tsMs;
  if (ms < 0) return 'now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
