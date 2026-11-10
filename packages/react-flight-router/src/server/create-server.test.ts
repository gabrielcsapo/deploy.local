// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, getRequest, redirect } from './index.js';

// Under the package's node_modules so createServer's createRequire(buildDir)
// resolves react, react-dom and react-server-dom-webpack.
const BUILD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/.flight-create-server-fixture',
);

const globals = globalThis as unknown as {
  __hops: (string | undefined)[];
  __currentRequestUrl: () => string | undefined;
  __redirect: typeof redirect;
};
globals.__hops = [];
globals.__currentRequestUrl = () => getRequest()?.url;
globals.__redirect = redirect;

beforeAll(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  const write = (relative: string, contents: string) => {
    const path = resolve(BUILD_DIR, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write('package.json', JSON.stringify({ name: 'create-server-fixture', type: 'module' }));
  write('client/.keep', '');
  write('rsc-client-manifest.json', '{}');
  write('ssr-manifest.json', '{}');
  write('server-actions-manifest.json', '{}');
  write('build-meta.json', JSON.stringify({ clientEntryUrl: '/assets/entry.js', cssFiles: [] }));
  // A root route with no notFound, and pages that call redirect().
  write(
    'server/rsc-entry.js',
    `const page = async () => ({ default: () => null });
const redirectTo = (to) => async () => ({
  default: () => {
    globalThis.__hops.push(globalThis.__currentRequestUrl());
    return globalThis.__redirect(to);
  },
});
export const routes = [{ id: 'root', path: '', component: page, children: [
  { id: 'home', index: true, component: page },
  { id: 'a', path: 'a', component: redirectTo('/b?from=a') },
  { id: 'b', path: 'b', component: redirectTo('https://elsewhere.test/c') },
  { id: 'loop', path: 'loop', component: redirectTo('/loop') },
] }];
`,
  );
  write(
    'server/rsc-runtime.js',
    `export function renderToReadableStream(model) {
  const bytes = new TextEncoder().encode(JSON.stringify(model ?? null));
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
export async function decodeReply(body) { return JSON.parse(body); }
`,
  );
  write(
    'server/ssr/react-flight-router/dist/client/router-context.js',
    'export const RouterProvider = () => null;\nexport const OutletDepthContext = {};\n',
  );
});
afterAll(() => rmSync(BUILD_DIR, { recursive: true, force: true }));

describe('createServer', () => {
  it('warns once when NODE_ENV is not production', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(process.env.NODE_ENV).not.toBe('production');
      const first = await createServer({ buildDir: BUILD_DIR });
      const second = await createServer({ buildDir: BUILD_DIR });
      const warnings = warn.mock.calls.filter((call) => String(call[0]).includes('NODE_ENV'));
      expect(warnings).toHaveLength(1);
      await Promise.all([first.close(), second.close()]);
    } finally {
      warn.mockRestore();
    }
  });

  it('provides __non_webpack_require__ for native-module loaders', async () => {
    const globals = globalThis as { __non_webpack_require__?: NodeJS.Require };
    const previous = globals.__non_webpack_require__;
    delete globals.__non_webpack_require__;
    try {
      const app = await createServer({ buildDir: BUILD_DIR });
      expect(typeof globals.__non_webpack_require__).toBe('function');
      expect(typeof globals.__non_webpack_require__!.resolve('react')).toBe('string');
      await app.close();
    } finally {
      globals.__non_webpack_require__ = previous;
    }
  });

  it('answers an unmatched URL with a not-found document when the root route has none', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    const response = await app.fetch(new Request('http://localhost/no/such/page'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('Page not found');
    await app.close();
  });
  it('follows a chain of redirect() calls, each hop seeing its own request', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    globals.__hops = [];
    const response = await app.fetch(new Request('http://localhost/a'));
    // The last hop leaves the site, so the browser gets a real redirect.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://elsewhere.test/c');
    expect(globals.__hops).toEqual(['http://localhost/a', 'http://localhost/b?from=a']);
    await app.close();
  });

  it('stops a redirect loop and hands it to the browser with a Location', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    globals.__hops = [];
    const response = await app.fetch(new Request('http://localhost/loop'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://localhost/loop');
    expect(globals.__hops.length).toBe(6);
    await app.close();
  });

  it('answers a redirect on the RSC endpoint with a 200 payload the client follows', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    const response = await app.fetch(new Request('http://localhost/__rsc?url=%2Fa'));
    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text()).redirect).toEqual({ url: '/b?from=a', status: 302 });
    await app.close();
  });
});
