/**
 * A web app's requests: the Requests tab and one request opened.
 *
 * Counts and the chart read the 1-minute rollups (request_logs_1m); percentiles, paths and the
 * list read request_logs (kept 84 days). Server errors carry a capture with what was sent and
 * what came back (kept 14 days), read back with secrets hidden.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeployment } from '../store.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { readCapture, type CaptureRecord } from '../capture.ts';
import { list } from '../workspace/store.ts';
import { fail } from '../errors.ts';
import type { Release } from '../../shared/v2/contracts.ts';

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
export type RequestShow = 'all' | 'server' | 'client' | 'slow';
const PAGE_SIZE = 50;
// The edge answers 502 once an app stays silent this long (PROXY_RESPONSE_TIMEOUT_MS).
const NO_ANSWER_MS = 15_000;
const SLOW_MS = 1000;
const PATH_ROWS = 200_000;

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

/** What the list filters on for a grouped path: everything before its first :id. */
export function pathFilter(path: string) {
  const at = path.indexOf(':id');
  return at === -1 ? path : path.slice(0, at);
}

export type RequestRow = {
  id: number;
  at: number;
  method: string;
  path: string;
  query: string | null;
  status: number;
  duration: number;
};

function rangeOf(value: string | null): RequestRange {
  const range = (value || '24h') as RequestRange;
  if (!(range in REQUEST_RANGES)) fail('range must be 1h, 24h, 7d or 30d');
  return range;
}

function ownedWebApp(owner: string, name: string) {
  const app = getDeployment(name);
  if (!app || app.username !== owner) fail('App not found', 404);
  return app;
}

/** The app's releases with when each went live, oldest first. */
function releasesOf(owner: string, name: string) {
  return (list('v2-release', owner) as { release: Release }[])
    .map((row) => row.release)
    .filter((release) => release.apps.some((app) => app.appId === name))
    .map((release) => {
      const activate = release.steps.find((step) => step.name === 'activate');
      const at = Date.parse(activate?.endedAt || activate?.startedAt || '');
      // A release without a commit has only an internal ID, which means nothing on this page.
      return { id: release.id, label: release.source.commit?.slice(0, 7) ?? null, at };
    })
    .filter((release) => Number.isFinite(release.at))
    .sort((left, right) => left.at - right.at);
}

