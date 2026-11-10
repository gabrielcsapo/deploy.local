// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './index.js';
import { ACTION_ENDPOINT, RSC_ACTION_HEADER, RSC_ENDPOINT } from '../shared/constants.js';

// Under the package's node_modules so createServer's createRequire(buildDir)
// resolves react, react-dom and react-server-dom-webpack.
const BUILD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/.flight-cache-control-fixture',
);

beforeAll(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  const write = (relative: string, contents: string) => {
    const path = resolve(BUILD_DIR, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write('package.json', JSON.stringify({ name: 'cache-control-fixture', type: 'module' }));
  write('client/assets/entry-AbCd1234.js', 'export {};');
  write('client/assets/hand-copied.js', 'export {};');
  write('client/robots.txt', 'User-agent: *');
  write(
    'client/.vite/manifest.json',
    JSON.stringify({ 'entry.js': { file: 'assets/entry-AbCd1234.js', isEntry: true } }),
  );
  write('rsc-client-manifest.json', '{}');
  write('ssr-manifest.json', '{}');
  write(
    'server-actions-manifest.json',
    JSON.stringify({ 'app/actions': { id: 'app/actions', name: '*', chunks: [] } }),
  );
  write('build-meta.json', JSON.stringify({ clientEntryUrl: '/assets/entry.js', cssFiles: [] }));
  // A page whose module never loads, so SSR answers through the render timeout.
  write(
    'server/rsc-entry.js',
    "export const routes = [{ id: 'root', path: '', component: () => new Promise(() => {}) }];\n",
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
  write(
    'server/server-action-app.js',
    `globalThis.__flight_server_modules ??= {};
globalThis.__flight_server_modules['app/actions'] = { ok: async () => 'ok' };
`,
  );
});
afterAll(() => rmSync(BUILD_DIR, { recursive: true, force: true }));

const action = () =>
  new Request(`http://localhost${ACTION_ENDPOINT}`, {
    method: 'POST',
    headers: { [RSC_ACTION_HEADER]: 'app/actions#ok', 'content-type': 'text/plain' },
    body: '[]',
  });

describe('Cache-Control defaults', () => {
  it('gives each kind of response its policy', async () => {
    const app = await createServer({ buildDir: BUILD_DIR, renderTimeoutMs: 20 });
    const header = async (request: Request | string) => {
      const response = await app.fetch(
        typeof request === 'string' ? new Request(`http://localhost${request}`) : request,
      );
      await response.arrayBuffer();
      return response.headers.get('cache-control');
    };

    expect(await header('/')).toBe('no-cache, no-transform');
    expect(await header(`${RSC_ENDPOINT}?url=%2Fmissing`)).toBe('private, no-store, no-transform');
    expect(await header(action())).toBe('private, no-store, no-transform');
    expect(await header('/assets/entry-AbCd1234.js')).toBe('public, max-age=31536000, immutable');
    expect(await header('/assets/hand-copied.js')).toBe('public, max-age=300, must-revalidate');
    expect(await header('/robots.txt')).toBe('public, max-age=86400, must-revalidate');
    await app.close();
  });

  it('takes overrides, keeping no-transform on the streams it compresses itself', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      cacheControl: { action: 'private, max-age=5', assets: 'no-store' },
    });
    const response = await app.fetch(action());
    expect(response.headers.get('cache-control')).toBe('private, max-age=5, no-transform');
    const asset = await app.fetch(new Request('http://localhost/assets/hand-copied.js'));
    expect(asset.headers.get('cache-control')).toBe('no-store');
    await app.close();
  });

  it('does not put the hop-by-hop Transfer-Encoding header on fetch responses', async () => {
    // action-transport.test covers the worker path, which needs compiled JS.
    const app = await createServer({ buildDir: BUILD_DIR });
    const response = await app.fetch(action());
    expect(response.headers.get('transfer-encoding')).toBeNull();
    await app.close();
  });
});
