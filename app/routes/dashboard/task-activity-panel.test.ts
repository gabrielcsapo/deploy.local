import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskActivityPanel, TaskActivitySummary } from './task-activity-panel.client.tsx';
import { activitySummary, orderedJobs } from './task-activity-summary.ts';

const jobs = [
  {
    id: 'done',
    workerId: 'mac',
    status: 'succeeded',
    command: 'pnpm test',
    digest: 'abc',
    output: 'passed',
    exitCode: 0,
    createdAt: '2026-10-21T10:00:00Z',
  },
  {
    id: 'running',
    workerId: 'mac',
    status: 'running',
    command: 'swift build',
    digest: 'def',
    output: 'compiling',
    waitingReason: 'Waiting for compiler',
    createdAt: '2026-10-21T09:00:00Z',
  },
  {
    id: 'queued',
    status: 'queued',
    command: 'pnpm lint',
    digest: 'ghi',
    createdAt: '2026-10-21T11:00:00Z',
    stopRequested: true,
  },
];
const activity = [
  {
    id: 'turn',
    status: 'completed',
    summary: 'Read sources',
    items: [
      { id: 'one', title: 'Read file', status: 'completed', source: '/src/app.ts' },
      { id: 'two', title: 'Read file again', status: 'completed', source: '/src/app.ts' },
      {
        id: 'three',
        title: 'Read documentation',
        status: 'completed',
        source: 'https://example.com/docs',
      },
    ],
  },
];

test('summary appears only with jobs or sources, counts unique sources and only running jobs', () => {
  assert.equal(TaskActivitySummary({ open() {} }), null);
  assert.equal(
    TaskActivitySummary({ activity: [{ items: [{ title: 'Thinking' }] }], open() {} }),
    null,
  );
  assert.equal(
    activitySummary(jobs, activity).label,
    'Activity: 3 processes, 1 running, 2 sources',
  );
  for (const props of [{ jobs }, { activity }]) {
    const html = renderToStaticMarkup(createElement(TaskActivitySummary, { ...props, open() {} }));
    assert.match(html, /<button/);
    assert.match(html, /aria-label="Activity:/);
    assert.match(html, /ui-button-link/);
  }
});

test('summary invokes the Activity opener and shell opens the existing inspector', () => {
  let opened = false;
  const summary = TaskActivitySummary({
    jobs,
    open() {
      opened = true;
    },
  });
  summary!.props.onClick();
  assert.equal(opened, true);
  const shell = readFileSync(new URL('./projects.client.tsx', import.meta.url), 'utf8');
  assert.match(
    shell,
    /function openActivity\(\) \{\s*setReviewSection\('activity'\);\s*setInspector\(true\)/,
  );
  assert.match(shell, /open=\{openActivity\}/);
  assert.match(shell, /taskPanels\[selected\] \?\? 'changes'/);
  const conversation = shell.slice(
    shell.indexOf('id="task-conversation"'),
    shell.indexOf('className={`pw-compose-area'),
  );
  assert.doesNotMatch(
    conversation,
    /Processes across computers|<TaskSources|Questions and answers|<TaskActivityPanel/,
  );
  assert.match(shell, /role="tablist" aria-label="Inspector sections"/);
  assert.match(shell, /role="status" aria-live="polite"/);
});

test('processes sort running first then newest without mutating server records', () => {
  assert.deepEqual(
    orderedJobs(jobs).map((job) => job.id),
    ['running', 'queued', 'done'],
  );
  assert.deepEqual(
    jobs.map((job) => job.id),
    ['done', 'running', 'queued'],
  );
});

test('panel preserves process output, cancel, sources, answers and collapsed technical log in order', () => {
  const html = renderToStaticMarkup(
    createElement(TaskActivityPanel, {
      detail: {
        jobs,
        activity,
        questions: [{ id: 'q', status: 'answered', question: 'Which branch?', answer: 'main' }],
        events: [{ cursor: 1, type: 'job.updated', payload: { status: 'running' } }],
      },
      workers: [{ id: 'mac', name: 'MacBook' }],
      busy: false,
      cancel() {},
    }),
  );
  const sections = [
    'aria-label="Processes"',
    'aria-label="Sources"',
    'aria-label="Questions and answers"',
    'aria-label="Agent activity"',
    'Technical event log',
  ];
  sections.forEach((section, index) => {
    if (index) assert.ok(html.indexOf(section) > html.indexOf(sections[index - 1]!));
  });
  assert.ok(html.indexOf('swift build') < html.indexOf('pnpm lint'));
  assert.match(html, /MacBook/);
  assert.match(html, /Exit 0/);
  assert.match(html, /Checkpoint def/);
  assert.match(html, /Waiting for compiler/);
  assert.match(html, /compiling/);
  assert.match(html, /ui-button-link[^>]*>Cancel job/);
  assert.match(html, /disabled=""[^>]*>Cancellation requested/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /Which branch\?/);
  assert.match(html, /main/);
  assert.match(html, /<details class="pw-task-activity"><summary>Technical event log/);
});

test('empty activity has quiet, truthful empty states', () => {
  const html = renderToStaticMarkup(
    createElement(TaskActivityPanel, { detail: null, workers: [], busy: false, cancel() {} }),
  );
  for (const text of [
    'No processes yet.',
    'No sources yet.',
    'No answered questions yet.',
    'No agent activity yet.',
    'No events yet.',
  ])
    assert.ok(html.includes(text));
  assert.doesNotMatch(html, /Cancel job/);
});
