import type { readPerformance } from '../../../../../server/telemetry';

export type PerformanceRange = '1h' | '24h' | '7d';
export const performanceRanges = [
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
  { value: '7d', label: '7 days' },
];
type Response = ReturnType<typeof readPerformance>;
export type PhaseTimings = Record<string, { p50: number | null; p95: number | null }>;
type Summary = Omit<Response['summary'], 'previous'>;
export type ReleaseComparison = {
  before: Summary;
  after: Summary;
  enoughTraffic: boolean;
  verdict: 'steady' | 'slower' | 'more-errors' | null;
  slower: boolean;
  moreErrors: boolean;
  routes: (Omit<ReleaseComparison, 'routes'> & { route: string })[];
};
export type PerformanceData = Omit<Response, 'releases'> & {
  releases: { id: string; at: number; comparison: ReleaseComparison | null }[];
};
export type PerformanceRoute = PerformanceData['routes'][number];
export type PageExperience = PerformanceData['pageExperience'][number];
export type PerformanceError = PerformanceData['errors'][number];

/** The API count is lifetime, so it is a range count only if the entire group
 * was first and last seen inside that range. Otherwise leave the count out. */
export function errorOccurrences(error: PerformanceError, from: number, to: number) {
  return error.firstSeen >= from && error.lastSeen < to ? error.count : null;
}

export function seenAgo(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes === 0) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function performanceRange(value: string | null): PerformanceRange {
  return value === '1h' || value === '7d' ? value : '24h';
}
export function periodWords(range: PerformanceRange) {
  return range === '1h' ? 'hour' : range === '24h' ? '24 hours' : '7 days';
}
export function rangeDescription(range: PerformanceRange) {
  const words = periodWords(range);
  return `Last ${words} · compared with the ${words} before`;
}
export function performanceHref(base: string, range: PerformanceRange, error?: string) {
  const params = new URLSearchParams();
  if (range !== '24h') params.set('range', range);
  if (error) params.set('error', error);
  return `${base}${params.size ? `?${params}` : ''}`;
}

/** Retain sub-ms phases and small, nonzero error rates instead of rounding them to zero. */
export function timing(ms: number | null | undefined, requests?: number) {
  if (ms == null && requests === 0) return '— · No requests to time';
  if (ms == null || !Number.isFinite(ms) || ms < 0) return 'Not measured · Timing was not recorded';
  if (ms === 0) return '0 ms';
  if (ms < 0.1) return 'under 0.1 ms';
  if (ms < 10) return `${Number(ms.toFixed(1))} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${Number((ms / 1000).toFixed(3))} s`;
}
export function percent(rate: number | null | undefined) {
  if (rate == null || !Number.isFinite(rate) || rate < 0)
    return 'Not measured · Rate was not recorded';
  if (rate > 0 && rate < 0.0001) return 'under 0.01%';
  return `${Number((rate * 100).toFixed(2))}%`;
}
export const serverPhases = [
  { key: 'match', phase: 'match', label: 'Route match' },
  { key: 'rsc', phase: 'data', label: 'Data loading' },
  { key: 'ssr', phase: 'render', label: 'Page render' },
  { key: 'stream', phase: 'stream', label: 'Streaming' },
] as const;
export type TimingSegment = {
  phase: string;
  label: string;
  start: number;
  p50: number;
  p95: number;
};
/** Unknown phases cannot establish the sequential offsets. Header `render` is
 * combined rendering, so it cannot stand in for the separate RSC/SSR phases. */
export function serverSegments(phases: PhaseTimings | undefined): TimingSegment[] {
  if (
    !phases ||
    !serverPhases.every(({ key }) => {
      const value = phases[key];
      return (
        value &&
        value.p50 !== null &&
        value.p95 !== null &&
        Number.isFinite(value.p50) &&
        Number.isFinite(value.p95) &&
        value.p50 >= 0 &&
        value.p95 >= value.p50
      );
    })
  )
    return [];
  let start = 0;
  return serverPhases.map(({ key, phase, label }) => {
    const { p50, p95 } = phases[key] as { p50: number; p95: number };
    const segment = { phase, label, start, p50, p95 };
    start += p50;
    return segment;
  });
}
/** A shared, rounded-up scale includes every total marker and phase extension.
 * Per-phase p95 values start at the preceding p50 end; they are never summed. */
export function waterfallScale(routes: { p95: number | null; phases?: PhaseTimings }[]) {
  const max = Math.max(
    1,
    ...routes.flatMap((route) => [
      route.p95 ?? 0,
      ...serverSegments(route.phases).map((part) => part.start + part.p95),
    ]),
  );
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= max)!;
  return step * magnitude;
}
export function barPosition(start: number, duration: number, scale: number) {
  const left = Math.max(0, Math.min(100, (start / scale) * 100));
  const width = Math.max(0, Math.min(100 - left, (duration / scale) * 100));
  return { left: `${left}%`, width: `${width}%` };
}
export function rating(metric: 'lcp' | 'inp' | 'cls' | 'ttfb', value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  // Approved boundaries in design/canvas.json, app-performance-thresholds.
  const [good, needsWork] = {
    lcp: [2500, 4000],
    inp: [200, 500],
    cls: [0.1, 0.25],
    ttfb: [800, 1800],
  }[metric];
  return value <= good ? 'Good' : value <= needsWork ? 'Needs work' : 'Poor';
}
export function prefetchRate(page: PageExperience) {
  const { hit, inflight, miss } = page.prefetch;
  const total = hit + inflight + miss;
  return total ? hit / total : null;
}
export function quietExperience(data: PerformanceData) {
  return (
    data.summary.requests > 0 &&
    data.summary.errors5xx === 0 &&
    data.errors.length === 0 &&
    data.pageExperience.length > 0 &&
    data.pageExperience.every((page) =>
      (['lcp', 'inp', 'cls'] as const).every((metric) => rating(metric, page[metric]) === 'Good'),
    )
  );
}
export function performanceState(data: PerformanceData) {
  if (
    !data.summary.requests &&
    !data.routes.length &&
    !data.pageExperience.length &&
    !data.errors.length
  )
    return 'empty';
  if (!data.hasRouteData && !data.pageExperience.length && !data.errors.length) return 'totals';
  return 'ready';
}
export function releaseVerdict(comparison: ReleaseComparison | null) {
  if (!comparison?.enoughTraffic || !comparison.verdict) return null;
  return { steady: 'Steady', slower: 'Slower', 'more-errors': 'More errors' }[comparison.verdict];
}
export function releaseEvidence(comparison: ReleaseComparison | null) {
  if (!comparison) return '';
  const { before, after, verdict } = comparison;
  const latency = `p95 ${timing(before.p95, before.requests)} → ${timing(after.p95, after.requests)}`;
  const errors = `errors ${percent(before.errorRate)} → ${percent(after.errorRate)}`;
  if (verdict === 'more-errors') {
    const difference = Number(((after.errorRate - before.errorRate) * 100).toFixed(2));
    return `${errors} · up ${difference} percentage points`;
  }
  if (verdict === 'slower' && before.p95 !== null && after.p95 !== null) {
    const difference = after.p95 - before.p95;
    return `${latency} · ${timing(difference)} slower${before.p95 > 0 ? ` (${percent(difference / before.p95)})` : ''}`;
  }
  return `${latency} · ${errors}`;
}
export function errorLocation(where: string) {
  return (
    {
      server: 'server render',
      page: 'server render',
      ssr: 'server render',
      rsc: 'server render',
      action: 'action',
      browser: 'browser',
    }[where] ?? where
  );
}
