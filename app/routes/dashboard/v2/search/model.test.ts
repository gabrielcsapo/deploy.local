import test from 'node:test';
import assert from 'node:assert/strict';
import { byFile, codeCount, codeHref, matchParts, messageHref, nameHref } from './model.ts';

test('matches are cut out of text ignoring case', () => {
  assert.deepEqual(matchParts('Clone a cloneRepository', 'clone'), [
    '',
    'Clone',
    ' a ',
    'clone',
    'Repository',
  ]);
  assert.deepEqual(matchParts('nothing', 'x'), ['nothing']);
  assert.deepEqual(matchParts('anything', ''), ['anything']);
});

test('results link to the place they open', () => {
  assert.equal(
    codeHref({ projectId: 'p1', ref: 'main', path: 'worker/sync.ts' }, 88, 'workouts.started'),
    '/dashboard/projects/p1/code?ref=main&file=worker%2Fsync.ts&line=88&find=workouts.started',
  );
  assert.equal(
    nameHref({ kind: 'app', id: 'a', title: 'home-gym sync', projectId: 'home.gym' }),
    '/dashboard/projects/home%2Egym/apps/home-gym%20sync',
  );
  assert.equal(
    nameHref({ kind: 'pull', id: 'pr.1', title: 'Fix', projectId: 'home.gym' }),
    '/dashboard/projects/home%2Egym/pulls/pr%2E1',
  );
  assert.equal(
    nameHref({ kind: 'issue', id: 'i1', title: 'Idea', projectId: 'home.gym' }),
    '/dashboard/projects/home%2Egym/work',
  );
  assert.equal(
    messageHref({
      id: 'm1',
      taskId: 't1',
      title: '',
      who: '',
      fromYou: false,
      at: '',
      snippet: '',
    }),
    '/dashboard/tasks/t1?message=m1',
  );
});

test('code counts read as a sentence and group by file', () => {
  assert.equal(codeCount({ lines: 12, files: 5, truncated: false }), '12 lines in 5 files');
  assert.equal(codeCount({ lines: 1, files: 1, truncated: false }), '1 line in 1 file');
  assert.equal(codeCount({ lines: 2000, files: 40, truncated: true }), '2000+ lines in 40+ files');
  const item = (path: string, line: number) => ({
    projectId: 'p',
    project: 'home-gym',
    ref: 'main',
    path,
    line,
    text: '',
  });
  assert.deepEqual(
    byFile([item('a.ts', 1), item('a.ts', 4), item('b.ts', 2)]).map((group) => [
      group.path,
      group.items.length,
    ]),
    [
      ['a.ts', 2],
      ['b.ts', 1],
    ],
  );
});
