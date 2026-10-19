import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSummary } from './task-review.ts';

test('phone review only reports Passed when all recorded results succeeded', () => {
  assert.equal(checkSummary([{ exitCode: 0 }], [{ status: 'succeeded' }], false), 'Passed');
  assert.equal(checkSummary([], [], false), 'Not recorded');
  assert.equal(checkSummary([{ exitCode: 0 }], [], true), 'Unavailable');
  assert.equal(checkSummary([], [{ status: 'cancelled' }], false), 'Not completed');
});

test('failed results take precedence over pending work and missing results', () => {
  assert.equal(checkSummary([{ exitCode: 1 }, { exitCode: null }], [], false), 'Failed');
  assert.equal(checkSummary([], [{ status: 'failed' }], true), 'Failed');
  assert.equal(checkSummary([{ exitCode: null }], [], false), 'In progress');
  assert.equal(checkSummary([], [{ status: 'queued' }], false), 'In progress');
});
