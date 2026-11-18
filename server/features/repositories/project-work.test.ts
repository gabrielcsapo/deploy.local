import test from 'node:test';
import assert from 'node:assert/strict';
import { stageProjectWork, type WorkInput } from './project-work.ts';

const now = Date.parse('2026-11-17T12:00:00Z');
const ago = (minutes: number) => new Date(now - minutes * 60000).toISOString();

function stage(input: Partial<WorkInput>) {
  return stageProjectWork({
    tasks: [],
    issues: [],
    pulls: [],
    runs: [],
    inbox: [],
    waitingForAnswer: new Set(),
    controlRequests: new Set(),
    agentName: (id) => ({ reviewer: 'Code reviewer' })[id ?? ''],
    personName: (username) => ({ gabriel: 'Gabriel' })[username] ?? username,
    computerName: (id) => ({ local: 'SER', bazzite: 'bazzite' })[id],
    now,
    ...input,
  });
}
const byId = (work: ReturnType<typeof stage>, id: string) =>
  [...work.rows, ...work.shipped].find((row) => row.id === id);

test('a task with its pull request and its issue is one row, numbered by the pull request', () => {
  const work = stage({
    tasks: [{ id: 't1', title: 'Self-release pipeline', status: 'review', issueId: 'i1' }],
    pulls: [{ id: 'p1', number: 18, title: 'PR title', status: 'open', taskIds: ['t1'] }],
    issues: [{ id: 'i1', number: 4, title: 'Issue title', status: 'open', taskIds: ['t1'] }],
    runs: [{ id: 'r1', taskId: 't1', status: 'running', workerId: 'local', createdAt: ago(12) }],
  });
  assert.equal(work.rows.length, 1);
  assert.deepEqual(work.rows[0], {
    id: 'task:t1',
    title: 'Self-release pipeline',
    number: 18,
    at: ago(12),
    stage: 'running',
    meta: ['On SER for 12 min', '#18'],
    link: { kind: 'task', id: 't1' },
  });
  assert.deepEqual(work.counts, { open: 1, shipped: 0 });
});

test('without a pull request the issue gives the number; a pull request links its issue too', () => {
  const work = stage({
    tasks: [{ id: 't1', title: 'A', status: 'queued' }],
    issues: [
      { id: 'i1', number: 3, title: 'A', status: 'open', taskIds: ['t1'] },
      { id: 'i2', number: 5, title: 'B', status: 'open', taskIds: [] },
    ],
    pulls: [{ id: 'p9', number: 9, title: 'B', status: 'open', taskIds: [], issueIds: ['i2'] }],
  });
  assert.deepEqual(byId(work, 'task:t1')?.meta, ['Queued', '#3']);
  assert.equal(byId(work, 'pull:p9')?.number, 9);
  assert.equal(byId(work, 'issue:i2'), undefined);
  assert.equal(work.counts.open, 2);
});

test('Needs you is only what waits on an answer; a halted task is Stopped, saying why', () => {
  const work = stage({
    tasks: [
      'ask',
      'question',
      'control',
      'failed',
      'blocked',
      'interrupted',
      'stalled',
      'lost',
    ].map((id) => ({
      id,
      title: id,
      status: id === 'blocked' ? 'blocked' : 'review',
    })),
    runs: [
      { id: 'r1', taskId: 'failed', status: 'failed', workerId: 'local', createdAt: ago(5) },
      { id: 'r2', taskId: 'interrupted', status: 'interrupted', createdAt: ago(5) },
      { id: 'r4', taskId: 'stalled', status: 'stalled', workerId: 'bazzite', createdAt: ago(5) },
      { id: 'r5', taskId: 'lost', status: 'unknown', createdAt: ago(5) },
      // Still running, but waiting on an answer.
      { id: 'r3', taskId: 'question', status: 'running', createdAt: ago(5) },
    ],
    inbox: [
      { kind: 'other', state: 'waiting', taskId: 'ask', title: 'Approve design?' },
      { kind: 'question', state: 'answered', taskId: 'control' },
    ],
    waitingForAnswer: new Set(['question']),
    controlRequests: new Set(['control']),
  });
  const meta = Object.fromEntries(work.rows.map((row) => [row.title, [row.stage, row.meta[0]]]));
  assert.deepEqual(meta, {
    ask: ['needs-you', 'Approve design?'],
    question: ['needs-you', 'Asked you a question'],
    control: ['needs-you', 'Wants your go-ahead'],
    failed: ['stopped', 'Failed on SER'],
    blocked: ['stopped', 'Blocked'],
    interrupted: ['stopped', 'Interrupted'],
    stalled: ['stopped', 'Stalled on bazzite'],
    lost: ['stopped', 'Stalled'],
  });
  // Stopped comes last and counts as open.
  assert.deepEqual(
    work.rows.slice(-5).map((row) => row.stage),
    Array(5).fill('stopped'),
  );
  assert.equal(work.counts.open, 8);
});

