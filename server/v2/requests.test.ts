import { getRequestsSqlite } from '../requests-db.ts';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'v2-requests-test-'));
process.env.DEPLOY_DATA_DIR = root;
const { saveDeployment, registerUser, authenticate, _resetDb } = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { writeCapture } = await import('../capture.ts');
const { describeBrowser, errorReason, normalizePath, pathFilter } = await import('./requests.ts');
const { v2Api } = await import('./api.ts');
const owner = 'gabriel';
const token = registerUser(owner, 'test-password').token!;
const headers = { 'x-deploy-username': owner, 'x-deploy-token': token };
saveDeployment({ name: 'home-gym', username: owner, type: 'web' });
saveDeployment({ name: 'private', username: 'other', type: 'web' });
const fetch = routeFetch((req, res) =>
  v2Api(req, res, (request, response) => {
    const username = request.headers['x-deploy-username'] as string;
    if (authenticate(username, request.headers['x-deploy-token'] as string)) return { username };
    response.writeHead(401);
    response.end('{}');
    return null;
  }),
);
const origin = 'http://localhost/api/apps';
after(() => {
  db.close();
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});

const now = Date.now();
const minute = 60_000;
const releasedAt = now - 30 * minute;
save('v2-release', owner, {
  id: 'r1',
  release: {
    id: 'r1',
    projectId: 'home-gym',
    source: { kind: 'cli', ref: 'CLI', commit: '9c3e1fa0000' },
    startedBy: owner,
    apps: [{ appId: 'home-gym', to: 'r1' }],
    migrations: [],
    steps: [{ name: 'activate', state: 'done', endedAt: new Date(releasedAt).toISOString() }],
    state: 'live',
  },
});

