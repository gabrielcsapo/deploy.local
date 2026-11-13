import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './kernel/db/sqlite.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Fixed log-spaced upper bounds: <10% relative quantile error, 0..~36 days.
// CLS uses the same histogram in thousandths. Zero has its own bucket.
export const HISTOGRAM_BOUNDS = [0, ...Array.from({ length: 230 }, (_, i) => 1.1 ** i)];
type Histogram = number[];
// Phase histograms use signed log buckets so sub-millisecond route matching
// keeps the same <10% precision as longer phases. Older rollups have only sums.
type Phases = Record<string, { sum: number; count: number; histogram?: Record<string, number> }>;
type Aggregate = {
  count: number;
  errors4: number;
  errors5: number;
  histogram: Histogram;
  phases: Phases;
};
function empty(): Aggregate {
  return { count: 0, errors4: 0, errors5: 0, histogram: [], phases: {} };
}
function addValue(hist: Histogram, value: number) {
  const index =
    value === 0
      ? 0
      : Math.min(
          HISTOGRAM_BOUNDS.length - 1,
          1 + Math.max(0, Math.ceil(Math.log(value) / Math.log(1.1))),
        );
  while (hist.length <= index) hist.push(0);
  hist[index]++;
}
function mergeHistogram(target: Histogram, source: Histogram) {
  for (let i = 0; i < source.length; i++) target[i] = (target[i] || 0) + source[i];
}
export function histogramPercentile(hist: Histogram, p: number): number | null {
  const count = hist.reduce((a, b) => a + b, 0);
  if (!count) return null;
  const rank = Math.ceil(count * p);
  let n = 0;
  for (let i = 0; i < hist.length; i++) if ((n += hist[i]) >= rank) return HISTOGRAM_BOUNDS[i];
  return null;
}
function merge(target: Aggregate, source: Aggregate) {
  target.count += source.count;
  target.errors4 += source.errors4;
  target.errors5 += source.errors5;
  mergeHistogram(target.histogram, source.histogram);
  for (const [key, value] of Object.entries(source.phases)) {
    const phase = (target.phases[key] ??= { sum: 0, count: 0 });
    phase.sum += value.sum;
    phase.count += value.count;
    for (const [bucket, count] of Object.entries(value.histogram ?? {})) {
      const histogram = (phase.histogram ??= {});
      histogram[bucket] = (histogram[bucket] ?? 0) + count;
    }
  }
}
function add(
  agg: Aggregate,
  duration: number,
  status: number,
  phases: Record<string, number> = {},
) {
  agg.count++;
  if (status >= 500) agg.errors5++;
  else if (status >= 400) agg.errors4++;
  addValue(agg.histogram, duration);
  for (const [key, value] of Object.entries(phases)) {
    const phase = (agg.phases[key] ??= { sum: 0, count: 0 });
    phase.sum += value;
    phase.count++;
    const histogram = (phase.histogram ??= {});
    const bucket = value === 0 ? 'zero' : String(Math.ceil(Math.log(value) / Math.log(1.1)));
    histogram[bucket] = (histogram[bucket] ?? 0) + 1;
  }
}
function phasePercentiles(phases: Phases) {
  return Object.fromEntries(
    Object.entries(phases).map(([name, phase]) => {
      const buckets = Object.entries(phase.histogram ?? {})
        .map(([bucket, count]) => ({ ms: bucket === 'zero' ? 0 : 1.1 ** Number(bucket), count }))
        .sort((a, b) => a.ms - b.ms);
      const measured = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
      const percentile = (p: number) => {
        // Never present a new subset as the percentile of a legacy/mixed rollup.
        if (!measured || measured !== phase.count) return null;
        let count = 0;
        return buckets.find((bucket) => (count += bucket.count) >= Math.ceil(measured * p))!.ms;
      };
      return [name, { p50: percentile(0.5), p95: percentile(0.95) }];
    }),
  );
}
function summary(agg: Aggregate) {
  return {
    requests: agg.count,
    p50: histogramPercentile(agg.histogram, 0.5),
    p95: histogramPercentile(agg.histogram, 0.95),
    errorRate: agg.count ? agg.errors5 / agg.count : 0,
    errors4xx: agg.errors4,
    errors5xx: agg.errors5,
    phases: phasePercentiles(agg.phases),
  };
}
function hasControlCharacter(value: string) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
export function validRoute(route: unknown): route is string {
  return (
    typeof route === 'string' &&
    route.length > 0 &&
    route.length <= 512 &&
    !/[?#]/.test(route) &&
    !hasControlCharacter(route) &&
    !route.includes('://') &&
    (route.startsWith('/') || route === '__not_found' || /^action:[\w.-]+$/.test(route))
  );
}
/** Split delimiters outside sf-strings; only quote and backslash may be escaped. */
function split(value: string, delimiter: string) {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === delimiter) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted || escaped) return [];
  parts.push(value.slice(start).trim());
  return parts;
}
export function parseRouteTiming(header: string | string[] | undefined): {
  route: string | null;
  phases: Record<string, number>;
} {
  const result: ReturnType<typeof parseRouteTiming> = { route: null, phases: {} };
  if (!header) return result;
  const value = Array.isArray(header) ? header.join(',') : header;
  if (value.length > 8192) return result;
  let routes = 0;
  for (const metric of split(value, ',')) {
    const [name, ...parameters] = split(metric, ';');
    if (name === 'route') {
      routes++;
      const desc = parameters.find((p) => p.startsWith('desc='))?.slice(5);
      if (desc && /^"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/.test(desc)) {
        const route = desc.slice(1, -1).replace(/\\(["\\])/g, '$1');
        if (validRoute(route)) result.route = route;
      }
    } else if (['match', 'render', 'action'].includes(name)) {
      const value = parameters.find((p) => p.startsWith('dur='))?.slice(4);
      if (value && /^\d+(?:\.\d+)?$/.test(value) && Number(value) <= DAY)
        result.phases[name] = Number(value);
    }
  }
  if (routes !== 1) result.route = null;
  return result;
}
interface RouteRow {
  deployment_name: string;
  bucket_ms: number;
  route: string;
  source: string;
  count: number;
  errors_4xx: number;
  errors_5xx: number;
  histogram: string;
  phases: string;
}
function aggregateRow(row: RouteRow): Aggregate {
  return {
    count: row.count,
    errors4: row.errors_4xx,
    errors5: row.errors_5xx,
    histogram: JSON.parse(row.histogram),
    phases: JSON.parse(row.phases),
  };
}
export const ROUTE_RANGE_SQL = `SELECT * FROM telemetry_routes WHERE deployment_name=? AND bucket_ms>=? AND bucket_ms<? ORDER BY bucket_ms`;
function routesBetween(db: Database, name: string, from: number, to: number, source = 'edge') {
  const routes: Record<string, Aggregate> = Object.create(null);
  for (const row of db.prepare(ROUTE_RANGE_SQL).all(name, from, to) as RouteRow[]) {
    if (row.source !== source) continue;
    merge((routes[row.route] ??= empty()), aggregateRow(row));
  }
  return routes;
}
function total(routes: Record<string, Aggregate>) {
  const agg = empty();
  for (const value of Object.values(routes)) merge(agg, value);
  return agg;
}
function upsertRoutes(
  db: Database,
  batches: Map<
    string,
    { name: string; bucket: number; route: string; source: string; agg: Aggregate }
  >,
) {
  const read = db.prepare(
    'SELECT * FROM telemetry_routes WHERE deployment_name=? AND bucket_ms=? AND route=? AND source=?',
  );
  const write = db.prepare(
    `INSERT INTO telemetry_routes VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(deployment_name,bucket_ms,route,source) DO UPDATE SET count=excluded.count,errors_4xx=excluded.errors_4xx,errors_5xx=excluded.errors_5xx,histogram=excluded.histogram,phases=excluded.phases`,
  );
  for (const { name, bucket, route, source, agg } of batches.values()) {
    const prior = read.get(name, bucket, route, source) as RouteRow | undefined;
    if (prior) merge(agg, aggregateRow(prior));
    write.run(
      name,
      bucket,
      route,
      source,
      agg.count,
      agg.errors4,
      agg.errors5,
      JSON.stringify(agg.histogram),
      JSON.stringify(agg.phases),
    );
  }
}
interface EdgeEntry {
  timestamp: number;
  duration: number;
  status: number;
  route?: string | null;
  phases?: Record<string, number>;
}
export function writeEdgeTelemetry(db: Database, items: Array<{ name: string; entry: EdgeEntry }>) {
  db.transaction(() => {
    const batches = new Map();
    for (const { name, entry } of items) {
      const route = entry.route && validRoute(entry.route) ? entry.route : '';
      const bucket = Math.floor(entry.timestamp / MINUTE) * MINUTE;
      const key = JSON.stringify([name, bucket, route]);
      const batch = batches.get(key) ?? { name, bucket, route, source: 'edge', agg: empty() };
      add(batch.agg, entry.duration, entry.status, entry.phases);
      batches.set(key, batch);
    }
    // Observe before adding the new minute deltas to avoid baseline contamination.
    observeReleases(db, items);
    upsertRoutes(db, batches);
  })();
}

function bad(message = 'Invalid telemetry'): never {
  throw Object.assign(new Error(message), { status: 400 });
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) bad();
}
function text(value: unknown, max: number, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > max) bad();
}
function metric(value: unknown, max = DAY): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) bad();
}
function route(value: unknown): asserts value is string {
  if (!validRoute(value)) bad('Invalid masked route');
}
type ErrorRecord = {
  t: number;
  kind: 'error';
  route: string;
  where: 'rsc' | 'ssr' | 'action';
  name: string;
  message: string;
  stack: string;
  fingerprint: string;
};
type ServerRecord =
  | ErrorRecord
  | {
      t: number;
      kind: 'page' | 'rsc' | 'action';
      route: string;
      status: number;
      ms: number;
      phases: Record<string, number>;
      build: string | null;
      aborted: boolean;
    };
