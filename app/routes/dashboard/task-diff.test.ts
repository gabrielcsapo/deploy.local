import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTaskDiff, taskDiffIndex } from './task-diff.ts';

test('review splits files and preserves independent old/new hunk line numbers', () => {
  const files = parseTaskDiff(
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -3,2 +3,3 @@\n before\n-old\n+new\n+extra\ndiff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+created\n',
  );
  assert.deepEqual(
    files.map((file) => file.path),
    ['a.ts', 'new.ts'],
  );
  assert.deepEqual(files[0].lines.slice(1), [
    { text: ' before', kind: 'context', oldLine: 3, newLine: 3 },
    { text: '-old', kind: 'removed', oldLine: 4 },
    { text: '+new', kind: 'added', newLine: 4 },
    { text: '+extra', kind: 'added', newLine: 5 },
  ]);
  assert.equal(files[1].lines.at(-1)?.newLine, 1);
});

test('deleted, renamed, quoted, and binary paths remain navigable', () => {
  const patch =
    'diff --git a/deleted.ts b/deleted.ts\n--- a/deleted.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\ndiff --git "a/old name.ts" "b/new name.ts"\n--- "a/old name.ts"\n+++ "b/new name.ts"\n@@ -1 +1 @@\n same\ndiff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n';
  assert.deepEqual(
    parseTaskDiff(patch).map((file) => file.path),
    ['deleted.ts', 'new name.ts', 'logo.png'],
  );
  assert.deepEqual(parseTaskDiff(''), []);
});

test('header-like source and Git-quoted UTF-8 paths keep their real contents', () => {
  const [file] = parseTaskDiff(
    'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n--- "a/\\303\\251.ts"\n+++ "b/\\303\\251.ts"\n@@ -1,2 +1,2 @@\n--- old source\n+++ new source\n context\n',
  );
  assert.equal(file.path, 'é.ts');
  assert.equal(taskDiffIndex([file], '"\\303\\251.ts"'), 0);
  assert.deepEqual(
    file.lines.slice(1).map((line) => [line.text, line.oldLine, line.newLine]),
    [
      ['--- old source', 1, undefined],
      ['+++ new source', undefined, 1],
      [' context', 2, 2],
    ],
  );
});

test('status navigation resolves renamed paths without stripping real directory prefixes', () => {
  const files = parseTaskDiff(
    'diff --git a/old.ts b/a/new.ts\nrename from old.ts\nrename to a/new.ts\n',
  );
  assert.equal(taskDiffIndex(files, 'old.ts -> a/new.ts', 'R '), 0);
  const [whitespace] = parseTaskDiff(
    'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n+keep trailing space  \n',
  );
  assert.equal(whitespace.lines.at(-1)?.text, '+keep trailing space  ');
});