test('a pull request whose checks failed with nothing working on it is Stopped', () => {
  const work = stage({
    tasks: [
      { id: 'red', title: 'Keep the sidebar quiet until it has content', status: 'review' },
      { id: 'fixing', title: 'Fixing it', status: 'review' },
      { id: 'asked', title: 'Asked', status: 'review' },
    ],
    pulls: [
      { id: 'p25', number: 25, status: 'open', taskIds: ['red'] },
      { id: 'p26', number: 26, status: 'open', taskIds: ['fixing'] },
      { id: 'p27', number: 27, status: 'open', taskIds: ['asked'] },
    ],
    runs: [{ id: 'r', taskId: 'fixing', status: 'running', workerId: 'local', createdAt: ago(1) }],
    checks: new Map(
      ['p25', 'p26', 'p27'].map((id) => [id, { passed: 1, failed: 1, total: 2 }] as const),
    ),
    waitingForAnswer: new Set(['asked']),
  });
  assert.deepEqual(
    work.rows.map((row) => [row.stage, row.title, row.meta.join(' · ')]),
    [
      ['needs-you', 'Asked', 'Asked you a question · #27'],
      ['running', 'Fixing it', 'On SER for 1 min · #26'],
      ['stopped', 'Keep the sidebar quiet until it has content', 'Checks failed · #25'],
    ],
  );
});

test('an open pull request nothing is working on waits for you to merge it', () => {
  const work = stage({
    tasks: [
      { id: 'done', title: 'Cancellation test flakes', status: 'review' },
      { id: 'busy', title: 'Still going', status: 'review' },
      { id: 'merging', title: 'On its way', status: 'review' },
    ],
    pulls: [
      { id: 'p18', number: 18, status: 'open', taskIds: ['done'] },
      { id: 'p19', number: 19, status: 'open', taskIds: ['busy'] },
      { id: 'p20', number: 20, status: 'open', taskIds: ['merging'] },
      { id: 'p21', number: 21, status: 'open', taskIds: [], title: 'Merge main from the remote' },
    ],
    runs: [{ id: 'r', taskId: 'busy', status: 'running', workerId: 'bazzite', createdAt: ago(3) }],
    checks: new Map([
      ['p18', { passed: 2, failed: 0, total: 2 }],
      ['p21', { passed: 0, failed: 1, total: 1 }],
    ]),
    merging: new Set(['p20']),
  });
  assert.deepEqual(byId(work, 'task:done')?.meta, ['Ready to merge', '#18', 'checks passed']);
  assert.equal(byId(work, 'task:done')?.stage, 'needs-you');
  assert.deepEqual(byId(work, 'task:busy')?.meta, ['On bazzite for 3 min', '#19']);
  assert.equal(byId(work, 'task:busy')?.stage, 'running');
  assert.deepEqual(byId(work, 'task:merging')?.meta, ['Merging', '#20']);
  assert.equal(byId(work, 'task:merging')?.stage, 'running');
  // A pull request with no task is its own row.
  assert.deepEqual(byId(work, 'pull:p21'), {
    id: 'pull:p21',
    title: 'Merge main from the remote',
    number: 21,
    link: { kind: 'pull', id: 'p21' },
    stage: 'stopped',
    meta: ['Checks failed', '#21'],
    at: '',
  });
});

