import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobRow, TaskActivityPanel, TaskActivitySummary } from './task-activity-panel.client.tsx';
import {
  activitySections,
  activitySources,
  activitySummary,
  checkIdentity,
  commandTitle,
  jobDuration,
  latestChecks,
  orderedJobs,
} from './task-activity-summary.ts';
const job = (id: string, status: string, extra = {}) => ({
  id,
  status,
  workerId: 'mac',
  command: 'swift test',
  digest: 'abc1234',
  output: '',
  createdAt: `2026-10-21T10:00:0${id}Z`,
  ...extra,
});
test('identity uses computer plus label, otherwise normalized command, without conflating labels and commands', () => {
  assert.equal(
    checkIdentity(job('1', 'failed', { command: '  swift   test\n' })),
    checkIdentity(job('2', 'succeeded')),
  );
  assert.equal(
    checkIdentity(job('1', 'failed', { name: 'Smoke', command: 'a' })),
    checkIdentity(job('2', 'succeeded', { name: 'Smoke', command: 'b' })),
  );
  assert.notEqual(
    checkIdentity(job('1', 'failed', { name: 'swift test' })),
    checkIdentity(job('2', 'succeeded')),
  );
  assert.notEqual(
    checkIdentity(job('1', 'failed', { workerId: 'linux' })),
    checkIdentity(job('2', 'succeeded')),
  );
});
test('latest result wins and retains earlier failures without mutating attempts', () => {
  const jobs = [job('1', 'failed'), job('3', 'succeeded'), job('2', 'failed')];
  const checks = latestChecks(jobs);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.latest.id, '3');
  assert.deepEqual(
    checks[0]!.earlier.map((j) => j.id),
    ['2', '1'],
  );
  assert.equal(checks[0]!.failures, 2);
  assert.deepEqual(
    jobs.map((j) => j.id),
    ['1', '3', '2'],
  );
  assert.equal(activitySummary(jobs).failing, 0);
});
test('outcome-first summaries count queued as active and pluralize real jobs and computers', () => {
  assert.equal(
    activitySummary([job('1', 'failed'), job('2', 'queued', { workerId: 'ser' })]).text,
    '1 failing · 1 running · 2 jobs on 2 computers',
  );
  assert.equal(activitySummary([job('1', 'succeeded')]).text, '1 job on 1 computer');
  assert.equal(activitySummary([]).visible, false);
  assert.equal(TaskActivitySummary({ open() {} }), null);
});
test('Now includes queued and running newest first, attention excludes superseded failures, turns are chronological inside newest turn first', () => {
  const jobs = [
    job('1', 'failed', { runId: 'a' }),
    job('2', 'succeeded', { runId: 'b' }),
    job('3', 'queued', { command: 'lint', runId: 'b', waitingReason: 'No macOS computer online' }),
    job('4', 'running', { command: 'build', runId: 'b' }),
    job('5', 'succeeded', { command: 'other' }),
  ];
  assert.deepEqual(
    orderedJobs(jobs).map((j) => j.id),
    ['4', '3', '5', '2', '1'],
  );
  const sections = activitySections(
    latestChecks(jobs).map((c) => c.latest),
    [
      { id: 'a', createdAt: '1' },
      { id: 'b', createdAt: '2' },
    ],
    [{ role: 'user', runId: 'b', content: 'Add streaks\nMore detail' }],
  );
  assert.deepEqual(
    sections.now.map((j) => j.id),
    ['4', '3'],
  );
  assert.deepEqual(
    sections.attention.map((j) => j.id),
    ['3'],
  );
  assert.equal(sections.turns[0]!.title, 'Turn 2 · Add streaks');
  assert.deepEqual(
    sections.turns[0]!.jobs.map((j) => j.id),
    ['2', '3', '4'],
  );
  assert.equal(sections.turns.at(-1)!.title, 'Other');
});
test('real command summaries preserve the significant programs and host', () => {
  const cases = [
    [
      'curl --fail --show-error --silent https://habit-harbor.local/api/habits | grep streak',
      'curl → habit-harbor.local',
    ],
    [
      'profile=$(mktemp -d /tmp/firefox.XXXXXX); firefox --headless --profile "$profile" --screenshot /tmp/shot.png https://tally.local',
      'firefox → tally.local',
    ],
    [
      "git status --short --branch && git add . && git -c user.name='deploy.local' -c user.email='deploy@local' commit -m 'Build cross-platform Habit Harbor tracker' && git push origin HEAD:task/123",
      'git commit + push',
    ],
    [
      'xcodebuild -version && swift test && swift build --product HabitHarborApp',
      'swift test + swift build',
    ],
    ['cd /tmp/app && set -e; set -u; VAR=value; npm test', 'npm test'],
  ];
  for (const [input, expected] of cases) assert.equal(commandTitle(input!), expected);
  assert.ok(commandTitle('custom ' + 'x'.repeat(100)).length <= 64);
});
test('timing tolerates historical jobs and only uses start and finish evidence', () => {
  assert.equal(jobDuration(job('1', 'succeeded')), '');
  assert.equal(
    jobDuration(
      job('1', 'succeeded', {
        startedAt: '2026-10-21T10:00:00Z',
        finishedAt: '2026-10-21T10:00:04Z',
      }),
    ),
    '4s',
  );
  assert.equal(jobDuration(job('1', 'queued'), Date.parse('2026-10-21T10:02:01Z')), 'Queued 2m 0s');
});
test('rows show retries, command, bounded log controls, useful failure, and visible Cancel without Exit 0', () => {
  const html = renderToStaticMarkup(
    createElement(JobRow, {
      job: job('3', 'succeeded', { exitCode: 0 }),
      earlier: [job('1', 'failed'), job('2', 'failed')],
      workers: [{ id: 'mac', name: 'MacBook' }],
      busy: false,
      cancel() {},
    }),
  );
  assert.match(html, /Passed after 2 failures/);
  assert.doesNotMatch(html, /Exit 0/);
  assert.match(html, /Copy command/);
  assert.match(html, /Copy output/);
  assert.match(html, /Wrap/);
  assert.match(html, /on MacBook, passed/);
  const running = renderToStaticMarkup(
    createElement(JobRow, {
      job: job('1', 'running', { output: 'Compiling\nLinking' }),
      workers: [],
      busy: false,
      cancel() {},
    }),
  );
  assert.match(running, /Linking/);
  assert.match(running, /<\/details><button[^>]*>Cancel<\/button>/);
  const failed = renderToStaticMarkup(
    createElement(JobRow, {
      job: job('1', 'failed', {
        exitCode: 128,
        output: 'fatal: not a git repository',
        runId: 'run',
      }),
      workers: [],
      busy: false,
      cancel() {},
      showConversation() {},
    }),
  );
  assert.match(failed, /Exit 128 · fatal: not a git repository/);
  assert.match(failed, /Show in conversation/);
});
test('empty sections are absent and sources discard directories', () => {
  assert.deepEqual(
    activitySources([
      {
        items: [
          { source: '.' },
          { source: 'src/' },
          { source: 'src', kind: 'directory' },
          { source: './src/app.ts' },
        ],
      },
    ]),
    ['src/app.ts'],
  );
  const html = renderToStaticMarkup(
    createElement(TaskActivityPanel, { detail: null, workers: [], busy: false, cancel() {} }),
  );
  assert.match(html, /No jobs yet/);
  assert.doesNotMatch(html, /Agent activity|Sources|Questions and answers|Raw events/);
});

