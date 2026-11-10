// A thrown server action reaches the client as a real HTTP status and a JSON
// body with its message and a digest, on the worker and main-thread paths.
// Runs with node:test against dist/ because the worker path needs the
// compiled action-worker.js.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer } from './index.js';
import { ACTION_ENDPOINT, RSC_ACTION_HEADER, RSC_REDIRECT_HEADER } from '../shared/constants.js';

const here = dirname(fileURLToPath(import.meta.url));
// Under the package's node_modules so createServer's createRequire(buildDir)
// finds react, react-dom and react-server-dom-webpack.
const BUILD_DIR = resolve(here, '../../node_modules/.flight-action-transport-fixture');
const redirectModule = pathToFileURL(resolve(here, 'redirect.js')).href;

function writeFixture() {
  const write = (relative: string, contents: string) => {
    const path = resolve(BUILD_DIR, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  write('package.json', JSON.stringify({ name: 'action-transport-fixture', type: 'module' }));
  write('client/.keep', '');
  write('rsc-client-manifest.json', '{}');
  write('ssr-manifest.json', '{}');
  write(
    'server-actions-manifest.json',
    JSON.stringify({ 'app/actions': { id: 'app/actions', name: '*', chunks: [] } }),
  );
  write('build-meta.json', JSON.stringify({ clientEntryUrl: '/assets/entry.js', cssFiles: [] }));
  write('server/rsc-entry.js', 'export const routes = [];\n');
  write(
    'server/rsc-runtime.js',
    `export function renderToReadableStream(model) {
  const bytes = new TextEncoder().encode(JSON.stringify(model));
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}
export async function decodeReply(body) { return typeof body === 'string' ? JSON.parse(body) : [body]; }
`,
  );
  write(
    'server/ssr/react-flight-router/dist/client/router-context.js',
    'export const RouterProvider = () => null;\nexport const OutletDepthContext = {};\n',
  );
  write(
    'server/server-action-app.js',
    `import { redirect } from ${JSON.stringify(redirectModule)};
globalThis.__flight_server_modules ??= {};
globalThis.__flight_server_modules['app/actions'] = {
  ok: async (value) => ({ value }),
  unauthorized: async () => { throw new Error('Unauthorized'); },
  forbidden: async () => { throw Object.assign(new Error('Not yours'), { status: 403 }); },
  goAway: async () => redirect('/signed-out'),
};
`,
  );
}

function call(app: { fetch: (request: Request) => Response | Promise<Response> }, name: string) {
  return app.fetch(
    new Request(`http://localhost${ACTION_ENDPOINT}`, {
      method: 'POST',
      headers: { [RSC_ACTION_HEADER]: `app/actions#${name}`, 'content-type': 'text/plain' },
      body: JSON.stringify(['x']),
    }),
  );
}

before(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  writeFixture();
});
after(() => rmSync(BUILD_DIR, { recursive: true, force: true }));

for (const mode of ['worker', 'main thread'] as const) {
  describe(`server action errors (${mode})`, () => {
    let app: Awaited<ReturnType<typeof createServer>>;
    const errors: unknown[][] = [];
    const realError = console.error;
    before(async () => {
      console.error = (...args: unknown[]) => void errors.push(args);
      app = await createServer({
        buildDir: BUILD_DIR,
        workers: mode === 'worker' ? { size: 1 } : undefined,
      });
    });
    after(async () => {
      console.error = realError;
      await app.close();
    });

    it('returns the result as a flight stream', async () => {
      const response = await call(app, 'ok');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { value: 'x' });
    });

    it('answers a thrown error with a 500 carrying its message and a digest', async () => {
      const response = await call(app, 'unauthorized');
      assert.equal(response.status, 500);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      const body = (await response.json()) as { error: Record<string, unknown> };
      assert.equal(body.error.message, 'Unauthorized');
      assert.match(String(body.error.digest), /^[a-f0-9]{12}$/);
      assert.deepEqual(Object.keys(body.error).sort(), ['digest', 'message']);
      assert.doesNotMatch(JSON.stringify(body), /at .*\.js/, 'no stack trace');
    });

    it("uses the error's own status when it names one", async () => {
      const response = await call(app, 'forbidden');
      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as { error: { message: string } }).error.message,
        'Not yours',
      );
    });

    it('turns redirect() into a header instead of a 500', async () => {
      const response = await call(app, 'goAway');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get(RSC_REDIRECT_HEADER), '/signed-out');
    });

    it('serves the same answer through nodeListener over HTTP', async () => {
      const server = createHttpServer(app.nodeListener);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}${ACTION_ENDPOINT}`, {
          method: 'POST',
          headers: { [RSC_ACTION_HEADER]: 'app/actions#unauthorized' },
          body: '[]',
        });
        assert.equal(response.status, 500);
        assert.equal(
          ((await response.json()) as { error: { message: string } }).error.message,
          'Unauthorized',
        );
      } finally {
        server.close();
      }
    });

    it('answers an unknown action with a 404 and a message', async () => {
      const response = await call(app, 'missing');
      assert.equal(response.status, 404);
      const body = (await response.json()) as { error: { message: string } };
      assert.match(body.error.message, /not a function/);
    });
  });
}
