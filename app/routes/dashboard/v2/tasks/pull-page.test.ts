import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fileChange,
  filesCount,
  filterFiles,
  foldMerges,
  isImage,
  mergesLabel,
  pullDecision,
  pullTaskAsk,
  pullTaskMessage,
  type DecisionDiff,
} from './pull-page.ts';
import { parsePatch } from './api.ts';

const open = {
  status: 'open',
  targetBranch: 'main',
  sourceBranch: 'build/project-work',
  checkCount: 4,
};
const head = '8ab72bd0000000000000000000000000000000000';
const base = '1111111000000000000000000000000000000000';
const diff = (extra: Partial<DecisionDiff> = {}): DecisionDiff => ({
  mergeable: false,
  mergeBlock: null,
  baseCommit: base,
  headCommit: head,
  ...extra,
});

test('a pull request that can merge reads Ready to merge, with Close and Merge', () => {
  const decision = pullDecision(open, diff({ mergeable: true }), null)!;
  assert.equal(decision.title, 'Ready to merge');
  assert.equal(decision.line, 'Checks passed, no conflicts with main');
  assert.deepEqual(decision.actions, ['close', 'merge']);
  assert.equal(decision.primary, 'merge');
  // Without checks it does not claim any passed.
  assert.equal(
    pullDecision({ ...open, checkCount: 0 }, diff({ mergeable: true }), null)!.line,
    'No conflicts with main',
  );
});

test('conflicts name the files and offer a task to update from main, not Merge', () => {
  const decision = pullDecision(
    open,
    diff({
      mergeBlockKind: 'conflicts',
      mergeBlock: 'main has moved … Ask the task to merge main into its branch …',
      conflictSummary: 'main has moved and build/project-work conflicts with it in a.tsx and b.ts.',
    }),
    null,
  )!;
  assert.equal(decision.title, 'Conflicts with main');
  assert.equal(
    decision.line,
    'main has moved and build/project-work conflicts with it in a.tsx and b.ts.',
  );
  assert.deepEqual(decision.actions, ['close', 'update-in-task']);
  assert.equal(decision.primary, 'update-in-task');
});

test('checks that are still running wait; a failed one is named and offers a fix', () => {
  const checks = { commit: head, runId: 'run-1', status: 'running', done: 2, total: 4, failed: [] };
  const running = pullDecision(
    open,
    diff({ mergeBlockKind: 'checks', requiredChecks: checks }),
    null,
  )!;
  assert.equal(running.title, 'Checks running');
  assert.equal(
    running.line,
    'Required pipeline checks have not passed for 8ab72bd yet: 2 of 4 done.',
  );
  assert.equal(running.mergeDisabled, true);
  assert.deepEqual(running.actions, ['close', 'merge']);
  const failed = pullDecision(
    open,
    diff({
      mergeBlockKind: 'checks',
      requiredChecks: { ...checks, status: 'failed', failed: [{ id: 'j', name: 'test' }] },
    }),
    null,
  )!;
  assert.equal(failed.title, 'Checks failed');
  assert.equal(failed.line, 'Required pipeline checks have not passed for 8ab72bd: test failed.');
  assert.deepEqual(failed.actions, ['close', 'fix-in-task']);
  assert.equal(failed.runId, 'run-1');
});

test('nothing to merge offers only Close, as the primary action', () => {
  const decision = pullDecision(
    open,
    diff({
      mergeBlockKind: 'no-changes',
      mergeBlock: 'build/project-work has no commits that main does not already have.',
    }),
    null,
  )!;
  assert.equal(decision.title, 'Nothing to merge');
  assert.deepEqual(decision.actions, ['close']);
  assert.equal(decision.primary, 'close');
});

test('a merge in progress has no actions; a failed one for this version offers Retry merge', () => {
  assert.deepEqual(pullDecision(open, diff({ mergeable: true }), { status: 'queued' }), {
    kind: 'merging',
    title: 'Merging into main…',
    actions: [],
  });
  assert.equal(pullDecision(open, null, null, { merging: true })!.kind, 'merging');
  const failed = { status: 'failed', error: 'cannot lock ref', baseCommit: base, headCommit: head };
  const decision = pullDecision(open, diff({ mergeable: true }), failed)!;
  assert.equal(decision.title, 'Merge failed');
  assert.equal(decision.line, 'cannot lock ref');
  assert.deepEqual(decision.actions, ['close', 'retry-merge']);
  // Once main or the branch moves, the failure no longer describes what would merge.
  assert.equal(
    pullDecision(open, diff({ mergeable: true, baseCommit: 'moved' }), failed)!.kind,
    'ready',
  );
});

