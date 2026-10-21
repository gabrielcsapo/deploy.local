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

test('a fixed retry no longer fails Checks, while another computer and local failures still count', () => {
  const jobs = [
    { id: 'a', command: 'npm test', workerId: 'mac', status: 'failed', createdAt: '1' },
    { id: 'b', command: 'npm test', workerId: 'mac', status: 'succeeded', createdAt: '2' },
  ];
  assert.equal(checkSummary([], jobs, false), 'Passed');
  assert.equal(checkSummary([{ exitCode: 1 }], jobs, false), 'Failed');
  assert.equal(checkSummary([], [...jobs, { ...jobs[0]!, workerId: 'linux' }], false), 'Failed');
  assert.equal(
    checkSummary([], [...jobs, { ...jobs[1]!, status: 'queued', createdAt: '3' }], false),
    'In progress',
  );
});
