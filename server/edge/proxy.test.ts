import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  isStreamingResponse,
  proxyResponseTimeoutMs,
  proxyToApp,
  type RequestLogEntry,
} from './proxy.ts';

describe('edge proxy streaming classification', () => {
  it('gives range requests a longer response-start window', () => {
    assert.equal(
      proxyResponseTimeoutMs({ method: 'GET', path: '/api/items', rangeHeader: undefined }),
      15_000,
    );
    assert.equal(
      proxyResponseTimeoutMs({ method: 'GET', path: '/stream/movie/1', rangeHeader: 'bytes=0-' }),
      120_000,
    );
  });

  it('gives HLS and other media paths a longer pre-header window', () => {
    assert.equal(
      proxyResponseTimeoutMs({
        method: 'GET',
        path: '/api/hls/movie/1/main/segment-0001.ts',
        rangeHeader: undefined,
      }),
      120_000,
    );
    assert.equal(
      proxyResponseTimeoutMs({ method: 'POST', path: '/upload/video.mp4', rangeHeader: undefined }),
      15_000,
    );
  });

  it('recognizes partial content and media as streaming responses', () => {
    assert.equal(isStreamingResponse(206, 'application/octet-stream', undefined), true);
    assert.equal(isStreamingResponse(200, 'video/mp4', undefined), true);
    assert.equal(isStreamingResponse(200, 'audio/mpeg', undefined), true);
    assert.equal(isStreamingResponse(200, 'application/json', undefined), false);
  });

  it('preserves explicit unbuffered and event streams', () => {
    assert.equal(isStreamingResponse(200, 'text/event-stream', undefined), true);
    assert.equal(isStreamingResponse(200, 'application/octet-stream', 'no'), true);
  });
});

describe('edge proxy request accounting', () => {
  let upstreamPort = 0;
  let proxyPort = 0;
  const payload = 'chunked payload '.repeat(128);
  let resolveLogged: ((entry: RequestLogEntry) => void) | null = null;
  let resolveUpstreamCancelled: (() => void) | null = null;
  let useEndpointSelector = false;
  let endpointReleases = 0;

  const upstream = createServer((req, res) => {
    if (req.url === '/cancelled-range') {
      const declaredBytes = 1024 * 1024;
      res.writeHead(206, {
        'content-type': 'video/mp4',
        'content-length': declaredBytes,
        'content-range': `bytes 0-${declaredBytes - 1}/${declaredBytes}`,
      });
      res.write(Buffer.alloc(4096));
      req.once('close', () => resolveUpstreamCancelled?.());
      return;
    }
    res.setHeader('content-type', 'text/plain');
    // Intentionally omit Content-Length so Node uses chunked transfer.
    res.write(payload.slice(0, 300));
    res.end(payload.slice(300));
  });

  const proxy = createServer((req, res) => {
    const route = {
      name: 'test-app',
      port: upstreamPort,
      selectBackend: useEndpointSelector
        ? () => ({
            host: '127.0.0.1',
            port: upstreamPort,
            endpointId: 'ready-endpoint',
            release: () => endpointReleases++,
          })
        : undefined,
    };
    const proxyReq = proxyToApp(
      {
        getRoute: () => ({ name: 'test-app', port: upstreamPort }),
        logRequest: (_name, entry) => resolveLogged?.(entry),
        emitEvent: () => {},
      },
      req,
      res,
      route,
      req.url || '/',
      '',
      'GET',
    );
    proxyReq?.end();
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

  it('holds a selected graph endpoint lease through the proxied response', async () => {
    useEndpointSelector = true;
    endpointReleases = 0;
    const logged = new Promise<RequestLogEntry>((resolve) => {
      resolveLogged = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${proxyPort}/selected`, (res) => {
        res.resume();
        res.on('end', resolve);
      }).on('error', reject);
    });
    await logged;
    assert.equal(endpointReleases, 1);
    useEndpointSelector = false;
  });

  it('cancels an abandoned range and records only observed bytes', async () => {
    const logged = new Promise<RequestLogEntry>((resolve) => {
      resolveLogged = resolve;
    });
    const upstreamCancelled = new Promise<void>((resolve) => {
      resolveUpstreamCancelled = resolve;
    });
    await new Promise<void>((resolve, reject) => {
      get(`http://127.0.0.1:${proxyPort}/cancelled-range`, (res) => {
        res.once('data', () => {
          res.destroy();
          resolve();
        });
      }).on('error', reject);
    });

    const [entry] = await Promise.all([logged, upstreamCancelled]);
    assert.equal(entry.status, 206);
    assert.equal(entry.responseSize, 4096);
  });
});
