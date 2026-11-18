import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveWorkByProject, taskLiveness, tasksByProject } from './sidebar.ts';
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
    rememberTaskGrouping('work');
    assert.equal(taskGrouping(), 'work');
    rememberTaskGrouping('date');
    assert.equal(taskGrouping(), 'date');
    values.set('deploy.sidebar.tasks', 'something-else');
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

test('live work: running, waiting on the owner, or ready for review; finished and stopped work is not', () => {
  const base = { title: 't', createdAt: at(10), updatedAt: at(5) };
  const run = (taskId: string, status: string, minutes = 5) => ({
    taskId,
    status,
    createdAt: at(minutes),
  });
  const cases: [Record<string, unknown>, ReturnType<typeof run>[], string | null][] = [
    [{ id: 'a', status: 'ready' }, [run('a', 'running')], 'running'],
    [{ id: 'b', status: 'ready' }, [run('b', 'queued')], 'running'],
    [{ id: 'c', status: 'preparing' }, [], 'running'],
    [{ id: 'd', status: 'waiting' }, [], 'running'],
    [{ id: 'e', status: 'ready', waitingForAnswer: true }, [run('e', 'running')], 'needs-you'],
    [{ id: 'f', status: 'ready', controlRequest: { id: 'x' } }, [], 'needs-you'],
    // Stopped work waits on its project's Work tab, not in the sidebar.
    [{ id: 'g', status: 'blocked' }, [], null],
    [{ id: 'h', status: 'review' }, [run('h', 'failed')], null],
    [{ id: 'i', status: 'review' }, [run('i', 'interrupted')], null],
    [{ id: 'p', status: 'review' }, [run('p', 'stalled')], null],
    [{ id: 'q', status: 'review' }, [run('q', 'unknown')], null],
    // A stopped task that asks a question still waits on the owner.
    [{ id: 'r', status: 'ready', waitingForAnswer: true }, [run('r', 'failed')], 'needs-you'],
    // The latest run decides: an old failure that was retried successfully is review.
    [{ id: 'j', status: 'review' }, [run('j', 'failed', 50), run('j', 'succeeded', 1)], 'review'],
    [{ id: 'k', status: 'review' }, [run('k', 'cancelled')], 'review'],
    [{ id: 'l', status: 'merged' }, [run('l', 'succeeded')], null],
    [{ id: 'm', status: 'done', waitingForAnswer: true }, [], null],
    [{ id: 'n', status: 'ready' }, [run('n', 'succeeded')], null],
    [{ id: 'o', status: 'ready' }, [], null],
  ];
  for (const [fields, runs, expected] of cases)
    assert.equal(taskLiveness({ ...base, ...fields } as never, runs), expected, String(fields.id));
});

test('Work lists only projects with live work, live tasks only, and Chats last', () => {
  const groups = liveWorkByProject(
    [
      { ...task('deploy-merged', 'deploy', 0), status: 'merged' },
      task('deploy-review', 'deploy', 4),
      { ...task('deploy-running', 'deploy', 12), status: 'ready' },
      { ...task('tally-done', 'tally', 1), status: 'done' },
      { ...task('gym-stalled', 'home-gym', 3), status: 'blocked' },
      { ...task('chat', null, 60), status: 'ready', waitingForAnswer: true },
      { ...task('chat-idle', null, 2), status: 'ready' },
    ],
    [{ taskId: 'deploy-running', status: 'running', createdAt: at(12) }],
    [
      { id: 'deploy', name: 'deploy.local' },
      { id: 'home-gym', name: 'home-gym' },
      { id: 'tally', name: 'tally' },
    ],
  );
  assert.deepEqual(
    groups.map((group) => [
      group.project?.name ?? null,
      group.tasks.map((item) => [item.task.id, item.live]),
    ]),
    [
      [
        'deploy.local',
        [
          ['deploy-review', 'review'],
          ['deploy-running', 'running'],
        ],
      ],
      [null, [['chat', 'needs-you']]],
    ],
  );
  assert.deepEqual(liveWorkByProject([], [], []), []);
});
