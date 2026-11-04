// Words and numbers for a web app's Requests tab and one request opened.
export type RequestRange = '1h' | '24h' | '7d' | '30d';
export type RequestShow = 'all' | 'server' | 'client' | 'slow';
export const requestRanges: { value: RequestRange; label: string; words: string }[] = [
  { value: '1h', label: '1 hour', words: 'the last hour' },
  { value: '24h', label: '24 hours', words: '24 hours' },
  { value: '7d', label: '7 days', words: '7 days' },
  { value: '30d', label: '30 days', words: '30 days' },
];
export const requestShows: { value: RequestShow; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'server', label: 'Server errors' },
  { value: 'client', label: 'Client errors' },
  { value: 'slow', label: 'Slower than 1 s' },
];

export type RequestSummary = {
  range: RequestRange;
  from: number;
  to: number;
  total: number;
  perMinuteNow: number;
  serverErrors: number;
  serverErrorRate: number;
  usualServerErrorRate: number | null;
  p50: number;
  p95: number;
  p99: number;
  sentBytes: number;
  receivedBytes: number;
  series: {
    bucketMs: number;
    points: { at: number; perMinute: number; serverErrorsPerMinute: number }[];
  };
  peak: { perMinute: number; at: number } | null;
  releases: { id: string; label: string; at: number }[];
  firstServerError: { at: number; release?: string } | null;
  slowest: { method: string; path: string; count: number; p95: number; noAnswer: number }[];
  errorPaths: {
    method: string;
    path: string;
    count: number;
    status: number;
    reason: string | null;
  }[];
};
export type RequestRow = {
  id: number;
  at: number;
  method: string;
  path: string;
  query: string | null;
  status: number;
  duration: number;
};
export type RequestList = { rows: RequestRow[]; total: number; page: number; pageSize: number };
type Headers = Record<string, string | string[] | undefined>;
type SavedSide = {
  headers: Headers;
  body: string | null;
  bodyBytes: number;
  bodyTruncated: boolean;
};
export type RequestDetail = {
  request: RequestRow & {
    ip: string | null;
    username: string | null;
    referrer: string | null;
    browser: string | null;
    release: string | null;
    reason: string | null;
    failure: 'timeout' | 'refused' | 'error' | null;
  };
  capture: { request: SavedSide; response: SavedSide | null; keptUntil: number } | null;
  path: { count: number; serverErrors: number; noAnswer: number; p95: number; median: number };
};

export function rangeWords(range: RequestRange) {
  return requestRanges.find((entry) => entry.value === range)?.words ?? range;
}

export function formatCount(value: number) {
  return Math.round(value).toLocaleString('en-US');
}

/** 24 ms, 640 ms, 3.8 s, 15 s; `exact` keeps one decimal for the list (15.0 s). */
export function formatDuration(ms: number, exact = false) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return exact || seconds < 10 ? `${seconds.toFixed(1)} s` : `${Math.round(seconds)} s`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}

export function formatRate(rate: number) {
  const percent = rate * 100;
  if (percent === 0) return '0%';
  if (percent < 0.1) return 'under 0.1%';
  if (percent < 10) return `${percent.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(percent)}%`;
}

const clock = (at: number, seconds = false) =>
  new Date(at).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
const dayOf = (at: number, now: number) => {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return 'today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/** "1:58 PM", "yesterday at 1:58 PM", "Nov 2 at 1:58 PM". */
export function formatWhen(at: number, now = Date.now(), seconds = false) {
  const day = dayOf(at, now);
  return day === 'today' ? clock(at, seconds) : `${day} at ${clock(at, seconds)}`;
}

/** "at 7:12 PM" today, "yesterday at 7:12 PM" before. */
export function peakWhen(at: number, now = Date.now()) {
  const when = formatWhen(at, now);
  return dayOf(at, now) === 'today' ? `at ${when}` : when;
}

/** A row's time in the list: the clock today, the day before it otherwise. */
export function formatRowTime(at: number, now = Date.now()) {
  const day = dayOf(at, now);
  return day === 'today'
    ? clock(at, true)
    : `${day[0].toUpperCase()}${day.slice(1)}, ${clock(at, true)}`;
}

/** "2:31:07 PM", where the breadcrumb names one request. */
export function formatRequestClock(at: number) {
  return clock(at, true);
}

/** "Today at 2:31:07 PM" for one request's heading. */
export function formatRequestTime(at: number, now = Date.now()) {
  const day = dayOf(at, now);
  return `${day[0].toUpperCase()}${day.slice(1)} at ${clock(at, true)}`;
}

/** Five labels under the chart, oldest first, ending at Now. */
export function chartTicks(from: number, to: number, range: RequestRange, now = Date.now()) {
  return Array.from({ length: 5 }, (_, index) => {
    const at = from + ((to - from) * index) / 4;
    if (index === 4) return 'Now';
    if (range === '7d' || range === '30d')
      return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const hour = new Date(at).toLocaleTimeString('en-US', {
      hour: 'numeric',
      ...(range === '1h' ? { minute: '2-digit' } : {}),
    });
    const day = dayOf(at, now);
    return index === 0 && day !== 'today' ? `${hour} ${day}` : hour;
  });
}

/** What the chart says under its title. */
export function errorsLine(summary: RequestSummary, now = Date.now()) {
  const first = summary.firstServerError;
  if (!first) return `No server errors in ${rangeWords(summary.range)}.`;
  if (first.release)
    return `Server errors start at ${formatWhen(first.at, now)}, the ${first.release} release.`;
  return `First server error at ${formatWhen(first.at, now)}.`;
}

export function errorRateLine(summary: RequestSummary) {
  const rate = formatRate(summary.serverErrorRate);
  return summary.usualServerErrorRate === null
    ? rate
    : `${rate} · usually ${formatRate(summary.usualServerErrorRate)}`;
}

/** The headers and body of a saved request or response, as the page prints them. */
export function savedText(firstLine: string, side: SavedSide) {
  const headers = Object.entries(side.headers)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
  const body = side.body
    ? side.body + (side.bodyTruncated ? `\n… ${formatBytes(side.bodyBytes)} in all` : '')
    : 'No body';
  return [firstLine, ...headers, '', body].join('\n');
}

export function pathLine(path: RequestDetail['path']) {
  return [
    `${formatCount(path.count)} request${path.count === 1 ? '' : 's'}`,
    path.noAnswer
      ? `${formatCount(path.noAnswer)} got no answer`
      : path.serverErrors
        ? `${formatCount(path.serverErrors)} server error${path.serverErrors === 1 ? '' : 's'}`
        : null,
    `p95 ${formatDuration(path.p95)}, median ${formatDuration(path.median)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The list's address for a range, filter and page; defaults stay out of it. */
export function requestsHref(
  base: string,
  options: { range?: RequestRange; path?: string; show?: RequestShow; page?: number },
) {
  const params = new URLSearchParams();
  if (options.range && options.range !== '24h') params.set('range', options.range);
  if (options.path) params.set('path', options.path);
  if (options.show && options.show !== 'all') params.set('show', options.show);
  if (options.page && options.page > 1) params.set('page', String(options.page));
  const query = params.toString();
  return `${base}${query ? `?${query}` : ''}`;
}
