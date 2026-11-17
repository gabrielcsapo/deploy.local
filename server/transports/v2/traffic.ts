/**
 * Traffic: every request through deploy.local to the owner's apps, by app and by sender, and the
 * senders that keep asking one route at a steady pace (a script left running, not a person).
 *
 * Totals and the chart read the 1-minute rollups, which are cheap for any range. Who sent what
 * reads request_logs, so it never looks further back than 24 hours, and its answer is kept for
 * a minute: these reads run on the control process and must stay short.
 */
import { getDeployments, getNodes } from '../../store.ts';
import { getRequestsSqlite } from '../../requests-db.ts';
import {
  REQUEST_RANGES,
  describeBrowser,
  normalizePath,
  type RequestRange,
} from './request-shape.ts';
import type { RepeatingSender, TrafficResponse } from '../../../shared/v2/contracts.ts';

export type { RepeatingSender, TrafficResponse };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A repeating sender: most of one route, many requests, for over an hour, and still going. */
const REPEATING_SHARE = 0.8;
const REPEATING_REQUESTS = 1000;
const REPEATING_SPAN = HOUR;
const REPEATING_QUIET = HOUR;
/** Steady: it asks in nearly every minute, and about as often in each. */
const STEADY_PRESENCE = 0.9;
const STEADY_VARIATION = 0.35;
/** How far back “since” is looked for when a sender was already going a day ago. */
const SINCE_LOOKBACK = 7 * DAY;
const ANSWER_FOR = MINUTE;

type Group = {
  app: string;
  ip: string;
  method: string;
  path: string;
  count: number;
  first: number;
  last: number;
  agent: string | null;
  sent: number | null;
  received: number | null;
};

const cleanAddress = (ip: string | null) => (ip || 'unknown').replace(/^::ffff:/, '');

function computerNames() {
  const nodes = getNodes() as { id: string; name: string; address?: string | null }[];
  const coordinator = nodes.find((node) => node.id === 'coordinator')?.name;
  const names = new Map<string, string>();
  if (coordinator) for (const loopback of ['127.0.0.1', '::1']) names.set(loopback, coordinator);
  for (const node of nodes) {
    const address = cleanAddress(node.address ?? null);
    if (address !== 'unknown' && !names.has(address)) names.set(address, node.name);
  }
  return names;
}

/** Whether per-minute counts look like a loop: there in nearly every minute, level throughout. */
export function steady(perMinute: number[], spanMinutes: number) {
  if (!perMinute.length || spanMinutes <= 0) return false;
  if (perMinute.length / spanMinutes < STEADY_PRESENCE) return false;
  const mean = perMinute.reduce((sum, count) => sum + count, 0) / perMinute.length;
  const variance =
    perMinute.reduce((sum, count) => sum + (count - mean) ** 2, 0) / perMinute.length;
  return Math.sqrt(variance) / mean <= STEADY_VARIATION;
}

function sendersOf(apps: string[], from: number, to: number) {
  if (!apps.length) return [] as Group[];
  return getRequestsSqlite()
    .prepare(
      `SELECT deployment_name AS app, ip, method, path, count(*) AS count, min(timestamp) AS first,
              max(timestamp) AS last, max(user_agent) AS agent, sum(response_size) AS sent,
              sum(request_size) AS received
       FROM request_logs
       WHERE timestamp >= ? AND timestamp <= ? AND deployment_name IN (${apps.map(() => '?').join(',')})
       GROUP BY deployment_name, ip, method, path`,
    )
    .all(from, to, ...apps) as Group[];
}

type Analysis = {
  bytes: Map<string, { sent: number; received: number }>;
  /** Requests per address for each app, busiest first. */
  senders: Map<string, { address: string; count: number }[]>;
  total: Map<string, number>;
  routes: {
    app: string;
    address: string;
    route: string;
    method: string;
    paths: string[];
    count: number;
    routeTotal: number;
    first: number;
    last: number;
    agent: string | null;
    sent: number;
  }[];
};

