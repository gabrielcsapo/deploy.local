import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openRequestsDb, pruneRequests } from './requests-db.ts';
const root = mkdtempSync(join(tmpdir(), 'collector-'));
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
  return openRequestsDb(join(root, `${++sequence}.db`));
}
const collector = () => import('./telemetry.ts');
const now = 1_800_000_000_000;
const entry = (
  duration = 100,
  status = 200,
  route: string | null = '/photos/:id',
  timestamp = now,
) => ({ duration, status, route, timestamp });
test('route header decodes sf-string without exposing queries and preserves phases', async () => {
  const { parseRouteTiming } = await collector();
  assert.deepEqual(
    parseRouteTiming('cache;desc="a,b", route;desc="/photos/:id", match;dur=0.12, render;dur=22.4'),
    { route: '/photos/:id', phases: { match: 0.12, render: 22.4 } },
  );
  assert.equal(parseRouteTiming('route;desc="/a?token=secret"').route, null);
  assert.equal(parseRouteTiming('route;desc="/a\\x"').route, null);
  assert.equal(parseRouteTiming('route;desc="action:save"').route, 'action:save');
  assert.equal(parseRouteTiming(undefined).route, null);
});
test('edge minute histograms count unknown routes and 4xx/5xx exactly once', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [
      { name: 'app', entry: entry(100) },
      { name: 'app', entry: entry(200, 404) },
      { name: 'app', entry: entry(300, 500, null) },
    ]);
    const result = t.readPerformance(db, 'app', '24h', now + 60_000);
    assert.equal(result.summary.requests, 3);
    assert.equal(result.summary.errorRate, 1 / 3);
    assert.equal(result.routes[0].requests, 2);
    assert.equal(result.hasRouteData, true);
    assert.ok(result.summary.p95! >= 300 && result.summary.p95! < 330);
    assert.equal(result.summary.previous.requests, 0);
  } finally {
    db.close();
  }
});
test('v1 validators reject malformed records, unknown versions, URLs and invalid metrics atomically', async () => {
  const t = await collector();
  const record = {
    t: now,
    kind: 'page',
    route: '/photos/:id',
    status: 200,
    ms: 10,
    phases: { ssr: 9 },
    build: null,
    aborted: false,
  };
  assert.equal(t.validateServerBatch({ v: 1, records: [record] }, now).length, 1);
  for (const body of [
    { v: 2, records: [record] },
    { v: 1, records: [{ ...record, status: 999 }] },
    { v: 1, records: [{ ...record, route: '/a?q=private' }] },
    { v: 1, records: [{ ...record, phases: { ssr: -1 } }] },
    { v: 1, records: [{ ...record, t: now - 8 * 86_400_000 }] },
  ])
    assert.throws(() => t.validateServerBatch(body, now));
  assert.throws(() =>
    t.validateBrowserBatch({ v: 1, build: 'b', events: [{ type: 'load', route: '/', lcp: -1 }] }),
  );
  assert.throws(() => t.validateBrowserBatch({ v: 99, build: 'b', events: [] }));
});
test('page histograms, prefetch counts and newest error samples merge without raw telemetry', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.ingestBrowser(
      db,
      'app',
      {
        v: 1,
        build: 'b',
        events: [
          { type: 'load', route: '/', lcp: 1000, inp: 50, cls: 0.1, ttfb: 20 },
          { type: 'nav', route: '/', from: '/photos/:id', ms: 100, prefetch: 'hit' },
          {
            type: 'error',
            route: '/',
            name: 'Error',
            message: 'old',
            stack: 'at a',
            fingerprint: 'a'.repeat(40),
          },
        ],
      },
      now,
    );
    t.ingestServer(
      db,
      'app',
      {
        v: 1,
        records: [
          {
            t: now + 1,
            kind: 'error',
            route: '/',
            where: 'ssr',
            name: 'Error',
            message: 'new',
            stack: 'at b',
            fingerprint: 'a'.repeat(40),
          },
        ],
      },
      now + 1,
    );
    const r = t.readPerformance(db, 'app', '1h', now + 60_000);
    assert.equal(r.pageExperience[0].prefetch.hit, 1);
    assert.ok(r.pageExperience[0].lcp! >= 1000);
    assert.equal(r.errors[0].count, 2);
    assert.equal(r.errors[0].message, 'new');
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM request_logs').get() as { n: number }).n,
      0,
    );
  } finally {
    db.close();
  }
});
test('deployment tokens are hashed, unforgeable, isolated and survive reopening', async () => {
  const t = await collector();
  const db = fixture();
  try {
    const token = t.issueTelemetryToken(db, 'app');
    assert.equal(t.deploymentForToken(db, token), 'app');
    assert.equal(t.deploymentForToken(db, token + 'x'), null);
    assert.equal(t.deploymentForToken(db, ''), null);
    const rows = JSON.stringify(db.prepare('SELECT * FROM telemetry_tokens').all());
    assert.ok(!rows.includes(token));
    const second = t.issueTelemetryToken(db, 'other');
    assert.equal(t.deploymentForToken(db, second), 'other');
    const reopened = openRequestsDb(db.name);
    try {
      assert.equal(t.deploymentForToken(reopened, token), 'app');
    } finally {
      reopened.close();
    }
  } finally {
    db.close();
  }
});
test('release comparisons freeze first 500 edge requests and enforce traffic thresholds', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 100 }, () => ({
        name: 'app',
        entry: entry(100, 200, '/', now - 120_000),
      })),
    );
    t.registerTelemetryRelease(db, 'app', 'r1', now);
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 600 }, (_, i) => ({
        name: 'app',
        entry: entry(i < 500 ? 200 : 1, i < 10 ? 500 : 200, '/', now + 1 + i),
      })),
    );
    const r = t.readPerformance(db, 'app', '24h', now + 60_000).releases[0];
    assert.equal(r.comparison.after.requests, 500);
    assert.equal(r.comparison.verdict, 'slower');
    assert.equal(r.comparison.moreErrors, true);
    assert.equal(r.comparison.routes[0].route, '/');
  } finally {
    db.close();
  }
});
test('long-range performance queries use indexed rollups and never raw request_logs', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [{ name: 'app', entry: entry() }]);
    db.exec('DROP TABLE request_logs');
    assert.equal(t.readPerformance(db, 'app', '7d', now + 60_000).summary.requests, 1);
    const plan = db
      .prepare('EXPLAIN QUERY PLAN ' + t.ROUTE_RANGE_SQL)
      .all('app', now - 7 * 86_400_000, now + 60_000) as { detail: string }[];
    assert.ok(plan.some((row) => /SEARCH.*(INDEX|PRIMARY KEY)/.test(row.detail)));
    assert.ok(plan.every((row) => !row.detail.includes('SCAN')));
  } finally {
    db.close();
  }
});
test('telemetry retention matches request rollups and new databases reclaim pages incrementally', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [
      { name: 'app', entry: entry(100, 200, '/', now - 397 * 86_400_000) },
    ]);
    const old = now - 397 * 86_400_000;
    t.ingestBrowser(
      db,
      'app',
      {
        v: 1,
        build: 'old',
        events: [
          { type: 'load', route: '/', lcp: 10 },
          {
            type: 'error',
            route: '/',
            name: 'Error',
            message: 'old',
            stack: 'at old',
            fingerprint: 'b'.repeat(40),
          },
        ],
      },
      old,
    );
    t.registerTelemetryRelease(db, 'app', 'old-release', old);
    pruneRequests(db, now);
    for (const table of ['telemetry_pages', 'telemetry_errors', 'telemetry_releases'])
      assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare('SELECT count(*) AS n FROM telemetry_routes').get() as { n: number }).n,
      0,
    );
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 2);
  } finally {
    db.close();
  }
});
test('existing requests schema migrates route column idempotently without vacuuming existing files', async () => {
  const file = join(root, 'legacy.db');
  const old = new Database(file);
  old.exec(
    'CREATE TABLE request_logs(id INTEGER PRIMARY KEY AUTOINCREMENT,deployment_name TEXT,method TEXT,path TEXT,status INTEGER,duration INTEGER,timestamp INTEGER)',
  );
  old.close();
  const db = openRequestsDb(file);
  try {
    assert.ok(
      (db.pragma('table_info(request_logs)') as { name: string }[]).some(
        (row) => row.name === 'route',
      ),
    );
    assert.equal(db.pragma('auto_vacuum', { simple: true }), 0);
  } finally {
    db.close();
  }
});
test('release baseline includes pre-activation requests still buffered by edge writer', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.registerTelemetryRelease(db, 'app', 'buffered', now);
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 60 }, () => ({ name: 'app', entry: entry(100, 200, '/', now - 1000) })),
    );
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 500 }, () => ({ name: 'app', entry: entry(100, 200, '/', now + 1000) })),
    );
    const result = t.readPerformance(db, 'app', '1h', now + 60_000).releases[0].comparison;
    assert.equal(result.before.requests, 60);
    assert.equal(result.verdict, 'steady');
  } finally {
    db.close();
  }
});
test('scheduled requests vacuum consumes the full bounded pragma and frees pages', async () => {
  const { vacuumRequests } = await import('./requests-db.ts');
  const db = fixture();
  try {
    const insert = db.prepare(
      "INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES('app','GET',?,200,1,1)",
    );
    db.transaction(() => {
      for (let i = 0; i < 3000; i++) insert.run('/' + 'x'.repeat(1000));
    })();
    db.exec('DELETE FROM request_logs');
    const pages = Number(db.pragma('page_count', { simple: true }));
    vacuumRequests(db, 256);
    const freed = pages - Number(db.pragma('page_count', { simple: true }));
    assert.ok(freed > 1);
    assert.ok(freed <= 258, `freed ${freed} pages (including pointer-map pages)`);
  } finally {
    db.close();
  }
});
test('release routes retain independent first-500 windows until the hour ends', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(
      db,
      ['/busy', '/quiet'].flatMap((route) =>
        Array.from({ length: 60 }, () => ({
          name: 'app',
          entry: entry(100, 200, route, now - 120_000),
        })),
      ),
    );
    t.registerTelemetryRelease(db, 'app', 'per-route', now);
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 500 }, () => ({
        name: 'app',
        entry: entry(100, 200, '/busy', now + 1000),
      })),
    );
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 600 }, () => ({
        name: 'app',
        entry: entry(200, 200, '/quiet', now + 2000),
      })),
    );
    const result = t.readPerformance(db, 'app', '1h', now + 60_000).releases[0].comparison;
    assert.equal(result.after.requests, 500);
    const quiet = result.routes.find((r: { route: string }) => r.route === '/quiet');
    assert.equal(quiet?.after.requests, 500);
    assert.equal(quiet.verdict, 'slower');
  } finally {
    db.close();
  }
});
test('route slowest phase uses header render until server phase detail is available', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [
      { name: 'app', entry: { ...entry(), phases: { match: 1, render: 80 } } },
    ]);
    assert.equal(
      t.readPerformance(db, 'app', '1h', now + 60_000).routes[0].slowestPhase?.name,
      'render',
    );
    t.ingestServer(
      db,
      'app',
      {
        v: 1,
        records: [
          {
            t: now,
            kind: 'page',
            route: '/photos/:id',
            status: 200,
            ms: 100,
            phases: {},
            build: null,
            aborted: false,
          },
        ],
      },
      now,
    );
    assert.equal(
      t.readPerformance(db, 'app', '1h', now + 60_000).routes[0].slowestPhase?.name,
      'render',
    );
    t.ingestServer(
      db,
      'app',
      {
        v: 1,
        records: [
          {
            t: now,
            kind: 'page',
            route: '/photos/:id',
            status: 200,
            ms: 100,
            phases: { rsc: 10, ssr: 70, stream: 20 },
            build: null,
            aborted: false,
          },
        ],
      },
      now,
    );
    assert.equal(
      t.readPerformance(db, 'app', '1h', now + 60_000).routes[0].slowestPhase?.name,
      'ssr',
    );
  } finally {
    db.close();
  }
});
test('release error verdict includes an exact one-percentage-point increase', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 200 }, (_, i) => ({
        name: 'app',
        entry: entry(100, i === 0 ? 500 : 200, '/', now - 120_000),
      })),
    );
    t.registerTelemetryRelease(db, 'app', 'error-boundary', now);
    t.writeEdgeTelemetry(
      db,
      Array.from({ length: 200 }, (_, i) => ({
        name: 'app',
        entry: entry(100, i < 3 ? 500 : 200, '/', now + 1000),
      })),
    );
    const result = t.readPerformance(db, 'app', '24h', now + 3_660_000).releases[0].comparison;
    assert.equal(result.before.errorRate, 0.005);
    assert.equal(result.after.errorRate, 0.015);
    assert.equal(result.verdict, 'more-errors');
  } finally {
    db.close();
  }
});

