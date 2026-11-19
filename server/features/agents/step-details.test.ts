import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRows, editCounts, searchFound, stepDetail, stepOpens } from './step-details.ts';
import { toolStep } from './work-steps.ts';
import { mapConversationEvent } from './conversation-events.ts';

test('An edit counts the lines it added and removed, matched line by line', () => {
  const edit = {
    name: 'Edit',
    arguments: {
      file_path: '/app/web/server.mjs',
      old_string: 'a\nb\nc',
      new_string: 'a\nB\nc\nd',
    },
  };
  assert.deepEqual(editCounts(edit), { added: 2, removed: 1 });
  assert.deepEqual(
    diffRows(['a', 'b'], ['a', 'c']).map((row) => row.kind),
    ['same', 'del', 'add'],
  );
  const step = toolStep(edit, true);
  assert.equal(step?.text, 'Edited server.mjs');
  assert.equal(step?.added, 2);
  assert.equal(step?.removed, 1);
  assert.equal(step?.opens, true);
});

test('An edit opens to its file and diff, numbered from where its result says it landed', () => {
  const detail = stepDetail({
    name: 'Edit',
    arguments: {
      file_path: '/app/web/server.mjs',
      old_string: '});',
      new_string: "});\n\napp.post('/reset', (req, res) => {",
    },
    output:
      "The file /app/web/server.mjs has been updated. Here's a snippet:\n    39→  res.json({ count });\n    40→});\n    41→\n    42→app.post('/reset', (req, res) => {",
  });
  assert.equal(detail.path, '/app/web/server.mjs');
  assert.deepEqual(
    detail.diff?.map((row) => [row.kind, row.new ?? null]),
    [
      ['same', 40],
      ['add', 41],
      ['add', 42],
    ],
  );
  // Without a numbered snippet the rows carry no line numbers rather than made-up ones.
  const bare = stepDetail({
    name: 'Edit',
    arguments: { file_path: '/a', old_string: 'x', new_string: 'y' },
    output: 'ok',
  });
  assert.ok(bare.diff?.every((row) => row.old === undefined && row.new === undefined));
});

test('A command opens to the command and the end of its output', () => {
  const output = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n');
  const detail = stepDetail({
    name: 'Bash',
    arguments: { command: 'pnpm exec tsc --noEmit', description: 'Type-check the project' },
    output,
    isError: true,
  });
  assert.equal(detail.command, 'pnpm exec tsc --noEmit');
  assert.equal(detail.output?.length, 40);
  assert.equal(detail.output?.at(-1), 'line 50');
  assert.equal(detail.more, 10);
  assert.equal(stepOpens({ name: 'Bash', arguments: {} }, false), false);
});

test('A search says what it found on the row and opens to the matches', () => {
  const grep = {
    name: 'Grep',
    arguments: { pattern: 'count' },
    output: 'Found 3 files\nweb/server.mjs\nweb/index.html\nweb/store.mjs',
  };
  assert.equal(searchFound(grep), '3 files');
  assert.equal(toolStep(grep, true)?.found, '3 files');
  assert.deepEqual(stepDetail(grep).found?.slice(1), [
    'web/server.mjs',
    'web/index.html',
    'web/store.mjs',
  ]);
});

test('Each work step carries its run and item, so it can load its detail when opened', () => {
  const calls = new Map();
  mapConversationEvent(
    {
      type: 'item.started',
      runId: 'run-1',
      payload: {
        item: { type: 'tool_call', id: 'toolu_1', name: 'Bash', arguments: { command: 'ls' } },
      },
    },
    { status: 'running' },
    { calls },
  );
  const done = mapConversationEvent(
    {
      type: 'item.completed',
      runId: 'run-1',
      payload: { item: { type: 'tool_result', id: 'toolu_1', output: 'a\nb' } },
    },
    { status: 'running' },
    { calls },
  );
  assert.equal(done?.kind, 'worklog');
  const step = done?.kind === 'worklog' ? done.steps[0] : undefined;
  assert.equal(step?.id, 'work:run-1:toolu_1');
  assert.equal(step?.opens, true);
});