/** Why a server error happened, in a few words, from its capture when one was saved. */
export function errorReason(
  row: { status: number; duration: number },
  capture: CaptureRecord | null,
): string | null {
  if (capture?.failureReason === 'timeout' || (row.status === 502 && row.duration >= NO_ANSWER_MS))
    return `no answer in ${Math.floor(row.duration / 1000)} s`;
  if (capture?.failureReason === 'refused') return 'the app refused the connection';
  if (capture?.failureReason === 'error') return 'the connection to the app failed';
  const body = capture?.response?.body?.trim();
  if (!body) return null;
  let text: unknown = null;
  try {
    const json = JSON.parse(body);
    text =
      typeof json?.error === 'string'
        ? json.error
        : typeof json?.error?.message === 'string'
          ? json.error.message
          : json?.message;
  } catch {
    if (!body.startsWith('<')) text = body.split('\n').find((line) => line.trim());
  }
  if (typeof text !== 'string' || !text.trim()) return null;
  const line = text.trim().split('\n')[0];
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
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

function percentile(name: string, from: number, to: number, total: number, p: number) {
  if (!total) return 0;
  const row = getRequestsSqlite()
    .prepare(
      `SELECT duration FROM request_logs WHERE deployment_name = ? AND timestamp >= ? AND timestamp <= ?
       ORDER BY duration LIMIT 1 OFFSET ?`,
    )
    .get(name, from, to, Math.min(Math.floor(total * p), total - 1)) as
    | { duration: number }
    | undefined;
  return row?.duration ?? 0;
}

export async function requestSummary(
  owner: string,
  name: string,
  range: RequestRange,
  now = Date.now(),
) {
  ownedWebApp(owner, name);
  const db = getRequestsSqlite();
  const { ms, bucketMs } = REQUEST_RANGES[range];
  const to = now;
  const from = now - ms;
  const minutes = db
    .prepare(
      `SELECT bucket_ms AS at, count, errors_5xx AS errors FROM request_logs_1m
       WHERE deployment_name = ? AND bucket_ms >= ? AND bucket_ms <= ? ORDER BY bucket_ms`,
    )
    .all(name, Math.floor(from / MINUTE) * MINUTE, to) as {
    at: number;
    count: number;
    errors: number;
  }[];
  const total = minutes.reduce((sum, minute) => sum + minute.count, 0);
  const serverErrors = minutes.reduce((sum, minute) => sum + minute.errors, 0);
  const recent = minutes.filter((minute) => minute.at >= now - 5 * MINUTE);
  const before = db
    .prepare(
      `SELECT coalesce(sum(count), 0) AS count, coalesce(sum(errors_5xx), 0) AS errors FROM request_logs_1m
       WHERE deployment_name = ? AND bucket_ms >= ? AND bucket_ms < ?`,
    )
    .get(name, from - 7 * DAY, from) as { count: number; errors: number };
  const bytes = db
    .prepare(
      `SELECT coalesce(sum(response_size), 0) AS sent, coalesce(sum(request_size), 0) AS received
       FROM request_logs WHERE deployment_name = ? AND timestamp >= ? AND timestamp <= ?`,
    )
    .get(name, from, to) as { sent: number; received: number };

  const buckets = new Map<number, { count: number; errors: number }>();
  for (const minute of minutes) {
    const key = Math.floor(minute.at / bucketMs) * bucketMs;
    const bucket = buckets.get(key) ?? { count: 0, errors: 0 };
    bucket.count += minute.count;
    bucket.errors += minute.errors;
    buckets.set(key, bucket);
  }
  const points: { at: number; perMinute: number; serverErrorsPerMinute: number }[] = [];
  for (let at = Math.floor(from / bucketMs) * bucketMs; at <= to; at += bucketMs) {
    const bucket = buckets.get(at);
    points.push({
      at,
      perMinute: (bucket?.count ?? 0) / (bucketMs / MINUTE),
      serverErrorsPerMinute: (bucket?.errors ?? 0) / (bucketMs / MINUTE),
    });
  }
  const peak = minutes.reduce<(typeof minutes)[number] | null>(
    (best, minute) => (!best || minute.count > best.count ? minute : best),
    null,
  );

  const releases = releasesOf(owner, name);
  const inRange = releases.filter((release) => release.at >= from && release.at <= to);
  const first = minutes.find((minute) => minute.errors > 0);
  // Errors "start" with a release when it went live shortly before the first one and the hour
  // before it was clean; otherwise the page only says when the first one came.
  const cause =
    first &&
    [...releases]
      .reverse()
      .find((release) => release.at <= first.at + MINUTE && first.at - release.at <= 10 * MINUTE);
  const cleanBefore =
    cause &&
    (
      db
        .prepare(
          `SELECT coalesce(sum(errors_5xx), 0) AS errors FROM request_logs_1m
           WHERE deployment_name = ? AND bucket_ms >= ? AND bucket_ms < ?`,
        )
        .get(name, cause.at - HOUR, cause.at) as { errors: number }
    ).errors === 0;

  // Paths group with their IDs folded to :id, so /assets/<uuid> is one path, not hundreds.
  // The busiest apps are bounded to their latest rows so the tab stays fast.
  const rows = db
    .prepare(
      `SELECT method, path, duration, status, capture_id AS captureId FROM request_logs
       WHERE deployment_name = ? AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp DESC LIMIT ?`,
    )
    .all(name, from, to, PATH_ROWS) as {
    method: string;
    path: string;
    duration: number;
    status: number;
    captureId: string | null;
  }[];
  const groups = new Map<
    string,
    {
      method: string;
      path: string;
      durations: number[];
      noAnswer: number;
      errors: Map<number, { count: number; latest: (typeof rows)[number] }>;
    }
  >();
  for (const row of rows) {
    const path = normalizePath(row.path);
    const key = `${row.method} ${path}`;
    let group = groups.get(key);
    if (!group) {
      group = { method: row.method, path, durations: [], noAnswer: 0, errors: new Map() };
      groups.set(key, group);
    }
    group.durations.push(row.duration);
    if (row.status === 502 && row.duration >= NO_ANSWER_MS) group.noAnswer++;
    if (row.status >= 500) {
      const error = group.errors.get(row.status);
      // Rows arrive newest first: keep the newest one that saved what was sent.
      if (!error) group.errors.set(row.status, { count: 1, latest: row });
      else {
        error.count++;
        if (!error.latest.captureId && row.captureId) error.latest = row;
      }
    }
  }
  const slowest = [...groups.values()]
    .map((group) => {
      const sorted = group.durations.sort((left, right) => left - right);
      return {
        method: group.method,
        path: group.path,
        filter: pathFilter(group.path),
        count: sorted.length,
        p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
        noAnswer: group.noAnswer,
      };
    })
    .sort((left, right) => right.p95 - left.p95 || right.count - left.count)
    .slice(0, 3);
  const errorPaths = [...groups.values()]
    .map((group) => {
      const statuses = [...group.errors.entries()].sort(
        (left, right) => right[1].count - left[1].count,
      );
      return {
        group,
        count: statuses.reduce((sum, [, error]) => sum + error.count, 0),
        status: statuses[0]?.[0] ?? 0,
        latest: statuses[0]?.[1].latest,
      };
    })
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 3);

  return {
    range,
    from,
    to,
    total,
    perMinuteNow: recent.length ? Math.round(recent.reduce((s, m) => s + m.count, 0) / 5) : 0,
    serverErrors,
    serverErrorRate: total ? serverErrors / total : 0,
    usualServerErrorRate: before.count ? before.errors / before.count : null,
    p50: percentile(name, from, to, total, 0.5),
    p95: percentile(name, from, to, total, 0.95),
    p99: percentile(name, from, to, total, 0.99),
    sentBytes: bytes.sent,
    receivedBytes: bytes.received,
    series: { bucketMs, points },
    peak: peak && peak.count ? { perMinute: peak.count, at: peak.at } : null,
    releases: inRange,
    firstServerError: first
      ? { at: first.at, ...(cause?.label && cleanBefore ? { release: cause.label } : {}) }
      : null,
    slowest,
    errorPaths: await Promise.all(
      errorPaths.map(async ({ group, count, status, latest }) => {
        const capture = latest?.captureId ? await readCapture(name, latest.captureId) : null;
        return {
          method: group.method,
          path: group.path,
          filter: pathFilter(group.path),
          count,
          status,
          reason: latest ? errorReason(latest, capture) : null,
        };
      }),
    ),
  };
}