test('retries that differ only in shell plumbing fold into one check, so a fixed failure is not failing', () => {
  const failed = {
    id: 'a',
    workerId: 'bazzite',
    status: 'failed',
    createdAt: '2026-10-21T10:00:00Z',
    command: `curl --fail https://habit-harbor.local/ | grep -q 'class="streak"' && curl --fail https://habit-harbor.local/api/habits | tee /tmp/a.json && cat /tmp/a.json`,
  };
  const passed = {
    id: 'b',
    workerId: 'bazzite',
    status: 'succeeded',
    createdAt: '2026-10-21T10:05:00Z',
    command: "curl --fail https://habit-harbor.local/ | grep 'streak'",
  };
  assert.equal(activitySummary([failed, passed]).failing, 0);
  assert.equal(
    commandTitle(
      `profile=$(mktemp -d .ff.XXXX); dbus-run-session -- firefox --headless --screenshot "$PWD/x.png" https://tally.local; if ! [ -f x.png ]; then exit 1; fi; base64 x.png`,
    ),
    'firefox → tally.local',
  );
  assert.equal(commandTitle('node --version && npm test'), 'npm test');
  assert.equal(
    commandTitle('for i in 1 2 3; do curl -s https://tally.local && break; sleep 2; done'),
    'curl → tally.local',
  );
});

test('expanded activity utilities have accessible names, tooltips and wrap toggle state', () => {
  const html = renderToStaticMarkup(
    createElement(JobRow, {
      job: job('1', 'failed', { runId: 'run-1', output: 'fatal: failed' }),
      workers: [{ id: 'mac', name: 'Mac' }],
      busy: false,
      cancel() {},
      showConversation() {},
    }),
  );
  for (const label of ['Copy command', 'Copy output', 'Wrap output', 'Show in conversation']) {
    assert.ok(html.includes(`aria-label="${label}" title="${label}"`));
  }
  assert.match(html, /aria-label="Wrap output" title="Wrap output" aria-pressed="true"/);
  assert.match(html, /aria-live="polite"/);
});

test('Activity header has named collapse and close controls, with close last', async () => {
  const { ActivityRail } = await import('./task-activity-rail.client.tsx');
  const html = renderToStaticMarkup(
    createElement(ActivityRail, {
      rail: { mode: 'open', width: 400, update() {}, style: {} },
      jobs: [],
    }),
  );
  assert.match(html, /aria-label="Collapse Activity" title="Collapse Activity"/);
  assert.match(html, /aria-label="Close Activity" title="Close Activity \(Esc\)"/);
  assert.ok(
    html.indexOf('aria-label="Collapse Activity"') < html.indexOf('aria-label="Close Activity"'),
  );
});
