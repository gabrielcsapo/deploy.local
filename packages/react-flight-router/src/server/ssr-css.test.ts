import { expect, it } from 'vitest';
import { createElement, StrictMode } from 'react';
import { renderSSR } from './ssr-renderer.js';

const stream = (text: string) =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
for (const fallback of [false, true]) {
  it(`links the payload's route CSS in order in ${fallback ? 'CSR fallback' : 'SSR'} HTML`, async () => {
    const result = await renderSSR({
      rscStream: stream('flight'),
      ssrManifest: { moduleMap: {}, serverModuleMap: {}, moduleLoading: null },
      clientEntryUrl: '/entry.js',
      cssFiles: ['/other.css', '/root.css', '/page.css'],
      moduleMap: {},
      createFromReadableStream: async () => ({
        url: '/page',
        segments: { root: null },
        params: {},
        cssFiles: ['/root.css', '/page.css'],
      }),
      renderToReadableStream: async () => {
        if (fallback) throw new Error('SSR unavailable');
        return stream('<html><head></head><body></body></html>');
      },
      RouterProvider: () => null,
      OutletDepthContext: { Provider: () => null },
      createElement,
      StrictMode,
    });
    const html = await new Response(result).text();
    expect(html).toContain(
      '<link rel="stylesheet" href="/root.css"><link rel="stylesheet" href="/page.css">',
    );
    expect(html).not.toContain('href="/other.css"');
  });
}
