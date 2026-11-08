import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { createHotPathHandler } from './proxy.ts';

test('HTTP/2 authority survives forwarding to the HTTP/1 upstream', async () => {
  const upstream = createServer((req, res) => res.end(JSON.stringify(req.headers)));
  const handler = createHotPathHandler({
    getRoute: () => ({ name: 'test', port: 5373 }),
    logRequest: () => {},
    emitEvent: () => {},
  });
  const edge = createHttp2Server((req, res) => {
    // HTTP/2 need not carry a Host header; :authority is authoritative.
    delete req.headers.host;
    if (!handler(req as unknown as IncomingMessage, res as unknown as ServerResponse)) res.end();
  });
  upstream.listen(5373, '127.0.0.1');
  edge.listen(5372, '127.0.0.1');
  await Promise.all([once(upstream, 'listening'), once(edge, 'listening')]);
  const client = connect('http://127.0.0.1:5372');
  try {
    const stream = client.request({ ':authority': 'test.local:443', ':path': '/' });
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      body += chunk;
    });
    await once(stream, 'end');
    const headers = JSON.parse(body);
    assert.equal(headers['x-forwarded-host'], 'test.local:443');
    assert.equal(headers.host, '127.0.0.1:5373');
  } finally {
    client.destroy();
    await Promise.all([
      new Promise<void>((resolve) => edge.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
