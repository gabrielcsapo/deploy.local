import test from 'node:test';
import assert from 'node:assert/strict';
import type { LiveApp } from '../../../../../shared/v2/contracts';
import { trafficMetrics, memoryMetric } from './measurements';
const app: LiveApp = {
  appId: 'pantry',
  name: 'pantry',
  kind: 'web',
  state: 'healthy',
  summary: 'Healthy',
};
test('a confirmed quiet hour is zero traffic and has no latency to time', () => {
  assert.deepEqual(
    trafficMetrics({
      ...app,
      traffic: { state: 'measured', requests: 0, reqPerMin: 0, p95ms: null },
    } as LiveApp),
    {
      rate: { value: 0, note: 'No requests in the last hour' },
      latency: { value: '—', note: 'No requests to time' },
    },
  );
});
test('missing measurements do not become zeros; reasons stay visible', () => {
  const notMeasured = {
    ...app,
    traffic: { state: 'not-measured', reason: 'Traffic is not recorded for this app' },
  } as LiveApp;
  assert.deepEqual(trafficMetrics(notMeasured).rate, {
    value: 'Not measured',
    note: 'Traffic is not recorded for this app',
  });
  assert.equal(trafficMetrics(app).rate.value, 'Not measured');
  assert.equal(memoryMetric(app).value, 'Not measured');
  assert.equal(memoryMetric({ ...app, memoryBytes: 0 } as LiveApp).value, '0 MB');
});
test('a quiet minute after earlier requests does not claim a quiet hour', () => {
  const metrics = trafficMetrics({
    ...app,
    traffic: { state: 'measured', requests: 10, reqPerMin: 0, p95ms: null },
  } as LiveApp);
  assert.equal(metrics.rate.note, undefined);
  assert.equal(metrics.latency.note, 'No requests in the last minute to time');
});