function analyse(apps: string[], from: number, to: number): Analysis {
  const bytes = new Map<string, { sent: number; received: number }>();
  const total = new Map<string, number>();
  const perSender = new Map<string, Map<string, number>>();
  const perRoute = new Map<string, number>();
  const routes = new Map<string, Analysis['routes'][number] & { pathSet: Set<string> }>();
  for (const group of sendersOf(apps, from, to)) {
    const address = cleanAddress(group.ip);
    const route = `${group.method} ${normalizePath(group.path)}`;
    const size = bytes.get(group.app) ?? { sent: 0, received: 0 };
    size.sent += group.sent ?? 0;
    size.received += group.received ?? 0;
    bytes.set(group.app, size);
    total.set(group.app, (total.get(group.app) ?? 0) + group.count);
    const senders = perSender.get(group.app) ?? new Map<string, number>();
    senders.set(address, (senders.get(address) ?? 0) + group.count);
    perSender.set(group.app, senders);
    const routeKey = `${group.app}\0${route}`;
    perRoute.set(routeKey, (perRoute.get(routeKey) ?? 0) + group.count);
    const key = `${routeKey}\0${address}`;
    const entry = routes.get(key) ?? {
      app: group.app,
      address,
      route,
      method: group.method,
      paths: [],
      pathSet: new Set<string>(),
      count: 0,
      routeTotal: 0,
      first: group.first,
      last: group.last,
      agent: null,
      sent: 0,
    };
    entry.count += group.count;
    entry.first = Math.min(entry.first, group.first);
    entry.last = Math.max(entry.last, group.last);
    entry.agent ??= group.agent;
    entry.sent += group.sent ?? 0;
    entry.pathSet.add(group.path);
    routes.set(key, entry);
  }
  return {
    bytes,
    total,
    senders: new Map(
      [...perSender].map(([app, senders]) => [
        app,
        [...senders]
          .map(([address, count]) => ({ address, count }))
          .sort((a, b) => b.count - a.count),
      ]),
    ),
    routes: [...routes.values()].map(({ pathSet, ...entry }) => ({
      ...entry,
      paths: [...pathSet],
      routeTotal: perRoute.get(`${entry.app}\0${entry.route}`) ?? entry.count,
    })),
  };
}

/** Raw addresses that clean to this one, for matching rows as they were recorded. */
const recorded = (address: string) => [address, `::ffff:${address}`];

function repeatingIn(analysis: Analysis, names: Map<string, string>, now: number) {
  const db = getRequestsSqlite();
  const windowStart = now - DAY;
  const found: RepeatingSender[] = [];
  for (const entry of analysis.routes) {
    if (
      entry.count < REPEATING_REQUESTS ||
      entry.count / entry.routeTotal < REPEATING_SHARE ||
      entry.last - entry.first < REPEATING_SPAN ||
      entry.last < now - REPEATING_QUIET
    )
      continue;
    // A route folded from many paths is matched by method alone; one loop asks for few paths.
    const paths = entry.paths.length <= 20 ? entry.paths : [];
    const where = `deployment_name = ? AND ip IN (?, ?) AND method = ?${
      paths.length ? ` AND path IN (${paths.map(() => '?').join(',')})` : ''
    }`;
    const args = [entry.app, ...recorded(entry.address), entry.method, ...paths];
    const minutes = db
      .prepare(
        `SELECT count(*) AS count FROM request_logs
         WHERE timestamp >= ? AND timestamp <= ? AND ${where}
         GROUP BY CAST(timestamp / ${MINUTE} AS INTEGER)`,
      )
      .all(entry.first, entry.last, ...args) as { count: number }[];
    const span = Math.max(1, Math.round((entry.last - entry.first) / MINUTE));
    if (
      !steady(
        minutes.map((minute) => minute.count),
        span,
      )
    )
      continue;
    // Already going when the day began: look further back for where it started.
    let since = entry.first;
    let sinceOrEarlier = false;
    if (entry.first - windowStart < 5 * MINUTE) {
      const floor = now - SINCE_LOOKBACK;
      const earliest = (
        db
          .prepare(
            `SELECT min(timestamp) AS first FROM request_logs
             WHERE timestamp >= ? AND timestamp < ? AND ${where}`,
          )
          .get(floor, windowStart, ...args) as { first: number | null }
      ).first;
      if (earliest) {
        since = earliest;
        sinceOrEarlier = earliest - floor < 5 * MINUTE;
      }
    }
    const computer = names.get(entry.address);
    found.push({
      app: entry.app,
      address: entry.address,
      ...(computer ? { computer } : {}),
      agent: describeBrowser(entry.agent),
      route: entry.route,
      requests: entry.count,
      routeShare: entry.count / entry.routeTotal,
      appShare: entry.count / (analysis.total.get(entry.app) || entry.count),
      perMinute: Math.round(entry.count / span),
      sentBytes: entry.sent,
      since,
      sinceOrEarlier,
    });
  }
  return found.sort((a, b) => b.requests - a.requests);
}

const answers = new Map<
  string,
  { at: number; value: { analysis: Analysis; repeating: RepeatingSender[] } }
