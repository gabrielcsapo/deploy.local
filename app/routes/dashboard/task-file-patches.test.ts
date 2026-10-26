import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLoadFilePatch, mergeFilePatches, patchSize } from './task-file-patches.ts';

const summary = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-one',
  '+two',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1 +1 @@',
  '-three',
  '',
].join('\n');

test('a loaded full patch replaces its file in place and keeps the rest of the summary', () => {
  assert.deepEqual(
    mergeFilePatches(summary, {}).map((file) => file.path),
    ['a.ts', 'b.ts'],
  );
  const merged = mergeFilePatches(summary, {
    'b.ts': {
      patch:
        'diff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,2 +1,2 @@\n-three\n+four\n five\n',
    },
  });
  assert.deepEqual(
    merged.map((file) => file.path),
    ['a.ts', 'b.ts'],
  );
  // The clipped summary lines for b.ts are gone, replaced by the complete patch.
  assert.deepEqual(
    merged[1].lines.filter((line) => line.kind === 'added').map((line) => line.text),
    ['+four'],
  );
  assert.equal(
    merged[0].lines.some((line) => line.text === '+two'),
    true,
  );
});

test('a file the summary patch had no room for is appended once loaded', () => {
  const merged = mergeFilePatches(summary, {
    'c.ts': { patch: 'diff --git a/c.ts b/c.ts\n--- /dev/null\n+++ b/c.ts\n@@ -0,0 +1 @@\n+new\n' },
    'd.ts': { loading: true },
    'e.ts': { omitted: 'The full patch is on SER.' },
  });
  assert.deepEqual(
    merged.map((file) => file.path),
    ['a.ts', 'b.ts', 'c.ts'],
  );
});

test('a file offers its full patch only while one is still worth fetching', () => {
  // In the summary patch and nothing was clipped: what is shown is already complete.
  assert.equal(canLoadFilePatch(undefined, true, false), false);
  // Clipped summary, or a file missing from it: the full patch is worth asking for.
  assert.equal(canLoadFilePatch(undefined, true, true), true);
  assert.equal(canLoadFilePatch(undefined, false, false), true);
  // Already loading, loaded, or answered with a reason: no repeat request.
  assert.equal(canLoadFilePatch({ loading: true }, false, true), false);
  assert.equal(canLoadFilePatch({ patch: 'diff' }, false, true), false);
  assert.equal(canLoadFilePatch({ omitted: 'on SER' }, false, true), false);
  // A failed attempt can be retried.
  assert.equal(canLoadFilePatch({ error: 'Request failed' }, false, true), true);
});

test('patch sizes read in the units a reviewer judges a download by', () => {
  assert.equal(patchSize(0), '');
  assert.equal(patchSize(undefined), '');
  assert.equal(patchSize(512), '512 B');
  assert.equal(patchSize(50_000), '49 KB');
  assert.equal(patchSize(2 * 1024 * 1024), '2.0 MB');
});
