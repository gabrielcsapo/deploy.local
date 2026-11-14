import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tasksByProject } from './sidebar.ts';
import { rememberTaskGrouping, taskGrouping } from './sidebar-preference.ts';

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 10, 13, 12, 0) - minutes * 60000).toISOString();
const task = (id: string, projectId: string | null, minutes: number) => ({
  id,
  title: id,
  status: 'review',
  createdAt: at(minutes + 1000),
  updatedAt: at(minutes),
  projectId,
});

test('projects order by their latest task, tasks newest first, No project last', () => {
  const groups = tasksByProject(
    [
      task('tally-old', 'tally', 300),
      task('loose', null, 1),
      task('gym', 'home-gym', 3),
      task('deploy-new', 'deploy', 2),
      task('gone', 'removed-project', 0),
      task('deploy-old', 'deploy', 40),
      task('tally-new', 'tally', 200),
    ],
    [
      { id: 'deploy', name: 'deploy.local' },
      { id: 'home-gym', name: 'home-gym' },
      { id: 'tally', name: 'tally' },
    ],
  );
  assert.deepEqual(
    groups.map((group) => [group.project?.name ?? null, group.tasks.map((item) => item.id)]),
    [
      ['deploy.local', ['deploy-new', 'deploy-old']],
      ['home-gym', ['gym']],
      ['tally', ['tally-new', 'tally-old']],
      [null, ['gone', 'loose']],
    ],
  );
  assert.deepEqual(tasksByProject([], []), []);
});

test('the grouping choice is remembered per browser and defaults to Date', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map<string, string>();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    assert.equal(taskGrouping(), 'date');
    rememberTaskGrouping('project');
    assert.equal(taskGrouping(), 'project');
    rememberTaskGrouping('date');
    assert.equal(taskGrouping(), 'date');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(taskGrouping(), 'date');
    assert.doesNotThrow(() => rememberTaskGrouping('project'));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
