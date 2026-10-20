import test from 'node:test';
import assert from 'node:assert/strict';
import { DeploymentEventStream } from './deployment-events.ts';
import type { DeploymentMessage } from '../../../server/deployment-notification-message.ts';

const message: DeploymentMessage = {
  type: 'deployment',
  name: 'app',
  status: 'running',
  nodeId: 'a',
  nodeName: 'A',
  username: 'owner',
  at: 1,
};

test('streams with node headers, parses split UTF-8/CRLF records, accepts server-selected deployments and cancels on close', async () => {
  const received: DeploymentMessage[] = [];
  let cancelled = false;
  let requestOptions: RequestInit | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new DeploymentEventStream(
    { coordinatorUrl: 'https://deploy.local', nodeId: 'a', secret: 'private' },
    async (url, options) => {
      assert.equal(url, 'https://deploy.local/api/agent/events');
      requestOptions = options;
      return new Response(
        new ReadableStream({
          start(value) {
            controller = value;
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    },
    (value) => received.push(value),
  );
  try {
    assert.deepEqual(requestOptions?.headers, {
      'x-deploy-node-id': 'a',
      'x-deploy-node-secret': 'private',
      Accept: 'text/event-stream',
    });
    assert.equal(requestOptions?.redirect, 'error');
    const bytes = new TextEncoder().encode(
      ': heartbeat\r\n\r\ndata: invalid\n\ndata: ' +
        JSON.stringify({ ...message, nodeId: 'b' }) +
        '\n\ndata: ' +
        JSON.stringify({ ...message, name: 'café' }) +
        '\r\n\r\n',
    );
    for (const byte of bytes) controller!.enqueue(Uint8Array.of(byte));
    const deadline = Date.now() + 2000;
    while (received.length < 2 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(received, [
      { ...message, nodeId: 'b' },
      { ...message, name: 'café' },
    ]);
  } finally {
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(requestOptions?.signal?.aborted);
  assert.ok(cancelled);
});

test('reconnects with exponential backoff and stops retrying after close', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const stream = new DeploymentEventStream(
    { coordinatorUrl: 'https://deploy.local', nodeId: 'a', secret: 'private' },
    async () => {
      attempts++;
      throw new Error('offline');
    },
    () => assert.fail('offline stream must not notify'),
  );
  const settle = async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  try {
    await settle();
    assert.equal(attempts, 1);
    t.mock.timers.tick(999);
    await settle();
    assert.equal(attempts, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(attempts, 2);
    t.mock.timers.tick(1999);
    await settle();
    assert.equal(attempts, 2);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(attempts, 3);
  } finally {
    stream.close();
  }
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(attempts, 3);
});
