import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTitle } from './task-title.ts';
test('titles use the first line and shorten at complete words without dangling numbers', () => {
  assert.equal(taskTitle('  A short title\nDetails'), 'A short title');
  assert.equal(
    taskTitle('Show elapsed time as HH:MM:SS in 24 hours', 35),
    'Show elapsed time as HH:MM:SS in…',
  );
  assert.equal(taskTitle('A task with 24 more things', 16), 'A task with…');
  assert.equal(taskTitle('Supercalifragilistic', 8), '…');
  assert.equal(taskTitle('hello world', 11), 'hello world');
  assert.equal(taskTitle('hello world again', 12), 'hello world…');
});
