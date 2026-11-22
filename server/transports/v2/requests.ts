import { receiveOtlp } from '../../otlp.ts';
import { readOtlp } from '../../features/observability/trace-spans.ts';
import {
  readInteraction,
  storeInteraction,
} from '../../features/observability/interaction-traces.ts';
import { readTelemetryBody, TelemetryRateLimit } from '../../kernel/telemetry-http.ts';
/**
 * A web app's requests: the Requests tab and one request opened.
 *
 * Counts and the chart read the 1-minute rollups (request_logs_1m); percentiles, paths and the
 * list read request_logs (kept 84 days). Server errors carry a capture with what was sent and
 * what came back (kept 14 days), read back with secrets hidden.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeployment } from '../../store.ts';
import { getRequestsSqlite } from '../../requests-db.ts';
import { readCapture, type CaptureRecord } from '../../capture.ts';
import { list } from '../../workspace/store.ts';
import { fail } from '../../kernel/errors.ts';
import type { Release } from '../../../shared/v2/contracts.ts';
import { dispatch, routes } from '../../kernel/routes.ts';
import { repeatingSenders } from './traffic.ts';
import {
  REQUEST_RANGES,
  describeBrowser,
  normalizePath,
  type RequestRange,
} from './request-shape.ts';

export { REQUEST_RANGES, describeBrowser, normalizePath, type RequestRange };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export type RequestShow = 'all' | 'server' | 'client' | 'slow';
const PAGE_SIZE = 50;
// Legacy edge logs used 502 for a timeout even though the HTTP response was 503.
const NO_ANSWER_MS = 15_000;
const SLOW_MS = 1000;
const PATH_ROWS = 200_000;

function likelyNoAnswer(row: { status: number; duration: number }) {
  return (row.status === 502 || row.status === 503) && row.duration >= NO_ANSWER_MS;
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
  if (capture?.failureReason === 'cutover') return 'the app was switching releases';
  if (capture?.failureReason === 'refused') return 'the app refused the connection';
  if (capture?.failureReason === 'error') return 'the connection to the app failed';
  if (capture?.failureReason === 'timeout' || (!capture && likelyNoAnswer(row)))
    return `no answer in ${Math.floor(row.duration / 1000)} s`;
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

/** Requests in each of the last 24 hours for each app, oldest first; one read for every app. */
export function hourlyRequests(apps: string[], now = Date.now()) {
  const from = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  const hours = new Map(apps.map((app) => [app, new Array<number>(24).fill(0)]));
  if (!apps.length) return { from, hours };
  const rows = getRequestsSqlite()
    .prepare(
      `SELECT deployment_name AS app, CAST((bucket_ms - ?) / ${HOUR} AS INTEGER) AS hour, sum(count) AS count
       FROM request_logs_1m
       WHERE bucket_ms >= ? AND bucket_ms <= ? AND deployment_name IN (${apps.map(() => '?').join(',')})
       GROUP BY deployment_name, hour`,
    )
    .all(from, from, now, ...apps) as { app: string; hour: number; count: number }[];
  for (const row of rows) {
    const series = hours.get(row.app);
    if (series && row.hour >= 0 && row.hour < 24) series[row.hour] += row.count;
  }
  return { from, hours };
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
    if (likelyNoAnswer(row)) group.noAnswer++;
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
    // One address asking one route at a steady pace: a script left running, not visitors.
    repeating: repeatingSenders(name, now),
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

export async function requestDetail(
  owner: string,
  name: string,
  id: number | string,
  now = Date.now(),
) {
  ownedWebApp(owner, name);
  const db = getRequestsSqlite();
  const row = db
    .prepare(
      `SELECT id, timestamp AS at, method, path, query_params AS query, status, duration, ip,
         user_agent AS userAgent, referrer, username, request_size AS requestSize,
         response_size AS responseSize, capture_id AS captureId, request_id AS requestId, trace
       FROM request_logs WHERE deployment_name = ? AND ${typeof id === 'string' ? 'request_id' : 'id'} = ?`,
    )
    .get(name, id) as
    | (RequestRow & {
        trace: string | null;
        requestId: string | null;
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
         coalesce(sum(CASE WHEN status IN (502, 503) AND duration >= ? THEN 1 ELSE 0 END), 0) AS noAnswer
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
  const { captureId: _captureId, trace, userAgent, ...request } = row!;
  const edgeTrace = trace ? JSON.parse(trace) : null;
  const client =
    edgeTrace &&
    (db
      .prepare(
        'SELECT spans FROM telemetry_client_spans WHERE deployment_name=? AND request_id=? AND trace_id=?',
      )
      .get(name, request.requestId, edgeTrace.traceId) as { spans: string } | undefined);
  return {
    request: {
      ...request,
      trace: edgeTrace,
      clientSpans: client ? JSON.parse(client.spans) : null,
      navigation: request.requestId
        ? (db
            .prepare(
              'SELECT route,start_fetch_ms AS fetchStartMs,headers_ms AS headersMs,commit_ms AS commitMs FROM telemetry_navigation WHERE deployment_name=? AND request_id=?',
            )
            .get(name, request.requestId) ?? null)
        : null,
      browser: describeBrowser(userAgent),
      release: release?.label ?? null,
      reason: row!.status >= 500 ? errorReason(row!, capture) : null,
      failure: capture?.failureReason ?? (!capture && likelyNoAnswer(row!) ? 'timeout' : null),
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

const route = routes<string>();

async function requestsRoute(
  res: ServerResponse,
  url: URL,
  owner: string,
  app: string,
  which: string | undefined,
) {
  const name = decodeURIComponent(app);
  const range = rangeOf(url.searchParams.get('range'));
  const value =
    which === 'summary'
      ? await requestSummary(owner, name, range)
      : which
        ? await requestDetail(owner, name, /^[0-9a-f]{32}$/.test(which) ? which : Number(which))
        : requestList(owner, name, {
            range,
            path: url.searchParams.get('path') ?? undefined,
            show: (url.searchParams.get('show') ?? 'all') as RequestShow,
            page: Number(url.searchParams.get('page') ?? 1),
          });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

const methodNotAllowed = () => fail('Method not allowed', 405);

// A root request's trace ID is its request ID. Only incoming child requests need the
// secondary index. Limit the response even for a caller that keeps reusing an ID.
function traceRequests(owner: string, name: string, id: string) {
  ownedWebApp(owner, name);
  const rows = getRequestsSqlite()
    .prepare(`
    SELECT request_id AS requestId, route, method, status, timestamp, trace FROM request_logs
     WHERE deployment_name=? AND request_id=? AND json_extract(trace,'$.parentSpanId') IS NULL
    UNION ALL
    SELECT request_id AS requestId, route, method, status, timestamp, trace FROM request_logs
     WHERE deployment_name=? AND json_extract(trace,'$.parentSpanId') IS NOT NULL AND json_extract(trace,'$.traceId')=?
    ORDER BY timestamp LIMIT 101`)
    .all(name, id, name, id) as { trace: string }[];
  const interaction = readInteraction(getRequestsSqlite(), name, id);
  const otlp = readOtlp(getRequestsSqlite(), name, id);
  if (!rows.length && !interaction && !otlp.spans.length) fail('Trace not found', 404);
  return {
    traceId: id,
    interaction,
    spans: otlp.spans,
    truncated: rows.length > 100 || otlp.truncated,
    requests: rows.slice(0, 100).map((row) => ({ ...row, trace: JSON.parse(row.trace) })),
  };
}

const interactionRate = new TelemetryRateLimit(120);
export const requestsRoutes = [
  route({
    method: 'POST',
    path: '/api/control/otel/v1/traces',
    handler: async ({ req, res, context }) => {
      if (!interactionRate.allow(context)) fail('Too many exports', 429);
      await receiveOtlp(req, res, getRequestsSqlite(), 'control:' + context);
    },
  }),
  route({
    method: 'GET',
    path: '/api/control/traces',
    handler: ({ res, context }) => {
      const rows = getRequestsSqlite()
        .prepare(`SELECT trace_id AS traceId,max(received) AS received FROM
     (SELECT trace_id,received FROM otlp_spans WHERE project=? ORDER BY received DESC LIMIT 1024)
     GROUP BY trace_id ORDER BY received DESC LIMIT 100`)
        .all('control:' + context);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ traces: rows }));
    },
  }),
  route({
    method: 'GET',
    path: '/api/control/traces/:id([0-9a-f]{32})',
    handler: ({ res, context, params }) => {
      const result = readOtlp(getRequestsSqlite(), 'control:' + context, params.id);
      if (!result.spans.length) fail('Trace not found', 404);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ traceId: params.id, ...result }));
    },
  }),
  route({
    method: 'POST',
    path: '/api/control/interactions',
    handler: async ({ req, res, context }) => {
      if (!interactionRate.allow(context)) fail('Too many interactions', 429);
      storeInteraction(
        getRequestsSqlite(),
        'control:' + context,
        await readTelemetryBody(req, 16384),
      );
      res.writeHead(204);
      res.end();
    },
  }),
  route({
    method: 'GET',
    path: '/api/control/interactions/:id([0-9a-f]{32})',
    handler: ({ res, params, context }) => {
      const interaction = readInteraction(getRequestsSqlite(), 'control:' + context, params.id);
      if (!interaction) fail('Trace not found', 404);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(interaction));
    },
  }),
  route({
    method: 'GET',
    path: '/api/apps/:app/traces/:traceId([0-9a-f]{32})',
    handler: ({ res, params, context }) => {
      const result = traceRequests(context, decodeURIComponent(params.app), params.traceId);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(result));
    },
  }),
  route({
    method: 'GET',
    path: '/api/apps/:app/requests',
    handler: ({ res, url, params, context }) =>
      requestsRoute(res, url, context, params.app, undefined),
  }),
  route({
    method: 'GET',
    path: '/api/apps/:app/requests/:which(summary|[0-9a-f]{32}|\\d+)',
    handler: ({ res, url, params, context }) =>
      requestsRoute(res, url, context, params.app, params.which),
  }),
  route({ method: '*', path: '/api/apps/:app/requests', handler: methodNotAllowed }),
  route({
    method: '*',
    path: '/api/apps/:app/requests/:which(summary|[0-9a-f]{32}|\\d+)',
    handler: methodNotAllowed,
  }),
];

const requestsDispatch = dispatch(requestsRoutes);

export async function requestsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  return requestsDispatch(req, res, owner);
}
