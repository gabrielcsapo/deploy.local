import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTextStream } from './claude-stream.ts';

const event = (event: any) => ({ type: 'stream_event', event });
const start = (id = 'm1') => event({ type: 'message_start', message: { id } });
const block = (index = 0, type = 'text') =>
  event({ type: 'content_block_start', index, content_block: { type, text: '' } });
const delta = (text: string, index = 0) =>
  event({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const complete = (text: string, id = 'm1', uuid = 'u1') => ({
  type: 'assistant',
  uuid,
  message: { id, content: [{ type: 'text', text }] },
});

test('Claude text arrives before completion and updates one durable message', () => {
  const output: any[] = [];
  let time = 0;
  const stream = new ClaudeTextStream(
    (item) => output.push(item),
    () => time,
  );
  stream.consume(start());
  stream.consume(block());
  stream.consume(delta('Hello'));
  assert.equal(output[0].type, 'item.updated');
  assert.equal(output[0].item.text, 'Hello');
  stream.consume(delta(' '));
  assert.equal(output.length, 1); // Coalesce rapid tokens.
  time = 60;
  stream.consume(delta('world'));
  stream.consume(complete('Hello world!'));
  stream.consume(complete('Hello world!')); // Duplicate final delivery.
  assert.deepEqual(
    output.map((e) => e.item.text),
    ['Hello', 'Hello world', 'Hello world!'],
  );
  assert.equal(new Set(output.map((e) => e.item.id)).size, 1);
  assert.equal(output.at(-1).type, 'item.completed');
});

test('tool and thinking deltas are excluded; separate text blocks keep separate identities', () => {
  const output: any[] = [];
  const stream = new ClaudeTextStream((item) => output.push(item));
  stream.consume(start());
  stream.consume(block(0, 'thinking'));
  stream.consume(delta('private thinking', 0));
  stream.consume(block(1));
  stream.consume(delta('First', 1));
  stream.consume(complete('First'));
  stream.consume(block(2, 'tool_use'));
  stream.consume(delta('tool payload', 2));
  stream.consume(block(3));
  stream.consume(delta('Second', 3));
  stream.consume(complete('Second', 'm1', 'u2'));
  assert.deepEqual([...new Set(output.map((e) => e.item.text))], ['First', 'Second']);
  assert.equal(new Set(output.map((e) => e.item.id)).size, 2);
  stream.consume(start('m2'));
  stream.consume(block());
  stream.consume(delta('Third'));
  stream.consume(complete('Third', 'm2', 'u3'));
  assert.equal(new Set(output.map((e) => e.item.id)).size, 3);
});

test('interruption preserves buffered text without manufacturing a completed response', () => {
  const output: any[] = [];
  const stream = new ClaudeTextStream(
    (item) => output.push(item),
    () => 0,
  );
  stream.consume(start());
  stream.consume(block());
  stream.consume(delta('Part'));
  stream.consume(delta('ial'));
  stream.flush();
  assert.equal(output.at(-1).item.text, 'Partial');
  assert(output.every((e) => e.type === 'item.updated'));
  stream.flush();
  assert.equal(output.length, 2);
});

test('completed-only fallback works and nested agent messages do not become the main reply', () => {
  const output: any[] = [];
  const stream = new ClaudeTextStream((item) => output.push(item));
  stream.consume({ ...complete('Nested'), parent_tool_use_id: 'subagent' });
  stream.consume(complete('Main'));
  stream.consume(complete('Main'));
  assert.equal(output.length, 1);
  assert.equal(output[0].item.text, 'Main');
});
