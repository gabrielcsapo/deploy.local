import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'v2-traffic-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../../test-ports.ts');
const store = await import('../../store.ts');
const { getRequestsSqlite } = await import('../../requests-db.ts');
const { forgetTraffic, repeatingSenders, steady, traffic } = await import('./traffic.ts');
after(() => rmSync(root, { recursive: true, force: true }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = Date.UTC(2026, 10, 17, 15, 0);
const db = getRequestsSqlite();
const insert = db.prepare(
  `INSERT INTO request_logs (deployment_name, method, path, status, duration, timestamp, ip, user_agent, request_size, response_size)
   VALUES (?,?,?,?,?,?,?,?,?,?)`,
);
const rollup = db.prepare(
  `INSERT INTO request_logs_1m(deployment_name, bucket_ms, count, errors_5xx) VALUES(?,?,?,?)
   ON CONFLICT(deployment_name, bucket_ms) DO UPDATE SET count = count + excluded.count`,
);
function request(app: string, at: number, ip: string, path = '/', agent = 'curl/8.7.1') {
  insert.run(app, 'GET', path, 200, 5, at, ip, agent, 0, 1000);
  rollup.run(app, Math.floor(at / MINUTE) * MINUTE, 1, 0);
}

store.saveDeployment({ name: 'forma', username: 'owner' });
store.saveDeployment({ name: 'gym', username: 'owner' });
store.saveDeployment({ name: 'theirs', username: 'someone-else' });
store.saveDeployment({ name: 'moved', username: 'owner' });
db.transaction(() => {
  // A loop: six requests every minute for three hours, in two bursts like parallel scripts.
  for (let minute = 180; minute > 0; minute--)
    for (let n = 0; n < 6; n++)
      request('forma', now - minute * MINUTE + (n < 5 ? 0 : 30_000), '::ffff:10.0.0.159');
  // People: a few requests to the same page, and browsing elsewhere.
  for (let n = 0; n < 40; n++)
    request('forma', now - n * 4 * MINUTE, '10.0.0.7', '/', 'Mozilla/5.0 Safari/605');
  for (let n = 0; n < 30; n++)
    request(
      'forma',
      now - n * 5 * MINUTE,
      '10.0.0.7',
      `/books/${1000 + n}`,
      'Mozilla/5.0 Safari/605',
    );
  // Busy but uneven: 1,500 requests from one address in two bursts an hour apart.
  for (let n = 0; n < 750; n++) request('gym', now - 2 * HOUR + n * 100, '10.0.0.8', '/sync');
  for (let n = 0; n < 750; n++) request('gym', now - 20 * MINUTE + n * 100, '10.0.0.8', '/sync');
  for (let n = 0; n < 2000; n++) request('theirs', now - n * 1000, '10.0.0.9');
  // One loop whose computer changed address three hours ago: twenty hours from the first
  // address, then three from the second.
  for (let minute = 23 * 60; minute > 180; minute--)
    for (let n = 0; n < 2; n++) request('moved', now - minute * MINUTE + n * 30_000, '10.0.0.181');
  for (let minute = 180; minute > 0; minute--)
    for (let n = 0; n < 6; n++) request('moved', now - minute * MINUTE + n * 10_000, '10.0.0.159');
})();

test('steady means there in nearly every minute and about as often in each', () => {
  assert.equal(steady(new Array(60).fill(6), 60), true);
  assert.equal(steady([5, 6, 7, 6, 5, 6, 6, 7, 5, 6], 10), true);
  assert.equal(steady(new Array(30).fill(6), 60), false);
  assert.equal(steady([1, 1, 1, 60, 1, 1, 1, 1, 1, 1], 10), false);
  assert.equal(steady([], 10), false);
});

test('one address asking one route at a level pace for hours is named; bursts and people are not', () => {
  forgetTraffic();
  const forma = repeatingSenders('forma', now);
  assert.equal(forma.length, 1);
  const [sender] = forma;
  assert.equal(sender.address, '10.0.0.159');
  assert.equal(sender.agent, 'curl');
  assert.equal(sender.route, 'GET /');
  assert.equal(sender.requests, 1080);
  assert.equal(sender.perMinute, 6);
  assert.equal(Math.round(sender.routeShare * 100), 96);
  assert.equal(Math.round(sender.appShare * 100), 94);
  assert.equal(sender.since, now - 180 * MINUTE);
  assert.equal(sender.sinceOrEarlier, false);
  assert.equal(sender.sentBytes, 1_080_000);
  assert.deepEqual(repeatingSenders('gym', now), []);
});

test('a loop that changed address is still named, under the address it uses now', () => {
  forgetTraffic();
  const moved = repeatingSenders('moved', now);
  assert.deepEqual(
    moved.map((sender) => [sender.address, sender.requests, Math.round(sender.routeShare * 100)]),
    [['10.0.0.159', 1080, 100]],
  );
  // Over the day it sent under a third of the app's requests, and the warning says so.
  assert.equal(Math.round(moved[0].appShare * 100), 31);
});

test('traffic adds up every app of the owner and says who sent most', () => {
  forgetTraffic();
  const day = traffic('owner', '24h', now);
  const movedRequests = 20 * 60 * 2 + 1080;
  assert.equal(day.requests, 1080 + 70 + 1500 + movedRequests);
  assert.deepEqual(
    day.apps.map((app) => [app.name, app.requests]),
    [
      ['moved', movedRequests],
      ['gym', 1500],
      ['forma', 1150],
    ],
  );
  const forma = day.apps.find((app) => app.name === 'forma')!;
  assert.deepEqual(
    { ...forma.topSender, share: Math.round(forma.topSender!.share * 100) },
    { address: '10.0.0.159', share: 94, repeating: true },
  );
  assert.equal(day.apps.find((app) => app.name === 'gym')?.topSender?.repeating, false);
  assert.equal(day.sentBytes, (2650 + movedRequests) * 1000);
  assert.equal(day.topSender?.address, '10.0.0.181');
  assert.equal(day.repeating.length, 2);
  assert.equal(
    day.series.points.reduce((sum, point) => sum + point.perMinute * 15, 0),
    2650 + movedRequests,
  );
  // A longer range keeps the totals but reads senders for a day only.
  const week = traffic('owner', '7d', now);
  assert.equal(week.sendersWindowMs, 24 * HOUR);
  assert.equal(week.apps[0].sentBytes, null);
  const hour = traffic('owner', '1h', now);
  assert.equal(hour.sendersWindowMs, HOUR);
  assert.ok(hour.requests < day.requests);
});