function validateError(r: Record<string, unknown>) {
  text(r.name, 200);
  text(r.message, 500);
  text(r.stack, 4000);
  if (typeof r.fingerprint !== 'string' || !/^[a-f0-9]{40}$/.test(r.fingerprint))
    bad('Invalid fingerprint');
}
export function validateServerBatch(body: unknown, now = Date.now()): ServerRecord[] {
  const b = object(body);
  keys(b, ['v', 'records']);
  if (b.v !== 1) bad('Unsupported telemetry version');
  if (!Array.isArray(b.records) || b.records.length > 1000) bad();
  for (const value of b.records) {
    const r = object(value);
    route(r.route);
    metric(r.t, now + 5 * MINUTE);
    if ((r.t as number) < now - 7 * DAY) bad('Stale telemetry');
    if (r.kind === 'error') {
      keys(r, ['t', 'kind', 'route', 'where', 'name', 'message', 'stack', 'fingerprint']);
      validateError(r);
      if (!['rsc', 'ssr', 'action'].includes(r.where as string)) bad();
    } else {
      keys(r, ['t', 'kind', 'route', 'status', 'ms', 'phases', 'build', 'aborted']);
      if (
        !['page', 'rsc', 'action'].includes(r.kind as string) ||
        !Number.isInteger(r.status) ||
        (r.status as number) < 100 ||
        (r.status as number) > 599 ||
        typeof r.aborted !== 'boolean'
      )
        bad();
      metric(r.ms);
      text(r.build, 200, true);
      const phases = object(r.phases);
      keys(phases, ['match', 'rsc', 'ssr', 'stream', 'action']);
      for (const value of Object.values(phases)) metric(value);
    }
  }
  return b.records as ServerRecord[];
}
type BrowserEvent = { type: 'load' | 'nav' | 'error'; route: string; [key: string]: unknown };
export function validateBrowserBatch(body: unknown): {
  build: string | null;
  events: BrowserEvent[];
} {
  const b = object(body);
  keys(b, ['v', 'build', 'events']);
  if (b.v !== 1) bad('Unsupported telemetry version');
  text(b.build, 200, true);
  if (!Array.isArray(b.events) || b.events.length > 100) bad();
  for (const value of b.events) {
    const e = object(value);
    route(e.route);
    if (e.type === 'load') {
      keys(e, ['type', 'route', 'ttfb', 'fcp', 'lcp', 'cls', 'inp']);
      for (const key of ['ttfb', 'fcp', 'lcp', 'inp']) if (e[key] !== undefined) metric(e[key]);
      if (e.cls !== undefined) metric(e.cls, 1000);
    } else if (e.type === 'nav') {
      keys(e, ['type', 'route', 'from', 'ms', 'prefetch']);
      route(e.from);
      metric(e.ms);
      if (!['hit', 'inflight', 'miss'].includes(e.prefetch as string)) bad();
    } else if (e.type === 'error') {
      keys(e, ['type', 'route', 'name', 'message', 'stack', 'fingerprint']);
      validateError(e);
    } else bad();
  }
  return { build: b.build as string | null, events: b.events as BrowserEvent[] };
}
function errorUpsert(
  db: Database,
  name: string,
  r: { route: string; name: string; message: string; stack: string; fingerprint: string },
  where: string,
  build: string | null,
  t: number,
) {
  db.prepare(
    `INSERT INTO telemetry_errors VALUES (?,?,1,?,?,?,?,?,?,?,?) ON CONFLICT(deployment_name,fingerprint) DO UPDATE SET count=count+1,first_seen=min(first_seen,excluded.first_seen),last_seen=max(last_seen,excluded.last_seen),route=CASE WHEN excluded.last_seen>=last_seen THEN excluded.route ELSE route END,location=CASE WHEN excluded.last_seen>=last_seen THEN excluded.location ELSE location END,build=CASE WHEN excluded.last_seen>=last_seen THEN excluded.build ELSE build END,name=CASE WHEN excluded.last_seen>=last_seen THEN excluded.name ELSE name END,message=CASE WHEN excluded.last_seen>=last_seen THEN excluded.message ELSE message END,stack=CASE WHEN excluded.last_seen>=last_seen THEN excluded.stack ELSE stack END`,
  ).run(name, r.fingerprint, t, t, r.route, where, build, r.name, r.message, r.stack);
}
export function ingestServer(db: Database, name: string, body: unknown, now = Date.now()) {
  const records = validateServerBatch(body, now);
  db.transaction(() => {
    const batches = new Map();
    for (const r of records) {
      if (r.kind === 'error') {
        errorUpsert(db, name, r, r.where, null, r.t);
        continue;
      }
      const bucket = Math.floor(r.t / MINUTE) * MINUTE;
      const key = JSON.stringify([bucket, r.route]);
      const batch = batches.get(key) ?? {
        name,
        bucket,
        route: r.route,
        source: 'server',
        agg: empty(),
      };
      add(batch.agg, r.ms, r.status, r.phases);
      batches.set(key, batch);
    }
    upsertRoutes(db, batches);
  })();
}
interface PageRow {
  route: string;
  metrics: string;
  hit: number;
  inflight: number;
  miss: number;
}
export function ingestBrowser(db: Database, name: string, body: unknown, now = Date.now()) {
  const b = validateBrowserBatch(body);
  const bucket = Math.floor(now / HOUR) * HOUR;
  db.transaction(() => {
    for (const e of b.events) {
      if (e.type === 'error') {
        errorUpsert(db, name, e as unknown as ErrorRecord, 'browser', b.build, now);
        continue;
      }
      const prior = db
        .prepare(
          'SELECT * FROM telemetry_pages WHERE deployment_name=? AND bucket_ms=? AND route=?',
        )
        .get(name, bucket, e.route) as PageRow | undefined;
      const metrics: Record<string, Histogram> = prior ? JSON.parse(prior.metrics) : {};
      const counts = {
        hit: prior?.hit ?? 0,
        inflight: prior?.inflight ?? 0,
        miss: prior?.miss ?? 0,
      };
      if (e.type === 'nav') {
        addValue((metrics.nav ??= []), e.ms as number);
        counts[e.prefetch as keyof typeof counts]++;
      } else
        for (const key of ['ttfb', 'fcp', 'lcp', 'inp', 'cls'])
          if (e[key] !== undefined)
            addValue((metrics[key] ??= []), (e[key] as number) * (key === 'cls' ? 1000 : 1));
      db.prepare(
        `INSERT INTO telemetry_pages VALUES(?,?,?,?,?,?,?) ON CONFLICT(deployment_name,bucket_ms,route) DO UPDATE SET metrics=excluded.metrics,hit=excluded.hit,inflight=excluded.inflight,miss=excluded.miss`,
      ).run(
        name,
        bucket,
        e.route,
        JSON.stringify(metrics),
        counts.hit,
        counts.inflight,
        counts.miss,
      );
    }
  })();
}
export function issueTelemetryToken(db: Database, name: string) {
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO telemetry_tokens VALUES(?,?,?)').run(hashToken(token), name, Date.now());
  return token;
}
function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}
export function deploymentForToken(db: Database, token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return (
    (
      db
        .prepare('SELECT deployment_name FROM telemetry_tokens WHERE token_hash=?')
        .get(hashToken(token)) as { deployment_name: string } | undefined
    )?.deployment_name ?? null
  );
}