test('closed reads who closed it and when, with Reopen; merged has no decision', () => {
  const closed = pullDecision(
    { ...open, status: 'closed', closedByName: 'Gabriel', closedAt: '2026-11-15T00:00:00Z' },
    diff(),
    null,
    { time: () => '2 days ago' },
  )!;
  assert.equal(closed.title, 'Closed');
  assert.equal(closed.line, 'Gabriel closed this pull request 2 days ago.');
  assert.deepEqual(closed.actions, ['reopen']);
  assert.equal(pullDecision({ ...open, status: 'merged' }, diff(), null), null);
  // Until its changes load, an open pull request decides nothing.
  assert.equal(pullDecision(open, null, null), null);
});

test('merges from the target fold into one line after the commits that change something', () => {
  const folded = foldMerges([
    { oid: 'a', author: 'G', date: '2026-11-17T10:00:00Z', subject: 'Work tab' },
    {
      oid: 'm1',
      author: 'G',
      date: '2026-11-17T12:00:00Z',
      subject: 'Merge main',
      mergesTarget: true,
    },
    { oid: 'b', author: 'G', date: '2026-11-17T11:00:00Z', subject: 'Other states' },
    {
      oid: 'm2',
      author: 'G',
      date: '2026-11-17T13:00:00Z',
      subject: 'Merge main',
      mergesTarget: true,
    },
  ]);
  assert.deepEqual(
    folded.commits.map((commit) => commit.oid),
    ['a', 'b'],
  );
  assert.deepEqual(
    folded.merges.map((commit) => commit.oid),
    ['m1', 'm2'],
  );
  assert.equal(folded.latest, '2026-11-17T13:00:00Z');
  assert.equal(mergesLabel(2, 'main'), '2 merges from main');
  assert.equal(mergesLabel(1, 'main'), '1 merge from main');
  assert.equal(foldMerges([]).latest, undefined);
});

test('the file filter narrows by path, ignoring case, and the heading says how many of all', () => {
  const files = [
    { file: 'docs/evidence/project-work/ProjectWork-1440.png' },
    { file: 'docs/evidence/project-work/captures/ProjectWork-700.png' },
    { file: 'app/routes/dashboard/v2/SidebarTasks.tsx' },
  ];
  assert.equal(filterFiles(files, 'projectwork-').length, 2);
  assert.equal(filterFiles(files, '  ').length, 3);
  assert.equal(filterFiles(files, 'nothing').length, 0);
  assert.equal(filesCount(2, 68, true), '2 of 68');
  assert.equal(filesCount(68, 68, false), '68');
});

test('images are recognised by name and a patch says whether a file was added or deleted', () => {
  assert.equal(isImage('a/ProjectWork-1440.PNG'), true);
  assert.equal(isImage('a/notes.md'), false);
  const [added, deleted, changed] = parsePatch(
    [
      'diff --git a/x.png b/x.png',
      'new file mode 100644',
      'Binary files /dev/null and b/x.png differ',
      'diff --git a/y.ts b/y.ts',
      'deleted file mode 100644',
      '--- a/y.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-gone',
      'diff --git a/z.ts b/z.ts',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
    ].join('\n'),
  );
  assert.equal(fileChange(added), 'added');
  assert.equal(fileChange(deleted), 'deleted');
  assert.equal(fileChange(changed), 'changed');
});

test('tasks started from a pull request say what to do', () => {
  const pull = {
    number: 26,
    title: 'Work tab',
    status: 'open',
    sourceBranch: 'build/project-work',
    targetBranch: 'main',
  };
  assert.equal(
    pullTaskMessage(pull, 'update-in-task', { conflicts: ['a.tsx', 'b.ts'] }),
    'Merge main into build/project-work and resolve the conflicts in a.tsx and b.ts, so pull request #26 (“Work tab”) can merge.',
  );
  assert.equal(
    pullTaskMessage(pull, 'fix-in-task', {
      failed: ['test'],
      commit: head,
      run: '/dashboard/projects/p/pipelines?run=r',
    }),
    'The test check failed on build/project-work at 8ab72bd, so pull request #26 (“Work tab”) cannot merge. Find out why and fix it. The failed run is at /dashboard/projects/p/pipelines?run=r',
  );
  assert.equal(
    pullTaskAsk(pull),
    'On build/project-work, the branch of pull request #26 (“Work tab”): ',
  );
  assert.equal(
    pullTaskAsk({ ...pull, status: 'merged' }),
    'A follow-up to pull request #26 (“Work tab”): ',
  );
});