test('Up next is what a person wrote; Found by agents waits until the owner accepts it', () => {
  const work = stage({
    tasks: [{ id: 'review', title: 'Review PR 15', status: 'review', agentId: 'reviewer' }],
    pulls: [{ id: 'p15', number: 15, status: 'open', taskIds: ['review'] }],
    issues: [
      {
        id: 'mine',
        number: 2,
        title: 'Launch the bazzite app one way, not two',
        status: 'open',
        author: 'gabriel',
        taskIds: [],
        createdAt: ago(3 * 1440),
      },
      {
        id: 'found',
        number: 16,
        title: 'Any non-test command marks checks as earlier',
        status: 'open',
        author: 'gabriel',
        // The task that found it is linked, but it is not work on it.
        taskIds: ['review'],
        foundBy: { taskId: 'review', agentId: 'reviewer' },
        createdAt: ago(3 * 1440),
      },
      {
        id: 'orphan',
        number: 17,
        title: 'Mac Clone popover needs a check on a locked screen',
        status: 'open',
        taskIds: ['gone'],
        foundBy: { taskId: 'gone' },
        createdAt: ago(5 * 1440),
      },
      {
        id: 'accepted',
        number: 20,
        title: 'Accepted one',
        status: 'open',
        taskIds: ['review'],
        foundBy: { taskId: 'review', agentId: 'reviewer' },
        accepted: { by: 'gabriel', at: ago(1) },
        createdAt: ago(60),
      },
    ],
  });
  assert.deepEqual(
    work.rows.map((row) => [row.stage, row.title, row.meta.join(' · ')]),
    [
      ['needs-you', 'Review PR 15', 'Ready to merge · #15'],
      ['up-next', 'Accepted one', 'Found by Code reviewer in PR #15'],
      ['up-next', 'Launch the bazzite app one way, not two', 'Written by Gabriel'],
      ['found', 'Any non-test command marks checks as earlier', 'Found by Code reviewer in PR #15'],
      ['found', 'Mac Clone popover needs a check on a locked screen', 'Found by an agent'],
    ],
  );
  const found = byId(work, 'issue:found')!;
  assert.deepEqual(found.link, { kind: 'issue', id: 'found' });
  assert.deepEqual(found.issue, { id: 'found', number: 16, revision: 0, body: '' });
  assert.equal(work.counts.open, 5);
});

test('an agent-found issue someone started runs as that task, saying who found it', () => {
  const work = stage({
    tasks: [
      { id: 'finder', title: 'Review', status: 'merged', agentId: 'reviewer' },
      { id: 'fix', title: 'Merged pull requests don’t show their checks', status: 'review' },
    ],
    issues: [
      {
        id: 'i',
        number: 7,
        title: 'Merged pull requests don’t show their checks',
        status: 'open',
        taskIds: ['finder', 'fix'],
        foundBy: { taskId: 'finder', agentId: 'reviewer' },
        accepted: { by: 'gabriel', at: ago(10) },
      },
    ],
    runs: [{ id: 'r', taskId: 'fix', status: 'running', workerId: 'bazzite', createdAt: ago(2) }],
  });
  assert.equal(work.rows.length, 1);
  assert.deepEqual(work.rows[0].meta, ['Found by Code reviewer', 'on bazzite', '#7']);
  assert.equal(work.rows[0].stage, 'running');
  assert.deepEqual(work.rows[0].link, { kind: 'task', id: 'fix' });
});

test('Shipped holds merged, finished and closed work, newest first; a task that ended unshipped lets its issue go', () => {
  const work = stage({
    tasks: [
      { id: 'shipped', title: 'Shipped task', status: 'merged', updatedAt: ago(30) },
      { id: 'gave-up', title: 'Cancelled', status: 'closed', updatedAt: ago(20) },
      {
        id: 'finished',
        title: 'Check SER release health',
        status: 'completed',
        updatedAt: ago(40),
      },
    ],
    pulls: [
      { id: 'p1', number: 1, status: 'merged', taskIds: ['shipped'], mergedAt: ago(30) },
      { id: 'p2', number: 2, status: 'merged', taskIds: [], title: 'By hand', mergedAt: ago(5) },
      { id: 'p3', number: 3, status: 'closed', taskIds: [] },
    ],
    issues: [
      { id: 'i1', number: 4, title: 'Old idea', status: 'closed', closedAt: ago(60) },
      { id: 'i2', number: 5, title: 'Still wanted', status: 'open', taskIds: ['gave-up'] },
    ],
  });
  assert.deepEqual(
    work.shipped.map((row) => [row.title, row.meta.join(' · ')]),
    [
      ['By hand', 'Merged · #2'],
      ['Shipped task', 'Merged · #1'],
      ['Check SER release health', 'Finished'],
      ['Old idea', 'Closed · #4'],
    ],
  );
  assert.deepEqual(
    work.rows.map((row) => [row.stage, row.title]),
    [['up-next', 'Still wanted']],
  );
  assert.deepEqual(work.counts, { open: 1, shipped: 4 });
});

test('stages come in order and the open count is all five of them', () => {
  const work = stage({
    tasks: [
      { id: 'run', title: 'Run', status: 'running' },
      { id: 'stuck', title: 'Stuck', status: 'failed' },
      { id: 'asks', title: 'Asks', status: 'review' },
    ],
    waitingForAnswer: new Set(['asks']),
    issues: [
      { id: 'idea', number: 1, title: 'Idea', status: 'open', author: 'gabriel' },
      { id: 'agent', number: 2, title: 'Agent', status: 'open', foundBy: { taskId: 'run' } },
    ],
  });
  assert.deepEqual(
    work.rows.map((row) => row.stage),
    ['needs-you', 'running', 'up-next', 'found', 'stopped'],
  );
  assert.equal(work.counts.open, 5);
});