test('phase percentiles retain sub-ms timing, merge buckets, and prefer detailed server phases', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [
      { name: 'app', entry: { ...entry(), phases: { match: 1, render: 80 } } },
    ]);
    for (const [at, rsc] of [
      [now - 60_000, 10],
      [now, 20],
      [now + 60_000, 90],
    ]) {
      t.ingestServer(
        db,
        'app',
        {
          v: 1,
          records: [
            {
              t: at,
              kind: 'page',
              route: '/photos/:id',
              status: 200,
              ms: 100,
              phases: { match: 0.1, rsc, ssr: 0, stream: 7 },
              build: null,
              aborted: false,
            },
          ],
        },
        now + 60_000,
      );
    }
    const result = t.readPerformance(db, 'app', '1h', now + 120_000);
    assert.equal(result.summary.requests, 1); // server records never double-count edge traffic
    const phases = result.routes[0].phases;
    assert.ok(phases.match.p50! >= 0.1 && phases.match.p50! < 0.11);
    assert.ok(phases.rsc.p50! >= 20 && phases.rsc.p50! < 22);
    assert.ok(phases.rsc.p95! >= 90 && phases.rsc.p95! < 99);
    assert.deepEqual(phases.ssr, { p50: 0, p95: 0 });
    assert.equal(phases.render, undefined);
    assert.equal(result.routes[0].slowestPhase?.name, 'rsc');
  } finally {
    db.close();
  }
});

