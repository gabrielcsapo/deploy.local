// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { connect, createServer as createH2Server, type Http2Server } from 'node:http2';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createNodeListener, NODE_REQUEST_SIGNAL } from './node-listener.js';
import { getRequestSignal } from './request-signal.js';

const servers: (Server | Http2Server)[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function listen(server: Server | Http2Server) {
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await wait(20);
  return check();
}

describe('nodeListener', () => {
  it('passes method, URL, headers and the request body, and drops hop-by-hop response headers', async () => {
    let seen: { method: string; url: string; header: string | null; body: string } | null = null;
    const listener = createNodeListener(async (req) => {
      seen = {
        method: req.method,
        url: req.url,
        header: req.headers.get('x-test'),
        body: await req.text(),
      };
      const headers = new Headers({
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked',
        Connection: 'keep-alive',
      });
      headers.append('Set-Cookie', 'a=1');
      headers.append('Set-Cookie', 'b=2');
      return new Response('hello', { status: 201, headers });
    });
    const port = await listen(createServer(listener));
    const reply = await fetch(`http://127.0.0.1:${port}/path?q=1`, {
      method: 'POST',
      headers: { 'x-test': 'yes' },
      body: 'payload',
    });
    expect(reply.status).toBe(201);
    expect(await reply.text()).toBe('hello');
    expect(reply.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(seen).toEqual({
      method: 'POST',
      url: `http://127.0.0.1:${port}/path?q=1`,
      header: 'yes',
      body: 'payload',
    });
  });

  it('serves the node:http2 compatibility API without pseudo-headers or chunked encoding', async () => {
    let headerNames: string[] = [];
    const listener = createNodeListener(async (req) => {
      headerNames = [...req.headers.keys()];
      // An HTTP/2 response with this header throws ERR_HTTP2_INVALID_CONNECTION_HEADERS.
      return new Response(`at ${new URL(req.url).pathname}`, {
        headers: { 'Transfer-Encoding': 'chunked', 'Content-Type': 'text/plain' },
      });
    });
    const port = await listen(createH2Server(listener));
    const session = connect(`http://127.0.0.1:${port}`);
    try {
      const stream = session.request({ ':path': '/h2' });
      const [headers] = (await once(stream, 'response')) as [Record<string, unknown>];
      let text = '';
      stream.setEncoding('utf8');
      for await (const chunk of stream) text += chunk;
      expect(headers[':status']).toBe(200);
      expect(text).toBe('at /h2');
      expect(headerNames.some((name) => name.startsWith(':'))).toBe(false);
    } finally {
      session.close();
    }
  });

  it('aborts the request signal and cancels the body when the client disconnects', async () => {
    let signal: AbortSignal | undefined;
    let cancelled = false;
    const listener = createNodeListener(async (req, env) => {
      signal = getRequestSignal({ env, req: { raw: req } });
      expect(env[NODE_REQUEST_SIGNAL]).toBe(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first'));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body);
    });
    const port = await listen(createServer(listener));
    const client = request({ port, host: '127.0.0.1' });
    client.end();
    const [response] = await once(client, 'response');
    await once(response, 'data');
    client.destroy();
    expect(await until(() => cancelled && !!signal?.aborted)).toBe(true);
  });

  it('aborts an HTTP/2 stream that is reset while its session stays open', async () => {
    let signal: AbortSignal | undefined;
    const listener = createNodeListener(async (req, env) => {
      signal = getRequestSignal({ env, req: { raw: req } });
      return new Response(new ReadableStream({ start() {} }));
    });
    const port = await listen(createH2Server(listener));
    const session = connect(`http://127.0.0.1:${port}`);
    try {
      const stream = session.request({ ':path': '/' });
      await once(stream, 'response');
      stream.close();
      expect(await until(() => !!signal?.aborted)).toBe(true);
      expect(session.closed).toBe(false);
    } finally {
      session.close();
    }
  });

  it('waits for a slow client instead of buffering the whole body', async () => {
    let produced = 0;
    const chunk = new Uint8Array(64 * 1024);
    const listener = createNodeListener(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              produced++;
              controller.enqueue(chunk);
            },
          }),
        ),
    );
    const port = await listen(createServer(listener));
    const client = request({ port, host: '127.0.0.1' });
    client.end();
    const [response] = await once(client, 'response');
    response.pause();
    await wait(300);
    const whilePaused = produced;
    await wait(300);
    expect(produced).toBe(whilePaused);
    expect(whilePaused).toBeLessThan(2000);
    client.destroy();
  });

  it('answers 500 and reports the error when the handler throws', async () => {
    const errors: unknown[] = [];
    const listener = createNodeListener(
      () => {
        throw new Error('boom');
      },
      (error) => errors.push(error),
    );
    const port = await listen(createServer(listener));
    const reply = await fetch(`http://127.0.0.1:${port}/`);
    expect(reply.status).toBe(500);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('sends no body for HEAD', async () => {
    const listener = createNodeListener(async () => new Response('body'));
    const port = await listen(createServer(listener));
    const reply = await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(await reply.text()).toBe('');
  });
});
