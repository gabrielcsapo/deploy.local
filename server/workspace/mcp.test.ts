import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import test from 'node:test';

const baseline = new URL('./fixtures/mcp-sdk-replies.json', import.meta.url);

test('stdio MCP preserves the recorded SDK conversation', { timeout: 15000 }, async (t) => {
  const calls: unknown[] = [];
  let toolResult: unknown = { jobs: [] };
  const coordinator = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push(JSON.parse(body));
    assert.equal(request.headers['x-deploy-agent-token'], 'local-test-token');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(toolResult));
  });
  coordinator.listen(0, '127.0.0.1');
  await once(coordinator, 'listening');
  t.after(() => coordinator.close());
  const address = coordinator.address();
  assert.ok(address && typeof address === 'object');
  const child = spawn(process.execPath, ['server/workspace/mcp.ts'], {
    env: {
      ...process.env,
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      DEPLOY_AGENT_URL: `http://127.0.0.1:${address.port}`,
      DEPLOY_AGENT_TOKEN: 'local-test-token',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const replies: any[] = [];
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map<number | string, (reply: any) => void>();
  lines.on('line', (line) => {
    const reply = JSON.parse(line);
    replies.push(reply);
    waiting.get(reply.id)?.(reply);
  });
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n');
  const request = (id: number | string, method: string, params?: object) =>
    new Promise<any>((resolve) => {
      waiting.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, ...(params && { params }) });
    });
  for (const [id, protocolVersion] of [
    [1, '2024-11-05'],
    [2, 'unsupported-test-version'],
  ] as const) {
    await request(id, 'initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'stdio-test', version: '1.0' },
    });
  }
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 999 } });
  send({ jsonrpc: '2.0', method: 'notifications/future' });
  await request(3, 'ping');
  await request(4, 'tools/list');
  await request(5, 'tools/call', { name: 'deploy_list_jobs', arguments: {} });
  await request(6, 'tools/call', { name: 'unknown-tool' });
  await request(7, 'unknown-method');
  child.stdin.write('{malformed json}\n');
  await request('after-malformed', 'ping');
  assert.deepEqual(calls, [{ name: 'deploy_list_jobs', args: {} }]);
  assert.equal(stderr, '');
  assert.deepEqual(
    replies.find((reply) => reply.id === null),
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    },
  );
  // The SDK silently discarded malformed lines. Our transport must instead return
  // the JSON-RPC parse error; all other replies are compared without normalization.
  assert.deepEqual(
    replies.filter((reply) => reply.error?.code !== -32700),
    JSON.parse(readFileSync(baseline, 'utf8')),
  );
  toolResult = { snapshot: { image: 'anBlZw==', mimeType: 'image/jpeg', title: 'Snapshot' } };
  const imageReply = await request(8, 'tools/call', { name: 'deploy_list_jobs' });
  assert.deepEqual(imageReply.result, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ snapshot: { mimeType: 'image/jpeg', title: 'Snapshot' } }),
      },
      { type: 'image', data: 'anBlZw==', mimeType: 'image/jpeg' },
    ],
  });
});
