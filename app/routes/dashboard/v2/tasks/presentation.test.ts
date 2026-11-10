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

test('only an unchecked approved design replaces Ready to merge, with a muted clock', () => {
  const view = {
    task: { status: 'ready' },
    pulls: [{ status: 'open', targetBranch: 'main' }],
  } as TaskView;
  const diff = { patch: '', mergeable: true };
  const checks = [{ id: 'checks', status: 'succeeded' }];
  assert.equal(taskStatus(view, diff, checks).label, 'Ready to merge');
  for (const state of ['waiting', 'differs', 'matches', 'kept'] as const) {
    const withDesign = { ...view, designCheck: { state } } as TaskView;
    const summary = taskStatus(withDesign, diff, checks);
    const passed = state === 'matches' || state === 'kept';
    assert.equal(summary.label, passed ? 'Ready to merge' : 'Design not checked');
    assert.equal(summary.icon, passed ? 'check' : 'clock');
    assert.equal(summary.detail, 'Checks passed, no conflicts with main');
    assert.equal(
      taskStatus(withDesign, diff, [{ id: 'x', status: 'failed' }]).label,
      'Checks failed',
    );
    assert.equal(taskStatus(withDesign, diff, []).label, 'Not checked');
    assert.equal(
      taskStatus(withDesign, { patch: '', conflicts: ['app.ts'] }, checks).label,
      'Changes needed',
    );
    assert.equal(
      taskStatus({ ...withDesign, pulls: [{ ...view.pulls[0], status: 'merged' }] }, diff, checks)
        .label,
      'Merged',
    );
  }
});

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
  assert.deepEqual(
    [
      taskStatus(view, { patch: '', mergeable: true }, []).label,
      taskStatus(view, { patch: '', mergeable: true }, []).detail,
    ],
    ['Not checked', 'No checks on this version, no conflicts with main'],
  );
  // Failures on the head, or on a newer checkpoint when the head has none, are never ready.
  const failed = [
    { id: 'a', status: 'succeeded' },
    { id: 'b', status: 'failed' },
  ];
  assert.deepEqual(
    [
      taskStatus(view, { patch: '', mergeable: true }, failed).label,
      taskStatus(view, { patch: '', mergeable: true }, failed).detail,
    ],
    ['Checks failed', '1 of 2 passed, no conflicts with main'],
  );
  assert.equal(taskStatus(view, { patch: '', mergeable: true }, [], failed).label, 'Checks failed');
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

test('a task waiting for a computer says what it needs, who was asked and what they said', async () => {
  const { waitingForComputer } = await import('./presentation.ts');
  assert.equal(waitingForComputer(undefined), null);
  assert.equal(waitingForComputer({ tools: ['docker'], waiting: false, asked: [] }), null);
  const banner = waitingForComputer({
    tools: ['xcodebuild'],
    why: 'the approved design changes 4 iPhone screens.',
    waiting: true,
    asked: [
      { id: 'ser', name: 'SER', online: true, has: { xcodebuild: false } },
      { id: 'baz', name: 'bazzite', online: true, has: { xcodebuild: false } },
      { id: 'mbp', name: 'MacBook Pro', online: false, has: { xcodebuild: true } },
    ],
  })!;
  assert.equal(banner.title, 'Waiting for a computer with xcodebuild');
  assert.equal(
    banner.detail,
    'deploy.local asked your computers. MacBook Pro has xcodebuild and is offline; the task starts there when it is back. Nothing has run yet.',
  );
  assert.equal(
    banner.asked,
    'The task said it needs xcodebuild: the approved design changes 4 iPhone screens. · Asked 3 computers · SER no · bazzite no · MacBook Pro yes, offline',
  );
  assert.match(
    waitingForComputer({
      tools: ['docker'],
      waiting: true,
      asked: [{ id: 'a', name: 'SER', online: true, has: { docker: null } }],
    })!.asked,
    /SER not answered/,
  );
});
