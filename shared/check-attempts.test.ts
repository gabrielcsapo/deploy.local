import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAttempts, earlierAttemptsLabel } from './check-attempts.ts';

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
});
