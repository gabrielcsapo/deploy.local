import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recordWorker,
  validateReport,
  webHealth,
  workerHealth,
  type WorkerReport,
  type WorkerState,
} from './health.ts';
const report: WorkerReport = {
  appId: 'sync',
  jobs: 100,
  failures: 0,
  intervalSec: 60,
  queueDepth: 0,
  oldestJobAgeSec: 0,
};
const start = Date.parse('2026-10-27T18:00:00Z');
function baseline(failures = 1) {
  let state: WorkerState | undefined;
  for (let i = 0; i < 2; i++)
    state = recordWorker(state, { ...report, failures }, start + i * 60_000);
  return state!;
}
test('web health requires fresh evidence and prioritizes stopped, offline, restarts, errors and memory', () => {
  const input = { appId: 'web', status: 'running', online: true };
  assert.equal(webHealth(input, start).summary, 'Health checks unavailable');
  const check = { path: '/healthz', status: 200, at: start, durationMs: 15 };
  assert.equal(webHealth({ ...input, check }, start).state, 'healthy');
  assert.equal(webHealth({ ...input, check }, start + 91_000).state, 'warning');
  assert.equal(webHealth({ ...input, check: { ...check, status: 503 } }, start).state, 'failing');
  assert.equal(webHealth({ ...input, check, online: false }, start).summary, 'Computer is offline');
  assert.equal(webHealth({ ...input, check, status: 'stopped' }, start).state, 'stopped');
  assert.equal(
    webHealth({ ...input, restarts: { count: 3, windowSec: 300 } }, start).state,
    'failing',
  );
  assert.equal(
    webHealth({ ...input, metrics: { rps: 1, errPct: 38, p95Ms: 30, memPct: 20 } }, start).summary,
    '38% of requests error in the last minute',
  );
  assert.equal(
    webHealth({ ...input, check, metrics: { rps: 1, errPct: 0, p95Ms: 30, memPct: 92 } }, start)
      .state,
    'warning',
  );
});
test('worker must exceed 10% and 5x baseline for two continuous minutes', () => {
  let state = baseline();
  for (let minute = 2; minute <= 4; minute++) {
    state = recordWorker(state, { ...report, failures: 40 }, start + minute * 60_000);
    assert.equal(
      workerHealth('sync', state, start + minute * 60_000).state,
      minute === 4 ? 'failing' : 'warning',
    );
  }
  assert.match(workerHealth('sync', state, start + 240_000).summary, /^40% of jobs error since /);
  assert.equal(state.baselineFailures / state.baselineJobs, 0.01);
  state = recordWorker(state, report, start + 300_000);
  assert.equal(workerHealth('sync', state, start + 300_000).state, 'healthy');
  for (const [base, failures] of [
    [1, 10],
    [4, 20],
  ]) {
    let atThreshold = baseline(base);
    for (let minute = 2; minute < 6; minute++)
      atThreshold = recordWorker(atThreshold, { ...report, failures }, start + minute * 60_000);
    assert.notEqual(workerHealth('sync', atThreshold, start + 300_000).state, 'failing');
  }
});
test('missing baseline, stale reports, gaps and zero-job intervals never invent healthy or sustained failure', () => {
  assert.equal(workerHealth('sync', undefined, start).summary, 'Health checks unavailable');
  let state = recordWorker(undefined, { ...report, failures: 40 }, start);
  assert.match(workerHealth('sync', state, start).summary, /learning the baseline/);
  state = baseline();
  state = recordWorker(state, { ...report, failures: 40 }, start + 120_000);
  state = recordWorker(state, { ...report, failures: 40 }, start + 240_000);
  assert.equal(workerHealth('sync', state, start + 240_000).state, 'warning');
  assert.equal(
    workerHealth('sync', state, start + 340_000).summary,
    'Worker health report is overdue',
  );
  state = recordWorker(state, { ...report, jobs: 0 }, start + 300_000);
  assert.equal(state.failingSince, undefined);
  assert.throws(() => recordWorker(state, report, start + 310_000), /overlaps/);
});
test('report validation rejects negative, fractional, impossible, and unbounded intervals', () => {
  for (const change of [
    { jobs: -1 },
    { failures: 101 },
    { intervalSec: 0 },
    { intervalSec: 61 },
    { queueDepth: 1.5 },
    { oldestJobAgeSec: Infinity },
    { appId: '' },
  ])
    assert.throws(() => validateReport({ ...report, ...change }));
  assert.deepEqual(validateReport(report), report);
});