type ReleaseRow = {
  deployment_name: string;
  release_id: string;
  released_at: number;
  baseline: string;
  observed: string;
  comparison: string | null;
};
type Observation = { routes: Record<string, Aggregate>; count: number; app: Aggregate };
export function registerTelemetryRelease(db: Database, name: string, id: string, at = Date.now()) {
  db.transaction(() => {
    if (
      db
        .prepare('SELECT 1 FROM telemetry_releases WHERE deployment_name=? AND release_id=?')
        .get(name, id)
    )
      return;
    finalizeReleases(db, at, name);
    // A subsequent activation closes the preceding window even when it has <500 requests.
    for (const r of db
      .prepare('SELECT * FROM telemetry_releases WHERE deployment_name=? AND finalized=0')
      .all(name) as ReleaseRow[])
      finishRelease(db, r);
    const baseline = routesBetween(db, name, at - DAY, at);
    db.prepare(
      'INSERT INTO telemetry_releases(deployment_name,release_id,released_at,baseline,observed,comparison) VALUES(?,?,?,?,?,NULL)',
    ).run(
      name,
      id,
      at,
      JSON.stringify(baseline),
      JSON.stringify({ routes: {}, count: 0, app: empty() }),
    );
  })();
}
function comparison(before: Aggregate, after: Aggregate) {
  const b = summary(before),
    a = summary(after);
  const enoughTraffic = b.requests >= 50 && a.requests >= 50;
  const slower =
    enoughTraffic &&
    a.p95 !== null &&
    b.p95 !== null &&
    a.p95 >= b.p95 * 1.25 &&
    a.p95 - b.p95 >= 30;
  const moreErrors =
    enoughTraffic &&
    (after.errors5 * before.count - before.errors5 * after.count) * 100 >=
      before.count * after.count &&
    after.errors5 * before.count >= 2 * before.errors5 * after.count;
  return {
    before: b,
    after: a,
    enoughTraffic,
    verdict: enoughTraffic ? (slower ? 'slower' : moreErrors ? 'more-errors' : 'steady') : null,
    slower,
    moreErrors,
  };
}
function finishRelease(
  db: Database,
  r: ReleaseRow,
  observation: Observation = JSON.parse(r.observed),
  finalized = true,
) {
  const baseline: Record<string, Aggregate> = JSON.parse(r.baseline);
  const routes = Object.entries(observation.routes)
    .filter(([key]) => key !== '')
    .map(([route, after]) => ({ route, ...comparison(baseline[route] ?? empty(), after) }))
    .filter((r) => r.enoughTraffic);
  const result = {
    ...comparison(total(baseline), observation.app ?? total(observation.routes)),
    routes,
  };
  db.prepare(
    'UPDATE telemetry_releases SET observed=?,comparison=?,finalized=? WHERE deployment_name=? AND release_id=?',
  ).run(
    JSON.stringify(observation),
    JSON.stringify(result),
    finalized ? 1 : 0,
    r.deployment_name,
    r.release_id,
  );
}
export function finalizeReleases(db: Database, now = Date.now(), name?: string) {
  const sql =
    'SELECT * FROM telemetry_releases WHERE finalized=0 AND released_at<=?' +
    (name ? ' AND deployment_name=?' : '');
  for (const r of db
    .prepare(sql)
    .all(...(name ? [now - HOUR, name] : [now - HOUR])) as ReleaseRow[])
    finishRelease(db, r);
}
function observeReleases(db: Database, items: Array<{ name: string; entry: EdgeEntry }>) {
  const byName = new Map<string, EdgeEntry[]>();
  for (const item of items) {
    const entries = byName.get(item.name) ?? [];
    entries.push(item.entry);
    byName.set(item.name, entries);
  }
  for (const [name, entries] of byName) {
    const rows = db
      .prepare(
        'SELECT * FROM telemetry_releases WHERE deployment_name=? AND finalized=0 ORDER BY released_at',
      )
      .all(name) as ReleaseRow[];
    for (const r of rows) {
      const o: Observation = JSON.parse(r.observed);
      o.app ??= total(o.routes);
      const end = r.released_at + HOUR;
      const baseline: Record<string, Aggregate> = JSON.parse(r.baseline);
      for (const e of entries.sort((a, b) => a.timestamp - b.timestamp)) {
        if (e.timestamp < r.released_at) {
          if (e.timestamp >= r.released_at - DAY) {
            const key = e.route && validRoute(e.route) ? e.route : '';
            const agg = Object.hasOwn(baseline, key) ? baseline[key] : (baseline[key] = empty());
            add(agg, e.duration, e.status, e.phases);
          }
          continue;
        }
        if (e.timestamp >= end) continue;
        // Only own properties of JSON maps can contain route aggregates.
        const key = e.route && validRoute(e.route) ? e.route : '';
        const agg = Object.hasOwn(o.routes, key) ? o.routes[key] : (o.routes[key] = empty());
        if (agg.count < 500) add(agg, e.duration, e.status, e.phases);
        if (o.count < 500) {
          add(o.app, e.duration, e.status, e.phases);
          o.count++;
        }
      }
      r.baseline = JSON.stringify(baseline);
      db.prepare(
        'UPDATE telemetry_releases SET baseline=? WHERE deployment_name=? AND release_id=?',
      ).run(r.baseline, name, r.release_id);
      if (o.count >= 500) finishRelease(db, r, o, false);
      else
        db.prepare(
          'UPDATE telemetry_releases SET observed=? WHERE deployment_name=? AND release_id=?',
        ).run(JSON.stringify(o), name, r.release_id);
    }
  }
}
interface ErrorRow {
  fingerprint: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  route: string;
  where: string;
  build: string | null;
  name: string;
  message: string;
  stack: string;
}
export function readPerformance(
  db: Database,
  name: string,
  range: '1h' | '24h' | '7d',
  now = Date.now(),
) {
  const ms = { '1h': HOUR, '24h': DAY, '7d': 7 * DAY }[range];
  if (!ms) bad('range must be 1h, 24h or 7d');
  // Whole minute/hour buckets, half-open ranges; previous never overlaps current.
  const to = Math.ceil(now / MINUTE) * MINUTE,
    from = to - ms;
  finalizeReleases(db, now, name);
  const routes = routesBetween(db, name, from, to),
    previous = routesBetween(db, name, from - ms, from),
    server = routesBetween(db, name, from, to, 'server');
  const current = total(routes),
    prior = total(previous);
  // Legacy rollups have no histogram. Include their counts while returning unknown percentiles.
  const legacy = (start: number, end: number) =>
    db
      .prepare(
        'SELECT coalesce(sum(count),0) AS count,coalesce(sum(errors_4xx),0) AS errors4,coalesce(sum(errors_5xx),0) AS errors5 FROM request_logs_1m WHERE deployment_name=? AND bucket_ms>=? AND bucket_ms<?',
      )
      .get(name, start, end) as { count: number; errors4: number; errors5: number };
  for (const [agg, start, end] of [
    [current, from, to],
    [prior, from - ms, from],
  ] as const) {
    const old = legacy(start, end);
    if (old.count > agg.count) {
      agg.count = old.count;
      agg.errors4 = old.errors4;
      agg.errors5 = old.errors5;
      agg.histogram = [];
    }
  }
  const pageMap = new Map<
    string,
    {
      metrics: Record<string, Histogram>;
      prefetch: { hit: number; inflight: number; miss: number };
    }
  >();
  for (const row of db
    .prepare(
      'SELECT * FROM telemetry_pages WHERE deployment_name=? AND bucket_ms>=? AND bucket_ms<?',
    )
    .all(name, Math.floor(from / HOUR) * HOUR, to) as PageRow[]) {
    const page = pageMap.get(row.route) ?? {
      metrics: {},
      prefetch: { hit: 0, inflight: 0, miss: 0 },
    };
    for (const [key, hist] of Object.entries(JSON.parse(row.metrics) as Record<string, Histogram>))
      mergeHistogram((page.metrics[key] ??= []), hist);
    for (const key of ['hit', 'inflight', 'miss'] as const) page.prefetch[key] += row[key];
    pageMap.set(row.route, page);
  }
  const pageExperience = [...pageMap].map(([route, page]) => ({
    route,
    lcp: histogramPercentile(page.metrics.lcp ?? [], 0.75),
    inp: histogramPercentile(page.metrics.inp ?? [], 0.75),
    cls: page.metrics.cls ? (histogramPercentile(page.metrics.cls, 0.75) ?? 0) / 1000 : null,
    ttfb: histogramPercentile(page.metrics.ttfb ?? [], 0.75),
    fcp: histogramPercentile(page.metrics.fcp ?? [], 0.75),
    navigation: {
      p50: histogramPercentile(page.metrics.nav ?? [], 0.5),
      p95: histogramPercentile(page.metrics.nav ?? [], 0.95),
    },
    prefetch: page.prefetch,
  }));
  return {
    range,
    from,
    to,
    summary: { ...summary(current), previous: summary(prior) },
    hasRouteData: Object.keys(routes).some(Boolean),
    routes: Object.entries(routes)
      .filter(([route]) => route !== '')
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 50)
      .map(([route, agg]) => {
        const detail = server[route]?.phases;
        const phases = detail && Object.keys(detail).length ? detail : agg.phases;
        const slowest = Object.entries(phases).sort(
          (a, b) => b[1].sum / b[1].count - a[1].sum / a[1].count,
        )[0];
        return {
          route,
          ...summary(agg),
          phases: phasePercentiles(phases),
          slowestPhase: slowest
            ? { name: slowest[0], ms: slowest[1].sum / slowest[1].count }
            : null,
        };
      }),
    pageExperience,
    errors: db
      .prepare(
        'SELECT fingerprint,count,first_seen AS firstSeen,last_seen AS lastSeen,route,location AS "where",build,name,message,stack FROM telemetry_errors WHERE deployment_name=? AND last_seen>=? AND last_seen<? ORDER BY last_seen DESC LIMIT 20',
      )
      .all(name, from, to) as ErrorRow[],
    releases: (
      db
        .prepare(
          'SELECT * FROM telemetry_releases WHERE deployment_name=? AND released_at>=? AND released_at<? ORDER BY released_at DESC',
        )
        .all(name, from, to) as ReleaseRow[]
    ).map((r) => ({
      id: r.release_id,
      at: r.released_at,
      comparison: r.comparison ? JSON.parse(r.comparison) : null,
    })),
  };
}
