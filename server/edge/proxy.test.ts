import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { proxyToApp, type RequestLogEntry } from './proxy.ts';

describe('edge proxy request accounting', () => {
  let upstreamPort = 0;
  let proxyPort = 0;
  const payload = 'chunked payload '.repeat(128);
  let resolveLogged: ((entry: RequestLogEntry) => void) | null = null;

  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'text/plain');
    // Intentionally omit Content-Length so Node uses chunked transfer.
    res.write(payload.slice(0, 300));
    res.end(payload.slice(300));
  });

  const proxy = createServer((req, res) => {
    const proxyReq = proxyToApp(
      {
        getRoute: () => ({ name: 'test-app', port: upstreamPort }),
        logRequest: (_name, entry) => resolveLogged?.(entry),
        emitEvent: () => {},
      },
      req,
      res,
      { name: 'test-app', port: upstreamPort },
      '/',
      '',
      'GET',
    );
    proxyReq.end();
  });

  before(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as { port: number }).port;
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as { port: number }).port;
  });

  after(async () => {
    await Promise.all([
      new Promise<void>((resolve) => upstream.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  });

  it('records the completed byte count for a chunked response', async () => {
    const logged = new Promise<RequestLogEntry>((resolve) => {
      resolveLogged = resolve;
    });
    const body = await new Promise<string>((resolve, reject) => {
      get(`http://127.0.0.1:${proxyPort}`, (res) => {
        let value = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (value += chunk));
        res.on('end', () => resolve(value));
      }).on('error', reject);
    });
    const entry = await logged;

    assert.equal(body, payload);
    assert.equal(entry.responseSize, Buffer.byteLength(payload));
    assert.ok(entry.duration >= 0);
  });
});
