import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActivity } from './activity.ts';
const run = { id: 'run', status: 'succeeded' };
const e = (type: string, item: any, createdAt = '2026-10-15T12:00:02Z', runId = 'run') => ({
  type,
  payload: { item },
  runId,
  createdAt,
});
test('tool lifecycles fold once and text deltas never become activity', () => {
  const result = projectActivity(
    [
      e('item.started', {
        id: 'read',
        type: 'tool_call',
        name: 'Read',
        arguments: { file_path: '/work/README.md' },
      }),
      e('item.completed', {
        id: 'read',
        type: 'tool_result',
        output: 'file contents',
        isError: false,
      }),
      e('item.updated', { id: 'answer', type: 'agent_message', text: 'partial' }),
      e('item.completed', { id: 'answer', type: 'agent_message', text: 'final' }),
    ],
    [run],
    [],
  );
  assert.equal(result.activity[0].items.length, 1);
  assert.equal(result.activity[0].summary, 'Read 1 file');
  assert.equal(result.activity[0].items[0].source, '/work/README.md');
  assert.equal(result.activity[0].items[0].output, 'file contents');
});
test('command failures and unfinished calls remain truthful, IDs are scoped by run', () => {
  const result = projectActivity(
    [
      e('item.completed', {
        id: 'one',
        type: 'command_execution',
        command: 'npm test',
        exit_code: 1,
        aggregated_output: 'failed',
      }),
      e(
        'item.started',
        { id: 'one', type: 'command_execution', command: 'sleep 10' },
        undefined,
        'other',
      ),
    ],
    [run, { id: 'other', status: 'stopped' }],
    [],
  );
  assert.equal(result.activity[0].items[0].status, 'failed');
  assert.equal(result.activity[1].items[0].status, 'unknown');
  assert.notEqual(result.activity[0].items[0].id, result.activity[1].items[0].id);
});
test('only pre-tool commentary collapses; multipart final replies and direct answers remain visible', () => {
  const messages = [
    { id: 'run:item:progress', role: 'assistant', createdAt: '2026-10-15T12:00:01Z' },
    { id: 'run:item:final-a', role: 'assistant', createdAt: '2026-10-15T12:00:03Z' },
    { id: 'run:item:final-b', role: 'assistant', createdAt: '2026-10-15T12:00:04Z' },
    { id: 'direct:item:answer', role: 'assistant', createdAt: '2026-10-15T12:00:01Z' },
  ];
  const result = projectActivity(
    [e('item.completed', { id: 'cmd', type: 'command_execution', command: 'pwd', exit_code: 0 })],
    [run, { id: 'direct', status: 'succeeded' }],
    messages,
  );
  assert.deepEqual(
    result.messages.map((m) => m.isProgress),
    [true, false, false, false],
  );
});
