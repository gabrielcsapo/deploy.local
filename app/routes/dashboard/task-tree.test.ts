import assert from 'node:assert/strict';
import test from 'node:test';
import { taskAge, taskStatus, taskTree } from './task-tree.ts';

const projects = [
  { id: 'empty-z', name: 'Zulu' },
  { id: 'web', name: 'Web' },
  { id: 'empty-a', name: 'Alpha' },
  { id: 'api', name: 'API' },
];
const tasks = [
  { id: 'old', title: 'Fix layout', projectId: 'web', updatedAt: '2026-10-01T00:00:00Z' },
  { id: 'new', title: 'Search input', projectId: 'web', updatedAt: '2026-10-15T00:00:00Z' },
  { id: 'api-task', title: 'Fix request', projectId: 'api', updatedAt: '2026-10-18T00:00:00Z' },
  { id: 'loose', title: 'Investigate', projectId: null, updatedAt: '2026-10-19T00:00:00Z' },
];

test('groups every project and orders by newest activity, with empty projects alphabetical and No project last', () => {
  const result = taskTree(projects, tasks);
  assert.deepEqual(
    result.map((group) => group.id),
    ['api', 'web', 'empty-a', 'empty-z', ''],
  );
  assert.deepEqual(
    result.map((group) => group.count),
    [1, 2, 0, 0, 1],
  );
  assert.deepEqual(
    result[1].tasks.map((task) => task.id),
    ['new', 'old'],
  );
  assert.equal(result.at(-1)?.name, 'No project');
  assert.deepEqual(
    tasks.map((task) => task.id),
    ['old', 'new', 'api-task', 'loose'],
  );
  assert.deepEqual(
    projects.map((project) => project.id),
    ['empty-z', 'web', 'empty-a', 'api'],
  );
});

test('search matches task titles and project names case-insensitively without changing project order', () => {
  const titleMatches = taskTree(projects, tasks, '  FIX  ');
  assert.deepEqual(
    titleMatches.map((group) => group.id),
    ['api', 'web'],
  );
  assert.deepEqual(
    titleMatches[1].tasks.map((task) => task.id),
    ['old'],
  );
  assert.equal(titleMatches[1].count, 2);
  assert.deepEqual(
    taskTree(projects, tasks, 'wEb')[0].tasks.map((task) => task.id),
    ['new', 'old'],
  );
  assert.deepEqual(
    taskTree(projects, tasks, 'ALPHA').map((group) => group.id),
    ['empty-a'],
  );
  assert.deepEqual(
    taskTree(projects, tasks, 'no PROJECT').map((group) => group.id),
    [''],
  );
  assert.deepEqual(taskTree(projects, tasks, 'missing'), []);
  assert.deepEqual(taskTree(projects, tasks, ''), taskTree(projects, tasks, '   '));
});

test('keeps unassigned and orphaned tasks visible, without inventing an empty No project group', () => {
  assert.deepEqual(taskTree([], []), []);
  assert.equal(taskTree(projects, []).length, projects.length);
  const loose = taskTree([], [...tasks, { id: 'orphan', title: 'Recover', projectId: 'removed' }]);
  assert.equal(loose.length, 1);
  assert.equal(loose[0].name, 'No project');
  assert.equal(loose[0].count, 5);
  assert.equal(loose[0].tasks.at(-1)?.id, 'orphan');
});

test('compact ages include full accessible phrases and honest missing timestamps', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  for (const [minutes, compact, label] of [
    [0, 'now', 'Updated just now'],
    [12, '12m', 'Updated 12 minutes ago'],
    [180, '3h', 'Updated 3 hours ago'],
    [2880, '2d', 'Updated 2 days ago'],
    [50400, '5w', 'Updated 5 weeks ago'],
    [60, '1h', 'Updated 1 hour ago'],
  ] as const) {
    assert.deepEqual(taskAge(new Date(now - minutes * 60000).toISOString(), now), {
      compact,
      label,
    });
  }
  assert.equal(taskAge('invalid', now).label, 'Update time unavailable');
  assert.equal(taskAge(new Date(now + 60000).toISOString(), now).compact, 'now');
});

test('task tones distinguish attention, execution, failure, completion and inactivity', () => {
  assert.equal(taskStatus('running', true).tone, 'attention');
  assert.equal(taskStatus('review').tone, 'attention');
  assert.equal(taskStatus('running').tone, 'active');
  assert.equal(taskStatus('failed').tone, 'failed');
  assert.equal(taskStatus('succeeded').tone, 'healthy');
  assert.equal(taskStatus('stopped').tone, 'inactive');
});

test('open pull summaries have an active review label and merged tasks stay merged', () => {
  assert.deepEqual(taskStatus('review', false, { number: 5, status: 'open' }), {
    tone: 'active',
    label: 'In review · PR #5',
  });
  assert.equal(taskStatus('merged', false, { number: 5, status: 'merged' }).label, 'Merged');
  assert.equal(
    taskStatus('review', false, { number: 5, status: 'closed' }).label,
    'Ready to review',
  );
});

test('a task waiting on an agent control request needs your approval first', () => {
  assert.deepEqual(taskStatus('running', false, { number: 5, status: 'open' }, true), {
    tone: 'attention',
    label: 'Needs your approval',
  });
  assert.equal(taskStatus('running', false, null, false).label, 'Working');
});