// Two hours of traffic: fast pages all along, then a slow export that times out after the release.
const sqlite = getRequestsSqlite();
const insert = sqlite.prepare(
  `INSERT INTO request_logs (deployment_name, method, path, status, duration, timestamp, ip, user_agent, referrer, request_size, response_size, query_params, username, capture_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
const rollup = sqlite.prepare(
  `INSERT INTO request_logs_1m (deployment_name, bucket_ms, count, errors_4xx, errors_5xx, duration_sum, duration_min, duration_max)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT DO UPDATE SET count = count + excluded.count, errors_4xx = errors_4xx + excluded.errors_4xx, errors_5xx = errors_5xx + excluded.errors_5xx`,
);
function log(
  at: number,
  method: string,
  path: string,
  status: number,
  duration: number,
  extra: any = {},
) {
  insert.run(
    'home-gym',
    method,
    path,
    status,
    duration,
    at,
    extra.ip ?? '192.168.1.24',
    extra.userAgent ?? null,
    extra.referrer ?? null,
    0,
    extra.responseSize ?? 1000,
    extra.query ?? null,
    extra.username ?? null,
    extra.captureId ?? null,
  );
  rollup.run(
    'home-gym',
    Math.floor(at / minute) * minute,
    1,
    status >= 400 && status < 500 ? 1 : 0,
    status >= 500 ? 1 : 0,
    duration,
    duration,
    duration,
  );
}
for (let i = 0; i < 120; i++) log(now - (120 - i) * minute, 'GET', '/', 200, 20 + (i % 10));
log(now - 90 * minute, 'GET', '/settings', 401, 6);
const captureId = 'mhc1-aaaa0001';
writeCapture({
  id: captureId,
  deploymentName: 'home-gym',
  timestamp: now - 10 * minute,
  method: 'GET',
  path: '/api/workouts/export',
  query: '?range=year',
  status: 502,
  durationMs: 15_000,
  failureReason: 'timeout',
  request: {
    headers: { accept: 'application/json', cookie: 'session=secret' },
    body: null,
    bodyBytes: 0,
    bodyTruncated: false,
  },
  response: null,
});
for (let i = 0; i < 4; i++) log(now - (25 - i) * minute, 'GET', '/api/workouts/export', 200, 3800);
for (let i = 0; i < 3; i++)
  log(now - (20 - i) * minute, 'GET', '/api/workouts/export', 502, 15_000);
log(now - 10 * minute, 'GET', '/api/workouts/export', 502, 15_000, {
  captureId,
  query: '?range=year',
  username: 'gabriel',
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 Version/26.1 Mobile/15E148 Safari/604.1',
  referrer: 'https://home-gym.deploy.local/history',
});
await sleep(50);

test('the summary counts requests, server errors and slow paths for the range', async () => {
  const response = await fetch(`${origin}/home-gym/requests/summary?range=1h`, { headers });
  assert.equal(response.status, 200);
  const summary = await response.json();
  assert.equal(summary.total, 68);
  assert.equal(summary.serverErrors, 4);
  assert.equal(summary.usualServerErrorRate, 0);
  assert.equal(summary.series.bucketMs, minute);
  assert.equal(summary.releases.length, 1);
  assert.equal(summary.releases[0].label, '9c3e1fa');
  assert.deepEqual(summary.firstServerError, {
    at: Math.floor((now - 20 * minute) / minute) * minute,
    release: '9c3e1fa',
  });
  assert.deepEqual(summary.slowest[0], {
    method: 'GET',
    path: '/api/workouts/export',
    filter: '/api/workouts/export',
    count: 8,
    p95: 15_000,
    noAnswer: 4,
  });
  assert.deepEqual(summary.errorPaths, [
    {
      method: 'GET',
      path: '/api/workouts/export',
      filter: '/api/workouts/export',
      count: 4,
      status: 502,
      reason: 'no answer in 15 s',
    },
  ]);
});

test('the list filters by path and kind, newest first, 50 to a page', async () => {
  const all = await (await fetch(`${origin}/home-gym/requests?range=24h`, { headers })).json();
  assert.equal(all.total, 129);
  assert.equal(all.rows.length, 50);
  assert.equal(all.rows[0].path, '/');
  const older = await (
    await fetch(`${origin}/home-gym/requests?range=24h&page=3`, { headers })
  ).json();
  assert.equal(older.rows.length, 29);
  const server = await (
    await fetch(`${origin}/home-gym/requests?range=24h&show=server&path=export`, { headers })
  ).json();
  assert.equal(server.total, 4);
  assert.equal(server.rows[0].query, '?range=year');
  const client = await (
    await fetch(`${origin}/home-gym/requests?range=24h&show=client`, { headers })
  ).json();
  assert.deepEqual(
    client.rows.map((row: any) => row.status),
    [401],
  );
  const slow = await (
    await fetch(`${origin}/home-gym/requests?range=24h&show=slow`, { headers })
  ).json();
  assert.equal(slow.total, 8);
});

test('one request shows who sent it, its release and its saved request with secrets hidden', async () => {
  const list = await (
    await fetch(`${origin}/home-gym/requests?range=1h&show=server&path=export`, { headers })
  ).json();
  const detail = await (
    await fetch(`${origin}/home-gym/requests/${list.rows[0].id}`, { headers })
  ).json();
  assert.equal(detail.request.browser, 'Safari on iPhone');
  assert.equal(detail.request.username, 'gabriel');
  assert.equal(detail.request.release, '9c3e1fa');
  assert.equal(detail.request.failure, 'timeout');
  assert.equal(detail.request.reason, 'no answer in 15 s');
  assert.equal(detail.capture.request.headers.cookie, 'hidden');
  assert.equal(detail.capture.response, null);
  assert.equal(detail.path.count, 8);
  assert.equal(detail.path.noAnswer, 4);
  assert.equal(detail.path.p95, 15_000);
  assert.equal(detail.path.median, 15_000);
});

test('another owner’s app and unknown ranges are refused', async () => {
  assert.equal((await fetch(`${origin}/private/requests/summary`, { headers })).status, 404);
  assert.equal((await fetch(`${origin}/home-gym/requests?range=2y`, { headers })).status, 400);
  assert.equal((await fetch(`${origin}/home-gym/requests/999999`, { headers })).status, 404);
});

test('browsers and error reasons read plainly', () => {
  assert.equal(
    describeBrowser('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0 Safari/537.36'),
    'Chrome on Mac',
  );
  assert.equal(describeBrowser('curl/8.7.1'), 'curl');
  assert.equal(describeBrowser(null), null);
  const capture = (body: string) =>
    ({ response: { headers: {}, body, bodyBytes: body.length, bodyTruncated: false } }) as any;
  assert.equal(
    errorReason(
      { status: 500, duration: 80 },
      capture('{"error":"duplicate key in sessions_pkey"}'),
    ),
    'duplicate key in sessions_pkey',
  );
  assert.equal(errorReason({ status: 500, duration: 80 }, capture('<html>oops</html>')), null);
  assert.equal(
    errorReason({ status: 500, duration: 80 }, capture('Error: boom\n  at x')),
    'Error: boom',
  );
});

test('paths fold their IDs so one route is one row', () => {
  assert.equal(
    normalizePath('/api/forma/assets/464cf044-d6eb-4cff-93b1-47fbb925f3c3'),
    '/api/forma/assets/:id',
  );
  assert.equal(normalizePath('/api/plans/42/edit'), '/api/plans/:id/edit');
  assert.equal(normalizePath('/blob/3f9a1c2b7d8e4f60aa11'), '/blob/:id');
  assert.equal(normalizePath('/assets/app-3f9a.js'), '/assets/app-3f9a.js');
  assert.equal(normalizePath('/api/workouts/export'), '/api/workouts/export');
  assert.equal(pathFilter('/api/plans/:id/edit'), '/api/plans/');
  assert.equal(pathFilter('/'), '/');
  assert.equal(errorReason({ status: 502, duration: 15_600 }, null), 'no answer in 15 s');
});
