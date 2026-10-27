import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAttempts,
  checkRuns,
  earlierAttemptsLabel,
  earlierRunsLabel,
  noHeadChecksMessage,
} from './check-attempts.ts';

const run = (id: string, name: string, createdAt?: string) => ({ id, name, createdAt });

test('attempts collapse under the latest result per check', () => {
  const rows = [
    run('1', 'tests', '2026-10-19T10:00:00Z'),
    run('2', 'lint', '2026-10-19T10:05:00Z'),
    run('3', 'tests', '2026-10-19T11:00:00Z'),
    run('4', 'tests', '2026-10-19T10:30:00Z'),
  ];
  assert.deepEqual(
    checkAttempts(rows, (row) => row.name).map(({ key, latest, earlier }) => [
      key,
      latest.id,
      earlier.map((row) => row.id),
    ]),
    [
      // Groups keep the order their check first ran; attempts within one are newest first.
      ['tests', '3', ['4', '1']],
      ['lint', '2', []],
    ],
  );
});

test('records without a usable timestamp keep the order they were given', () => {
  const rows = [run('1', 'tests'), run('2', 'tests'), run('3', 'tests', 'not a date')];
  const [group] = checkAttempts(rows, (row) => row.name);
  assert.equal(group.latest.id, '3');
  assert.deepEqual(
    group.earlier.map((row) => row.id),
    ['2', '1'],
  );
});

test('an updated record is newer than one only created', () => {
  const [group] = checkAttempts(
    [
      { id: '1', createdAt: '2026-10-19T10:00:00Z', updatedAt: '2026-10-19T12:00:00Z' },
      { id: '2', createdAt: '2026-10-19T11:00:00Z', updatedAt: '2026-10-19T11:00:00Z' },
    ],
    () => 'check',
  );
  assert.equal(group.latest.id, '1');
});

test('earlier attempts read as a count, and none reads as nothing', () => {
  assert.equal(earlierAttemptsLabel(0), '');
  assert.equal(earlierAttemptsLabel(1), '1 earlier attempt');
  assert.equal(earlierAttemptsLabel(2), '2 earlier attempts');
  assert.equal(earlierRunsLabel(3), 'Earlier runs (3)');
  assert.equal(noHeadChecksMessage, 'No checks ran on this version');
});

test('only runs against the head count, however the attempts before them were named', () => {
  const on = (id: string, name: string, state: string, createdAt: string) => ({
    id,
    name,
    state,
    createdAt,
  });
  const rows = [
    // The same work, named differently each time the agent tried it.
    on('1', 'Verify final server and web queue flows', 'old', '2026-10-19T10:00:00Z'),
    on('2', 'Browser-test queued runs', 'old', '2026-10-19T10:30:00Z'),
    on('3', 'Browser-test queued runs', 'head', '2026-10-19T11:00:00Z'),
    on('4', 'Smoke-test the deployed app', 'head', '2026-10-19T11:30:00Z'),
    on('5', 'Browser-test queued runs', 'head', '2026-10-19T12:00:00Z'),
  ];
  const runs = checkRuns(
    rows,
    (row) => row.name,
    (row) => row.state === 'head',
  );
  assert.deepEqual(
    runs.current.map(({ key, latest, earlier }) => [key, latest.id, earlier.map((row) => row.id)]),
    [
      ['Browser-test queued runs', '5', ['3']],
      ['Smoke-test the deployed app', '4', []],
    ],
  );
  // Everything from before the last edit stays available, newest first, and counts for nothing.
  assert.deepEqual(
    runs.earlier.map((row) => row.id),
    ['2', '1'],
  );
  const stale = checkRuns(
    rows,
    (row) => row.name,
    () => false,
  );
  assert.deepEqual(stale.current, []);
  assert.deepEqual(
    stale.earlier.map((row) => row.id),
    ['5', '4', '3', '2', '1'],
  );
  assert.deepEqual(
    checkRuns(
      [],
      (row: { name: string }) => row.name,
      () => true,
    ),
    { current: [], earlier: [] },
  );
});
