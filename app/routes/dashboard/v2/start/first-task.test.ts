import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowFirstTask } from './first-task.ts';
test('first-task hint never appears on later tasks, even in a fresh browser', () => {
  assert.equal(shouldShowFirstTask(false, true), true);
  assert.equal(shouldShowFirstTask(true, true), false);
  assert.equal(shouldShowFirstTask(false, false), false);
  assert.equal(shouldShowFirstTask(undefined, false), false);
  assert.equal(shouldShowFirstTask(false, undefined), false);
});
