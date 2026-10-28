import test from 'node:test';
import assert from 'node:assert/strict';
import { latestError } from './presentation.ts';
test('latest error keeps its stack, drops old errors and does not invent an error', () => {
  assert.equal(
    latestError('Error: old\nready\nError: missing column\n  at sync.ts:12\n'),
    'Error: missing column\n  at sync.ts:12',
  );
  assert.equal(latestError('ready\ncompleted 32 jobs'), '');
});
