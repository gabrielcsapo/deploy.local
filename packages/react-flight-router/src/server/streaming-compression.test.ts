// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGunzip, createBrotliDecompress, gzipSync } from 'node:zlib';
import { createElement, Suspense, use } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { compressStreamResponse } from './streaming-compression.js';

describe('streaming HTML compression', () => {
  it.each(['gzip', 'br'])(
    'flushes the shell and a 500 ms Suspense boundary with %s',
    async (encoding) => {
      const started = performance.now();
      const ready = new Promise<void>((resolve) => setTimeout(resolve, 500));
      function Boundary() {
        use(ready);
        return createElement('div', null, 'resolved boundary');
      }
      const source = await renderToReadableStream(
        createElement(
          'html',
          null,
          createElement(
            'body',
            null,
            'shell',
            createElement(Suspense, { fallback: 'loading' }, createElement(Boundary)),
          ),
        ),
      );
      const response = compressStreamResponse(new Response(source), encoding);
      expect(response.headers.get('content-encoding')).toBe(encoding);
      const decoder = encoding === 'br' ? createBrotliDecompress() : createGunzip();
      const seen: { text: string; ms: number }[] = [];
      decoder.on('data', (chunk) =>
        seen.push({ text: chunk.toString(), ms: performance.now() - started }),
      );
      const ended = new Promise<void>((resolve, reject) => {
        decoder.on('end', resolve);
        decoder.on('error', reject);
      });
      for await (const chunk of response.body!) decoder.write(chunk);
      decoder.end();
      await ended;
      expect(seen.find((chunk) => chunk.text.includes('shell'))!.ms).toBeLessThan(100);
      const boundary = seen.find((chunk) => chunk.text.includes('resolved boundary'))!;
      expect(boundary.ms).toBeGreaterThanOrEqual(490);
      expect(boundary.ms).toBeLessThan(550);
    },
  );

  it('passes already encoded responses through untouched', async () => {
    const response = new Response(gzipSync('original'), {
      headers: { 'Content-Encoding': 'gzip' },
    });
    expect(compressStreamResponse(response, 'br, gzip')).toBe(response);
  });

  it.each(['gzip;q=0, br;q=0', 'identity', ''])(
    'respects refused encodings: %s',
    async (accept) => {
      const response = new Response('unchanged');
      expect(compressStreamResponse(response, accept)).toBe(response);
    },
  );

  it('negotiates qualities, clears length and preserves Vary', () => {
    const response = compressStreamResponse(
      new Response('body', { headers: { Vary: 'Cookie', 'Content-Length': '4' } }),
      'gzip;q=0.5, br;q=1',
    );
    expect(response.headers.get('content-encoding')).toBe('br');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('vary')).toBe('Cookie, Accept-Encoding');
    return response.arrayBuffer();
  });
});
