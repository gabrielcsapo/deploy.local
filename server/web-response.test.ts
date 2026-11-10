import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { pipeWebBody } from './web-response.ts';

const chunk = new Uint8Array(64 * 1024);

test('a streamed body waits for a slow client and stops when the client leaves', async (t) => {
  let produced = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      produced++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const server = createServer((_req, res) => {
    res.writeHead(200);
    void pipeWebBody(body, res).then(() => res.destroyed || res.end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());

  const client = request({ port: (server.address() as AddressInfo).port, host: '127.0.0.1' });
  client.end();
  const [response] = await once(client, 'response');
  // Never read: the socket fills, and an unbounded writer would keep producing.
  response.pause();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const whilePaused = produced;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(produced, whilePaused, 'the producer kept running against a full socket');
  // Bounded by socket buffers, not by how long the client stays stalled.
  assert.ok(whilePaused < 2000, `produced ${whilePaused} chunks for a client that read none`);

  client.destroy();
  const deadline = Date.now() + 3000;
  while (!cancelled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(cancelled, true, 'the body was not cancelled after the client disconnected');
});

test('a body that ends is written in full', async (t) => {
  const parts = ['one ', 'two ', 'three'];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = parts.shift();
      if (next) controller.enqueue(new TextEncoder().encode(next));
      else controller.close();
    },
  });
  const server = createServer((_req, res) => {
    void pipeWebBody(body, res).then(() => res.end());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const reply = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  assert.equal(await reply.text(), 'one two three');
});
