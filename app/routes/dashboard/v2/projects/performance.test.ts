import assert from 'node:assert/strict';
import test from 'node:test';
import {
  barPosition,
  percent,
  performanceHref,
  performanceRange,
  performanceState,
  prefetchRate,
  rating,
  releaseEvidence,
  releaseVerdict,
  serverSegments,
  timing,
  waterfallScale,
  type PageExperience,
  type PerformanceData,
  type PhaseTimings,
  type ReleaseComparison,
} from './performance.ts';

const phases: PhaseTimings = {
  match: { p50: 0.1, p95: 0.2 },
  rsc: { p50: 18, p95: 28 },
  ssr: { p50: 9, p95: 14 },
  stream: { p50: 7, p95: 45.8 },
};

test('route segments are sequential p50s; p95 tails share their phase start', () => {
  const segments = serverSegments(phases);
  assert.deepEqual(
    segments.map((part) => part.start),
    [0, 0.1, 18.1, 27.1],
  );
  assert.equal(segments[3].start + segments[3].p95, 72.9);
  assert.deepEqual(barPosition(segments[3].start + segments[3].p50, 38.8, 100), {
    left: '34.1%',
    width: '38.8%',
  });
  assert.equal(barPosition(0, 0.1, 100).width, '0.1%');
});
test('one scale fits every route marker and independently offset tail', () => {
  assert.equal(
    waterfallScale([
      { p95: 88, phases },
      { p95: 43, phases },
    ]),
    100,
  );
  assert.equal(waterfallScale([{ p95: 18 }]), 20);
  assert.equal(waterfallScale([{ p95: 160 }]), 200);
  assert.equal(waterfallScale([{ p95: 18, phases }]), 100);
  assert.equal(waterfallScale([]), 1);
  assert.equal(waterfallScale([{ p95: null }]), 1);
  assert.deepEqual(barPosition(95, 20, 100), { left: '95%', width: '5%' });
});
test('missing, legacy and partial timings do not become invented zero phases', () => {
  assert.deepEqual(serverSegments(undefined), []);
  assert.deepEqual(serverSegments({ match: phases.match, render: { p50: 20, p95: 40 } }), []);
  assert.deepEqual(serverSegments({ ...phases, ssr: { p50: null, p95: null } }), []);
  assert.deepEqual(serverSegments({ ...phases, stream: { p50: 10, p95: 2 } }), []);
  assert.equal(timing(null), 'Unavailable');
  assert.equal(timing(0), '0 ms');
  assert.equal(timing(0.1), '0.1 ms');
  assert.equal(timing(0.01), 'under 0.1 ms');
  assert.equal(timing(4945), '4.945 s');
  assert.equal(percent(0.0009), '0.09%');
  assert.equal(percent(0.000001), 'under 0.01%');
  assert.equal(percent(0), '0%');
});
test('only supported ranges reach the API and navigation preserves an error fingerprint', () => {
  assert.equal(performanceRange('30d'), '24h');
  assert.equal(performanceRange(null), '24h');
  assert.equal(performanceRange('7d'), '7d');
  assert.equal(performanceHref('/p/performance', '24h'), '/p/performance');
  assert.equal(
    performanceHref('/p/performance', '1h', 'a/b'),
    '/p/performance?range=1h&error=a%2Fb',
  );
});
test('ratings use inclusive approved boundaries and unknown is never Good', () => {
  for (const [metric, good, needsWork] of [
    ['lcp', 2500, 4000],
    ['inp', 200, 500],
    ['cls', 0.1, 0.25],
    ['ttfb', 800, 1800],
  ] as const) {
    assert.equal(rating(metric, good), 'Good');
    assert.equal(rating(metric, needsWork), 'Needs work');
    assert.equal(rating(metric, needsWork + 0.01), 'Poor');
    assert.equal(rating(metric, null), null);
  }
  assert.equal(
    prefetchRate({ prefetch: { hit: 0, inflight: 0, miss: 0 } } as PageExperience),
    null,
  );
  assert.equal(prefetchRate({ prefetch: { hit: 8, inflight: 1, miss: 1 } } as PageExperience), 0.8);
});
test('browser-only activity is not empty; edge-only activity uses the totals state', () => {
  const empty = {
    summary: { requests: 0 },
    hasRouteData: false,
    routes: [],
    pageExperience: [],
    errors: [],
    releases: [],
  } as unknown as PerformanceData;
  assert.equal(performanceState(empty), 'empty');
  assert.equal(
    performanceState({ ...empty, releases: [{ id: 'new', at: 1000, comparison: null }] }),
    'empty',
  );
  assert.equal(
    performanceState({ ...empty, summary: { ...empty.summary, requests: 1 } }),
    'totals',
  );
  assert.equal(performanceState({ ...empty, pageExperience: [{} as PageExperience] }), 'ready');
});
test('unmeasured or insufficient release comparisons are never called steady', () => {
  assert.equal(releaseVerdict(null), null);
  assert.equal(releaseVerdict({ enoughTraffic: false, verdict: null } as ReleaseComparison), null);
  assert.equal(
    releaseVerdict({ enoughTraffic: true, verdict: 'slower' } as ReleaseComparison),
    'Slower',
  );
  const comparison = {
    before: { p95: 0, errorRate: 0 },
    after: { p95: 30, errorRate: 0.01 },
    verdict: 'slower',
  } as ReleaseComparison;
  assert.equal(releaseEvidence(comparison), 'p95 0 ms → 30 ms · 30 ms slower');
  assert.equal(releaseEvidence(null), '');
});

test('error range counts require the entire lifetime to fit, and seen times stay meaningful', async () => {
  const { errorOccurrences, seenAgo } = await import('./performance.ts');
  const error = {
    count: 12,
    firstSeen: 1000,
    lastSeen: 1999,
  } as import('./performance.ts').PerformanceError;
  assert.equal(errorOccurrences(error, 1000, 2000), 12);
  assert.equal(errorOccurrences(error, 1001, 2000), null);
  assert.equal(errorOccurrences(error, 1000, 1999), null);
  assert.equal(seenAgo(0, 120000), '2 min ago');
  assert.equal(seenAgo(1000, 0), 'Just now');
  assert.equal(seenAgo(0, 3600000), '1 hour ago');
});
