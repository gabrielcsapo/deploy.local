import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDuration,
  checkResult,
  checkSummary,
  descriptionWithoutChecks,
  fileTree,
  latestChecks,
  taskStatus,
} from './presentation.ts';
import type { TaskView } from './types.ts';

test('latest attempts replace failed attempts without treating piped unknown results as passed', () => {
  const checks = latestChecks([
    { id: 'old', label: 'Unit tests', status: 'failed', updatedAt: '2026-10-30T10:00:00Z' },
    { id: 'new', label: 'Unit tests', status: 'succeeded', updatedAt: '2026-10-30T10:01:00Z' },
    { id: 'format', label: 'Format', status: 'unknown', piped: true },
  ]);
  assert.equal(checks.length, 2);
  assert.equal(checkSummary(checks), '1 of 2 passed');
  assert.equal(
    checkResult(checks.find((check) => check.id === 'format')!),
    'Result unknown (output piped)',
  );
  assert.equal(checkDuration({ id: 'x', status: 'succeeded', durationMs: 3000 }), '3 s');
  assert.equal(checkDuration({ id: 'x', status: 'queued' }), undefined);
});
test('ready and passed claims require merge evidence and current successful checks', () => {
  const view = {
    task: { status: 'ready' },
    pulls: [{ status: 'open', targetBranch: 'main' }],
  } as TaskView;
  assert.equal(taskStatus(view, null, []).label, 'In review');
  assert.equal(
    taskStatus(view, { patch: '', mergeable: true }, []).detail,
    'No conflicts with main',
  );
  assert.equal(
    taskStatus(view, { patch: '', mergeable: true }, [{ id: 'x', status: 'succeeded' }]).detail,
    'Checks passed, no conflicts with main',
  );
  assert.equal(
    taskStatus(view, { patch: '', mergeable: false, conflicts: ['app.ts'] }, []).label,
    'Changes needed',
  );
  assert.equal(
    taskStatus({ ...view, pulls: [], run: { adapter: 'codex', status: 'running' } }, null, [])
      .detail,
    'On its first checkpoint, no pull request yet',
  );
});
test('description hides the generated checks and earlier runs, preserving later sections and fenced headings', () => {
  assert.equal(
    descriptionWithoutChecks(
      'Summary\n\n## Checks\n- Passed\n### Earlier runs (1)\n- Failed\n## Screenshots\n![App](app.png)',
    ),
    'Summary\n\n## Screenshots\n![App](app.png)',
  );
  const fenced = 'Example\n```md\n## Checks\n```';
  assert.equal(descriptionWithoutChecks(fenced), fenced);
});
test('changed file tree shares folders and preserves nested paths for anchors', () => {
  assert.deepEqual(fileTree(['web/server.mjs', 'web/lib/time.mjs', 'README.md']), [
    { path: 'README.md', label: 'README.md', depth: 0, folder: false },
    { path: 'web', label: 'web', depth: 0, folder: true },
    { path: 'web/lib', label: 'lib', depth: 1, folder: true },
    { path: 'web/lib/time.mjs', label: 'time.mjs', depth: 2, folder: false },
    { path: 'web/server.mjs', label: 'server.mjs', depth: 1, folder: false },
  ]);
});

test('published results only borrow logs from matching records and latest activity dates the header', async () => {
  const { checkDetails, taskUpdatedAt } = await import('./presentation.ts');
  const current = [{ id: 'test', status: 'succeeded', output: '' }];
  const checkpoints = [
    {
      id: 'cp',
      number: 1,
      at: '2026-10-30T10:00:00Z',
      checks: [
        {
          id: 'test',
          status: 'succeeded',
          output: '12 passed',
          name: 'Unit tests',
          finishedAt: '2026-10-30T10:02:00Z',
        },
      ],
    },
  ];
  assert.equal(checkDetails(current, checkpoints)[0].output, '12 passed');
  assert.equal(checkDetails([{ ...current[0], status: 'failed' }], checkpoints)[0].output, '');
  const view = {
    task: {
      id: 't',
      title: 'Time',
      status: 'ready',
      revision: 1,
      createdAt: '2026-10-30T10:00:00Z',
      updatedAt: '2026-10-30T10:00:00Z',
    },
    pulls: [],
    checkpoint: { number: 1, at: '2026-10-30T10:01:00Z' },
    events: [],
    cursor: 0,
    firstTask: false,
    checks: [],
    screenshots: [],
    releases: [],
    run: { adapter: 'codex', status: 'succeeded', updatedAt: 'invalid' },
  } as TaskView;
  assert.equal(taskUpdatedAt(view, checkDetails(current, checkpoints)), '2026-10-30T10:02:00Z');
});

test('Checks follows the latest checkpoint without attributing unpublished results to a PR', async () => {
  const { taskCheckpoints } = await import('./presentation.ts');
  const checks = [{ id: 'current', status: 'succeeded' }];
  const view = {
    pulls: [
      {
        id: 'pr',
        number: 5,
        title: 'Time',
        status: 'open',
        revision: 1,
        sourceBranch: 'task/time',
        targetBranch: 'main',
        taskIds: ['t'],
      },
    ],
    checkpoints: [
      { id: 'first', number: 1, at: '', checks: [] },
      { id: 'published', number: 2, at: '', published: true, commit: 'head', checks },
      { id: 'latest', number: 3, at: '', checks: [{ id: 'new', status: 'failed' }] },
    ],
  } as TaskView;
  const result = taskCheckpoints(view, checks, 'head');
  assert.equal(result.checkpoint?.number, 3);
  assert.equal(result.checks[0].status, 'failed');
  assert.deepEqual(result.headChecks, []);
  assert.deepEqual(
    result.earlier.map((item) => item.number),
    [2],
  );
  const published = taskCheckpoints(
    { ...view, checkpoints: view.checkpoints!.slice(0, 2) },
    checks,
    'head',
  );
  assert.deepEqual(published.headChecks, checks);
  const beforeCheckpoint = taskCheckpoints({ ...view, pulls: [], checkpoints: [], checks }, []);
  assert.equal(beforeCheckpoint.checks[0].id, 'current');
});