test('legacy and mixed phase rollups cannot fabricate percentiles from averages', async () => {
  const t = await collector();
  const db = fixture();
  try {
    t.writeEdgeTelemetry(db, [{ name: 'app', entry: { ...entry(), phases: { match: 1 } } }]);
    db.prepare('UPDATE telemetry_routes SET phases=?').run(
      JSON.stringify({ match: { sum: 1, count: 1 } }),
    );
    assert.deepEqual(t.readPerformance(db, 'app', '1h', now + 60_000).routes[0].phases.match, {
      p50: null,
      p95: null,
    });
    t.writeEdgeTelemetry(db, [
      {
        name: 'app',
        entry: { ...entry(100, 200, '/photos/:id', now + 60_000), phases: { match: 3 } },
      },
    ]);
    assert.deepEqual(t.readPerformance(db, 'app', '1h', now + 120_000).routes[0].phases.match, {
      p50: null,
      p95: null,
    });
  } finally {
    db.close();
  }
});

test('release snapshots retain measured phase percentiles on both sides', async () => {
  const t = await collector();
  const db = fixture();
  try {
    const batch = (timestamp: number, render: number) =>
      Array.from({ length: 50 }, () => ({
        name: 'app',
        entry: { ...entry(100, 200, '/', timestamp), phases: { match: 0.1, render } },
      }));
    t.writeEdgeTelemetry(db, batch(now - 60_000, 10));
    t.registerTelemetryRelease(db, 'app', 'new', now);
    t.writeEdgeTelemetry(db, batch(now + 1000, 20));
    const result = t.readPerformance(db, 'app', '1h', now + 3_660_000).releases[0]?.comparison;
    // The release falls just outside 1h, but remains visible in the day window.
    assert.equal(result, undefined);
    const comparison = t.readPerformance(db, 'app', '24h', now + 3_660_000).releases[0].comparison;
    assert.ok(comparison.routes[0].before.phases.render.p50 >= 10);
    assert.ok(comparison.routes[0].before.phases.render.p50 < 11);
    assert.ok(comparison.routes[0].after.phases.render.p50 >= 20);
    assert.ok(comparison.routes[0].after.phases.render.p50 < 22);
    assert.equal(comparison.before.requests, 50);
    assert.equal(comparison.after.requests, 50);
  } finally {
    db.close();
  }
});