export function requestList(
  owner: string,
  name: string,
  options: { range: RequestRange; path?: string; show?: RequestShow; page?: number },
  now = Date.now(),
) {
  ownedWebApp(owner, name);
  const show = options.show ?? 'all';
  if (!['all', 'server', 'client', 'slow'].includes(show))
    fail('show must be all, server, client or slow');
  const page = Math.max(1, Math.floor(options.page || 1));
  const where = ['deployment_name = ?', 'timestamp >= ?', 'timestamp <= ?'];
  const params: (string | number)[] = [name, now - REQUEST_RANGES[options.range].ms, now];
  if (options.path?.trim()) {
    where.push('instr(path, ?) > 0');
    params.push(options.path.trim());
  }
  if (show === 'server') where.push('status >= 500');
  if (show === 'client') where.push('status >= 400 AND status < 500');
  if (show === 'slow') where.push(`duration >= ${SLOW_MS}`);
  const db = getRequestsSqlite();
  const { total } = db
    .prepare(`SELECT count(*) AS total FROM request_logs WHERE ${where.join(' AND ')}`)
    .get(...params) as { total: number };
  const rows = db
    .prepare(
      `SELECT id, timestamp AS at, method, path, query_params AS query, status, duration
       FROM request_logs WHERE ${where.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE) as RequestRow[];
  return { rows, total, page, pageSize: PAGE_SIZE };
}

export async function requestDetail(owner: string, name: string, id: number, now = Date.now()) {
  ownedWebApp(owner, name);
  const db = getRequestsSqlite();
  const row = db
    .prepare(
      `SELECT id, timestamp AS at, method, path, query_params AS query, status, duration, ip,
         user_agent AS userAgent, referrer, username, request_size AS requestSize,
         response_size AS responseSize, capture_id AS captureId
       FROM request_logs WHERE deployment_name = ? AND id = ?`,
    )
    .get(name, id) as
    | (RequestRow & {
        ip: string | null;
        userAgent: string | null;
        referrer: string | null;
        username: string | null;
        requestSize: number | null;
        responseSize: number | null;
        captureId: string | null;
      })
    | undefined;
  if (!row) fail('Request not found', 404);
  const capture = row!.captureId ? await readCapture(name, row!.captureId) : null;
  const release = [...releasesOf(owner, name)].reverse().find((entry) => entry.at <= row!.at);
  const from = now - DAY;
  const stats = db
    .prepare(
      `SELECT count(*) AS count,
         coalesce(sum(CASE WHEN status >= 500 THEN 1 ELSE 0 END), 0) AS serverErrors,
         coalesce(sum(CASE WHEN status = 502 AND duration >= ? THEN 1 ELSE 0 END), 0) AS noAnswer
       FROM request_logs WHERE deployment_name = ? AND timestamp >= ? AND method = ? AND path = ?`,
    )
    .get(NO_ANSWER_MS, name, from, row!.method, row!.path) as {
    count: number;
    serverErrors: number;
    noAnswer: number;
  };
  const pathPercentile = (p: number) =>
    stats.count
      ? ((
          db
            .prepare(
              `SELECT duration FROM request_logs
               WHERE deployment_name = ? AND timestamp >= ? AND method = ? AND path = ?
               ORDER BY duration LIMIT 1 OFFSET ?`,
            )
            .get(
              name,
              from,
              row!.method,
              row!.path,
              Math.min(Math.floor(stats.count * p), stats.count - 1),
            ) as { duration: number }
        ).duration ?? 0)
      : 0;
  const { captureId: _captureId, userAgent, ...request } = row!;
  return {
    request: {
      ...request,
      browser: describeBrowser(userAgent),
      release: release?.label ?? null,
      reason: row!.status >= 500 ? errorReason(row!, capture) : null,
      failure:
        capture?.failureReason ??
        (row!.status === 502 && row!.duration >= NO_ANSWER_MS ? 'timeout' : null),
    },
    capture: capture
      ? {
          request: capture.request,
          response: capture.response,
          keptUntil: capture.timestamp + 14 * DAY,
        }
      : null,
    path: { ...stats, p95: pathPercentile(0.95), median: pathPercentile(0.5) },
  };
}

export async function requestsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  const route = url.pathname.match(/^\/api\/v2\/apps\/([^/]+)\/requests(?:\/(summary|\d+))?$/);
  if (!route) return false;
  if (req.method !== 'GET') fail('Method not allowed', 405);
  const name = decodeURIComponent(route[1]);
  const range = rangeOf(url.searchParams.get('range'));
  const value =
    route[2] === 'summary'
      ? await requestSummary(owner, name, range)
      : route[2]
        ? await requestDetail(owner, name, Number(route[2]))
        : requestList(owner, name, {
            range,
            path: url.searchParams.get('path') ?? undefined,
            show: (url.searchParams.get('show') ?? 'all') as RequestShow,
            page: Number(url.searchParams.get('page') ?? 1),
          });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
  return true;
}
