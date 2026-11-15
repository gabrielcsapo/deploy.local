import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCompletion } from './completion-stream.ts';

const frame = (delta: unknown, finish: string | null = null) =>
  'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\r\n\r\n';
function response(text: string) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        // Split every possible UTF-8 and CRLF boundary.
        controller.enqueue(bytes.slice(offset, ++offset));
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
test('stream handles split UTF-8, CRLF, interleaved tool fragments, reasoning and usage', async () => {
  const updates: string[] = [];
  const result = await readCompletion(
    response(
      ': keepalive\r\n\r\n' +
        frame({ role: 'assistant', reasoning_content: 'inspect' }) +
        frame({ content: 'Hello ' }) +
        frame({ content: '世界' }) +
        frame({
          tool_calls: [
            { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } },
            { index: 0, id: 'a', function: { name: 'write_', arguments: '{"path":' } },
          ],
        }) +
        frame(
          {
            tool_calls: [
              { index: 0, function: { name: 'file', arguments: '"a","content":"b"}' } },
              { index: 1, function: { arguments: '"a"}' } },
            ],
          },
          'tool_calls',
        ) +
        'data: {"choices":[],"usage":{"total_tokens":42}}\r\n\r\n' +
        'data: [DONE]\r\n\r\n',
    ),
    (text) => updates.push(text),
  );
  assert.deepEqual(updates, ['Hello ', 'Hello 世界']);
  assert.equal(result.choices[0].message.content, 'Hello 世界');
  assert.equal(result.choices[0].message.reasoning_content, 'inspect');
  assert.deepEqual(
    result.choices[0].message.tool_calls.map((c: any) => [
      c.id,
      c.function.name,
      JSON.parse(c.function.arguments),
    ]),
    [
      ['a', 'write_file', { path: 'a', content: 'b' }],
      ['b', 'read_file', { path: 'a' }],
    ],
  );
  assert.deepEqual(result.usage, { total_tokens: 42 });
});
test('incomplete streams never return executable tool calls or successful messages', async () => {
  await assert.rejects(
    readCompletion(response(frame({ content: 'partial' })), () => {}),
    /disconnected/,
  );
  await assert.rejects(
    readCompletion(response(frame({}, 'length')), () => {}),
    /before completion/,
  );
  await assert.rejects(
    readCompletion(
      response(frame({ tool_calls: [{ index: 0, function: { arguments: '{' } }] }, 'tool_calls')),
      () => {},
    ),
    /Incomplete/,
  );
  await assert.rejects(
    readCompletion(response('data: {"error":{"message":"fail"}}\n\n'), () => {}),
    /stream reported/,
  );
});
test('JSON-only compatible providers retain the existing response path', async () => {
  const json = { choices: [{ message: { role: 'assistant', content: 'complete' } }] };
  assert.deepEqual(await readCompletion(Response.json(json), () => assert.fail()), json);
});
