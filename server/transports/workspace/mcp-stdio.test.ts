import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { serveMcp } from './mcp-stdio.ts';

function connection(t: test.TestContext, callTool: Parameters<typeof serveMcp>[0]['callTool']) {
  const input = new PassThrough();
  const output = new PassThrough();
  const server = serveMcp({ tools: [], callTool, input, output });
  const reader = createInterface({ input: output });
  const replies = reader[Symbol.asyncIterator]();
  t.after(() => {
    server.close();
    reader.close();
    input.destroy();
    output.destroy();
  });
  return {
    input,
    send: (value: unknown) => input.write(JSON.stringify(value) + '\n'),
    read: async () => JSON.parse((await replies.next()).value!),
  };
}

test('MCP validates envelopes and method params, and recovers after malformed lines', async (t) => {
  const client = connection(t, async () => assert.fail('invalid request invoked a tool'));
  client.input.write('{broken}\n');
  assert.deepEqual(await client.read(), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32700, message: 'Parse error' },
  });
  for (const value of [
    null,
    [],
    {},
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: {}, method: 'ping' },
  ]) {
    client.send(value);
    assert.equal((await client.read()).error.code, -32600);
  }
  for (const [method, params] of [
    ['initialize', undefined],
    ['initialize', { protocolVersion: 1, capabilities: {}, clientInfo: {} }],
    [
      'initialize',
      { protocolVersion: '2025-11-25', capabilities: [], clientInfo: { name: 'a', version: '1' } },
    ],
    ['initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'a' } }],
    ['tools/list', { cursor: 4 }],
    ['tools/call', undefined],
    ['tools/call', { name: 4 }],
    ['tools/call', { name: 'a', arguments: [] }],
    ['tools/call', { name: 'a', arguments: null }],
    ['ping', []],
    ['ping', { _meta: [] }],
  ]) {
    client.send({ jsonrpc: '2.0', id: 0, method, params });
    assert.deepEqual(await client.read(), {
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32602, message: 'Invalid params' },
    });
  }
  client.send({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'a' } });
  client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 0 } });
  client.send({ jsonrpc: '2.0', method: 'future-notification' });
  client.send({ jsonrpc: '2.0', id: 'alive', method: 'ping' });
  assert.deepEqual(await client.read(), { jsonrpc: '2.0', id: 'alive', result: {} });
});

test('MCP negotiates every previously supported version without calendar-dependent defaults', async (t) => {
  const client = connection(t, async () => ({}));
  for (const version of [
    '2025-11-25',
    '2025-06-18',
    '2025-03-26',
    '2024-11-05',
    '2024-10-07',
    'unknown',
  ]) {
    client.send({
      jsonrpc: '2.0',
      id: version,
      method: 'initialize',
      params: {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    assert.deepEqual((await client.read()).result, {
      protocolVersion: version === 'unknown' ? '2025-11-25' : version,
      capabilities: { tools: {} },
      serverInfo: { name: 'deploy.local', version: '1.0.0' },
    });
  }
});

test('MCP handles fragmented UTF-8, CRLF and pings during pending tool calls', async (t) => {
  let finish!: (value: unknown) => void;
  const client = connection(t, async (name, args) => {
    assert.equal(name, 'café');
    assert.deepEqual(args, {});
    return new Promise((resolve) => (finish = resolve));
  });
  const bytes = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'café' } }) +
      '\r\n',
  );
  for (const byte of bytes) client.input.write(Buffer.from([byte]));
  client.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
  assert.deepEqual(await client.read(), { jsonrpc: '2.0', id: 2, result: {} });
  finish({ content: [{ type: 'text', text: 'done' }] });
  assert.deepEqual(await client.read(), {
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'done' }] },
  });
});