>();
/** The last 24 hours of senders for these apps, read at most once a minute. */
function lastDay(apps: string[], now: number) {
  const key = [...apps].sort().join('\0');
  const kept = answers.get(key);
  if (kept && now - kept.at < ANSWER_FOR && now >= kept.at) return kept.value;
  const analysis = analyse(apps, now - DAY, now);
  const value = { analysis, repeating: repeatingIn(analysis, computerNames(), now) };
  answers.set(key, { at: now, value });
  for (const [other, answer] of answers)
    if (now - answer.at > 10 * ANSWER_FOR) answers.delete(other);
  return value;
}
/** Tests read fresh answers. */
export function forgetTraffic() {
  answers.clear();
}

/** The repeating senders of one app, for its own Requests page. */
export function repeatingSenders(app: string, now = Date.now()) {
  return lastDay([app], now).repeating;
}

export function traffic(
  owner: string,
  range: RequestRange,
  now = Date.now(),
  projectOf = new Map<string, string>(),
): TrafficResponse {
  const apps = getDeployments(owner).map((app) => app.name);
  const { ms, bucketMs } = REQUEST_RANGES[range];
  const from = now - ms;
  const db = getRequestsSqlite();
  const minutes = apps.length
    ? (db
        .prepare(
          `SELECT deployment_name AS app, bucket_ms AS at, count, errors_5xx AS errors
           FROM request_logs_1m
           WHERE bucket_ms >= ? AND bucket_ms <= ? AND deployment_name IN (${apps.map(() => '?').join(',')})`,
        )
        .all(Math.floor(from / MINUTE) * MINUTE, now, ...apps) as {
        app: string;
        at: number;
        count: number;
        errors: number;
      }[])
    : [];
  const perApp = new Map(apps.map((app) => [app, { requests: 0, recent: 0, errors: 0 }]));
  const buckets = new Map<number, number>();
  for (const minute of minutes) {
    const app = perApp.get(minute.app)!;
    app.requests += minute.count;
    app.errors += minute.errors;
    if (minute.at >= now - 5 * MINUTE) app.recent += minute.count;
    const at = Math.floor(minute.at / bucketMs) * bucketMs;
    buckets.set(at, (buckets.get(at) ?? 0) + minute.count);
  }
  const points: TrafficResponse['series']['points'] = [];
  for (let at = Math.floor(from / bucketMs) * bucketMs; at <= now; at += bucketMs)
    points.push({ at, perMinute: (buckets.get(at) ?? 0) / (bucketMs / MINUTE) });

  const day = lastDay(apps, now);
  const sendersWindowMs = Math.min(ms, DAY);
  const analysis =
    sendersWindowMs === DAY ? day.analysis : analyse(apps, now - sendersWindowMs, now);
  const names = computerNames();
  const named = (address: string) => {
    const computer = names.get(address);
    return computer ? { address, computer } : { address };
  };
  const everyone = new Map<string, number>();
  let counted = 0;
  for (const [, senders] of analysis.senders)
    for (const sender of senders) {
      everyone.set(sender.address, (everyone.get(sender.address) ?? 0) + sender.count);
      counted += sender.count;
    }
  const busiest = [...everyone].sort((a, b) => b[1] - a[1])[0];
  const sum = (pick: (app: { requests: number; recent: number; errors: number }) => number) =>
    [...perApp.values()].reduce((total, app) => total + pick(app), 0);
  return {
    range,
    from,
    to: now,
    requests: sum((app) => app.requests),
    perMinuteNow: Math.round(sum((app) => app.recent) / 5),
    serverErrors: sum((app) => app.errors),
    sendersWindowMs,
    sentBytes: [...analysis.bytes.values()].reduce((total, size) => total + size.sent, 0),
    receivedBytes: [...analysis.bytes.values()].reduce((total, size) => total + size.received, 0),
    topSender: busiest && counted ? { ...named(busiest[0]), share: busiest[1] / counted } : null,
    series: { bucketMs, points },
    apps: [...perApp]
      .map(([name, app]) => {
        const top = analysis.senders.get(name)?.[0];
        const all = analysis.total.get(name) ?? 0;
        const project = projectOf.get(name);
        return {
          name,
          ...(project ? { project } : {}),
          requests: app.requests,
          perMinuteNow: Math.round(app.recent / 5),
          serverErrors: app.errors,
          sentBytes: ms <= DAY ? (analysis.bytes.get(name)?.sent ?? 0) : null,
          topSender:
            top && all
              ? {
                  ...named(top.address),
                  share: top.count / all,
                  repeating: day.repeating.some(
                    (sender) => sender.app === name && sender.address === top.address,
                  ),
                }
              : null,
        };
      })
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
    repeating: day.repeating,
  };
}
