import assert from 'node:assert/strict';
import test from 'node:test';
import { logFlightRouterError } from './flight-router-error.ts';

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
