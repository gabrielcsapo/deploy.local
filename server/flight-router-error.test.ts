import assert from 'node:assert/strict';
import test from 'node:test';
import { flightLogLine, logFlightRouterError } from './flight-router-error.ts';

test('missing resources are quiet while unexpected errors keep their stack', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  logFlightRouterError(Object.assign(new Error('Not found'), { status: 404 }));
  assert.equal(log.mock.callCount(), 0);
  for (const error of [new Error('Not found'), new Error('broken')]) {
    logFlightRouterError(error);
    assert.equal(log.mock.calls.at(-1)!.arguments[1], error);
    assert.ok(error.stack);
  }
});

test('a slow action names where its time went on one line', () => {
  const base = { pathname: '/dashboard/live', status: 200, timings: [], timestamp: '' };
  assert.equal(
    flightLogLine({ ...base, type: 'SSR', totalMs: 612.4 }),
    '[flight] SSR /dashboard/live 200 612ms',
  );
  assert.equal(
    flightLogLine({
      ...base,
      type: 'ACTION',
      totalMs: 731.6,
      action: {
        id: 'app/actions/deployments#fetchDeployments',
        worker: true,
        queueMs: 402.2,
        decodeMs: 0.4,
        executeMs: 311.9,
        serializeMs: 2.1,
        totalMs: 720,
      },
    }),
    '[flight] ACTION /dashboard/live 200 732ms action=app/actions/deployments#fetchDeployments worker queue=402ms decode=0ms execute=312ms serialize=2ms router=720ms',
  );
});
