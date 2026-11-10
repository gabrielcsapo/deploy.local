import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUnauthorizedError } from './auth-errors.ts';

test('matches the session errors and nothing else', () => {
  assert.equal(isUnauthorizedError(new Error('Unauthorized')), true);
  assert.equal(isUnauthorizedError(new Error('unauthorized: token expired')), true);
  assert.equal(isUnauthorizedError(new Error('Server action failed: 500')), false);
  assert.equal(isUnauthorizedError('Unauthorized'), false);
});
