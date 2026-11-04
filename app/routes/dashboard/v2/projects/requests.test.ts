import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chartTicks,
  errorRateLine,
  errorsLine,
  formatBytes,
  formatDuration,
  formatRate,
  formatRowTime,
  pathLine,
  requestsHref,
  savedText,
  type RequestSummary,
} from './requests.ts';

const now = new Date(2026, 10, 4, 14, 31, 7).getTime();
const summary = (patch: Partial<RequestSummary>) =>
  ({ range: '24h', serverErrorRate: 0, usualServerErrorRate: null, ...patch }) as RequestSummary;

test('durations, sizes and rates read as the board writes them', () => {
  assert.equal(formatDuration(24), '24 ms');
  assert.equal(formatDuration(3800), '3.8 s');
  assert.equal(formatDuration(15_000), '15 s');
  assert.equal(formatDuration(15_000, true), '15.0 s');
  assert.equal(formatBytes(312), '312 B');
  assert.equal(formatBytes(84 * 1024 * 1024), '84 MB');
  assert.equal(formatBytes(1.2 * 1024 ** 3), '1.2 GB');
  assert.equal(formatRate(0.004), '0.4%');
  assert.equal(formatRate(0.0004), 'under 0.1%');
  assert.equal(formatRate(0), '0%');
  assert.equal(
    errorRateLine(summary({ serverErrorRate: 0.004, usualServerErrorRate: 0.001 })),
    '0.4% · usually 0.1%',
  );
});

test('the chart line names the release that started the errors', () => {
  const at = new Date(2026, 10, 4, 13, 58).getTime();
  assert.equal(
    errorsLine(summary({ firstServerError: { at, release: '9c3e1fa' } }), now),
    'Server errors start at 1:58 PM, the 9c3e1fa release.',
  );
  assert.equal(
    errorsLine(summary({ firstServerError: { at } }), now),
    'First server error at 1:58 PM.',
  );
  assert.equal(
    errorsLine(summary({ firstServerError: null }), now),
    'No server errors in 24 hours.',
  );
  assert.deepEqual(chartTicks(now - 86_400_000, now, '24h', now), [
    '2 PM yesterday',
    '8 PM',
    '2 AM',
    '8 AM',
    'Now',
  ]);
  assert.equal(formatRowTime(now, now), '2:31:07 PM');
  assert.equal(formatRowTime(now - 86_400_000, now), 'Yesterday, 2:31:07 PM');
});

test('saved requests print as headers then body, and links keep only what differs', () => {
  assert.equal(
    savedText('GET /export', {
      headers: { accept: 'application/json', cookie: 'hidden' },
      body: null,
      bodyBytes: 0,
      bodyTruncated: false,
    }),
    'GET /export\naccept: application/json\ncookie: hidden\n\nNo body',
  );
  assert.equal(
    pathLine({ count: 212, serverErrors: 41, noAnswer: 41, p95: 15_000, median: 3800 }),
    '212 requests · 41 got no answer · p95 15 s, median 3.8 s',
  );
  assert.equal(requestsHref('/r', { range: '24h', show: 'all', page: 1 }), '/r');
  assert.equal(
    requestsHref('/r', { range: '7d', path: '/api/x', show: 'server', page: 2 }),
    '/r?range=7d&path=%2Fapi%2Fx&show=server&page=2',
  );
});
