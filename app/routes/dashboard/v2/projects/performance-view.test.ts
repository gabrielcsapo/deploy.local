import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PerformanceView } from './performance.client.tsx';
import type { PerformanceData, PerformanceError } from './performance.ts';

const summary = {
  requests: 0,
  p50: null,
  p95: null,
  errorRate: 0,
  errors4xx: 0,
  errors5xx: 0,
  phases: {},
};
const empty: PerformanceData = {
  range: '24h',
  from: 1000,
  to: 100000,
  hasRouteData: false,
  summary: { ...summary, previous: summary },
  routes: [],
  pageExperience: [],
  errors: [],
  releases: [],
};
const phases = {
  match: { p50: 0.1, p95: 0.2 },
  rsc: { p50: 18, p95: 28 },
  ssr: { p50: 9, p95: 14 },
  stream: { p50: 7, p95: 45.8 },
};
const error: PerformanceError = {
  fingerprint: 'fingerprint',
  count: 150,
  firstSeen: 0,
  lastSeen: 99999,
  route: '/watch/:id',
  where: 'ssr',
  build: 'abc',
  name: 'Error',
  message: 'Media source did not answer',
  stack: 'at WatchPage',
};
const render = (patch: Partial<Parameters<typeof PerformanceView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(PerformanceView, {
      app: 'photos',
      base: '/p/performance',
      range: '24h',
      error: '',
      refresh() {},
      onRange() {},
      ...patch,
    }),
  );
test('loading and failed reads never look like successful empty data; retry is available', () => {
  const pending = render();
  assert.match(pending, /Loading performance/);
  assert.doesNotMatch(pending, /Nothing to measure yet|0 requests|30 days/);
  const failed = render({ error: 'database read failed' });
  assert.match(failed, /Performance is unavailable/);
  assert.match(failed, />Retry</);
  assert.doesNotMatch(failed, /Loading performance|Nothing to measure yet|database read failed/);
  const cached = render({ data: empty, error: 'offline' });
  assert.match(cached, /Performance is unavailable/);
  assert.match(cached, /Nothing to measure yet/);
});
test('successful empty and edge-only states use the board copy without app totals', () => {
  const noData = render({ data: empty, range: '1h' });
  assert.match(noData, /Nothing to measure yet/);
  assert.match(noData, /Show 24 hours/);
  assert.doesNotMatch(render({ data: empty, range: '7d' }), /Choose a longer range|Show 24 hours/);
  const totals = render({ data: { ...empty, summary: { ...empty.summary, requests: 200 } } });
  assert.match(totals, /Request totals stay in Requests/);
  assert.doesNotMatch(totals, /200 requests|Nothing to measure yet/);
});
test('measured phases render one shared scale with truthful accessible labels and no invented browser timings', () => {
  const data: PerformanceData = {
    ...empty,
    hasRouteData: true,
    routes: [88, 160].map((p95, i) => ({
      ...summary,
      route: `/route/${i}`,
      p95,
      p50: 34,
      requests: 2,
      phases,
      slowestPhase: null,
    })),
  };
  const html = render({ data });
  assert.equal((html.match(/data-waterfall="compact"/g) ?? []).length, 2);
  assert.equal((html.match(/scale 0 to 200 ms/g) ?? []).length, 2);
  assert.match(html, /Route match: 0.1 ms/);
  assert.match(html, /On the server/);
  assert.doesNotMatch(html, /In the browser|Slowest requests|Interactive/);
  const legacy = render({ data: { ...data, routes: [{ ...data.routes[0], phases: {} }] } });
  assert.match(legacy, /p95 88 ms/);
  assert.doesNotMatch(legacy, /data-waterfall|On the server/);
});
test('error detail retains latest message and stack without presenting lifetime counts as range counts', () => {
  const data = { ...empty, errors: [error] };
  const html = render({ data, errorId: error.fingerprint });
  assert.match(html, /This error/);
  assert.match(html, /Back to performance/);
  assert.match(html, /Latest stack/);
  assert.match(html, /at WatchPage/);
  assert.doesNotMatch(html, /Occurrences|Count over time|Seen in releases|150/);
  const recent = render({
    data: { ...data, errors: [{ ...error, firstSeen: 2000 }] },
    errorId: error.fingerprint,
  });
  assert.match(recent, /Occurrences/);
  assert.match(recent, /150/);
});
test('missing browser metrics and prefetch visits are not called Good or zero percent', () => {
  const data: PerformanceData = {
    ...empty,
    pageExperience: [
      {
        route: '/',
        lcp: null,
        inp: null,
        cls: null,
        ttfb: null,
        fcp: null,
        navigation: { p50: null, p95: null },
        prefetch: { hit: 0, inflight: 0, miss: 0 },
      },
    ],
  };
  const html = render({ data });
  assert.match(html, /Page experience/);
  assert.match(html, /Not measured/);
  assert.match(html, /Browser did not report/);
  assert.doesNotMatch(html, /Unavailable/);
  assert.doesNotMatch(html, />Good<|Already prefetched|0%|Nothing to measure yet/);
});
test('a current release with no comparison is not declared steady', () => {
  const html = render({
    data: { ...empty, errors: [error], releases: [{ id: 'current', at: 99999, comparison: null }] },
  });
  assert.match(html, /current/);
  assert.doesNotMatch(html, /Steady|0%|p95 0/);
});
