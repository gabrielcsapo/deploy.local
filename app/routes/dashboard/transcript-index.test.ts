import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexTranscript } from './transcript-index.ts';

test('groups progress once, retains multipart replies and pending activity in order', () => {
  const messages = [
    { id: 'u1', role: 'user', runId: 'one' },
    { id: 'p1', role: 'assistant', runId: 'one', isProgress: true },
    { id: 'a1', role: 'assistant', runId: 'one' },
    { id: 'a2', role: 'assistant', runId: 'one' },
    { id: 'p2', role: 'assistant', runId: 'two', isProgress: true },
    { id: 'u2', role: 'user', runId: 'two' },
    { id: 'p3', role: 'assistant', runId: 'two', isProgress: true },
  ];
  const activity = [{ id: 'one' }, { id: 'two' }, { id: 'empty' }];
  const before = structuredClone(messages);
  const index = indexTranscript(messages, activity);
  assert.deepEqual(
    index.visible.map((m) => m.id),
    ['u1', 'a1', 'a2', 'u2'],
  );
  assert.equal(index.firstAssistant.get('one'), 'a1');
  assert.deepEqual(
    index.progress.get('two')?.map((m) => m.id),
    ['p2', 'p3'],
  );
  assert.equal(index.activityByRun.get('one'), activity[0]);
  assert.deepEqual(
    index.trailingActivity.map((a) => a.id),
    ['two', 'empty'],
  );
  assert.deepEqual(messages, before);
});
