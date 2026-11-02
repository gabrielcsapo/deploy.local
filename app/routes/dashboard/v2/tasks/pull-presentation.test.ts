import test from 'node:test';
import assert from 'node:assert/strict';
import { pullElapsed, pullHref, pullMeta } from './pull-presentation.ts';
import type { TaskPull } from './types.ts';
const pull: TaskPull = {
  id: 'pull-16',
  number: 16,
  title: 'Run checks',
  status: 'merged',
  revision: 1,
  sourceBranch: 'gabriel/checks',
  targetBranch: 'main',
  taskIds: [],
};
test('every PR links to its task or read-only page regardless of state', () => {
  for (const status of ['open', 'closed', 'merged']) {
    assert.equal(
      pullHref('deploy.local', { ...pull, status }),
      '/dashboard/projects/deploy%2Elocal/pulls/pull-16',
    );
    assert.equal(
      pullHref('deploy.local', { ...pull, status, taskIds: ['task-1'] }),
      '/dashboard/tasks/task-1',
    );
  }
});
test('pull metadata names known agents and merge actors without inventing missing evidence', () => {
  assert.equal(pullMeta(pull), '#16 · from gabriel/checks');
  assert.equal(
    pullMeta({
      ...pull,
      taskIds: ['task-1'],
      taskAuthor: 'Scout',
      mergedBy: 'Gabriel',
      release: { id: 'release-id', commit: '9b20d4e' },
    }),
    '#16 · task by Scout · merged by Gabriel · released 9b20d4e',
  );
  assert.equal(pullMeta({ ...pull, taskIds: ['task-1'] }), '#16 · task');
  assert.equal(pullElapsed('2026-11-01T12:00:00Z', Date.parse('2026-11-02T12:00:00Z')), '1d');
});
