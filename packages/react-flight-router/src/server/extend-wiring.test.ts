// @vitest-environment node
// Production half of the `extend` contract. The point of the option is that
// one hook behaves the same under `vite` and `node dist/server.js`, so the
// ordering guarantees are asserted here against the real Hono app that
// createServer builds — see extend-wiring.test.ts in src/dev for the other half.
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { gzip } from 'zlib';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './index.js';
import { gunzipSync, inflateSync } from 'node:zlib';
import { ACTION_ENDPOINT, RSC_ENDPOINT } from '../shared/constants.js';
import type { ExtendContext } from '../shared/extend.js';

vi.mock('zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zlib')>();
  return { ...actual, gzip: vi.fn(actual.gzip) };
});

// The fixture lives under the package's own node_modules so that
// createRequire(buildDir/package.json) — which createServer uses to load the
// app's react/react-dom — resolves by walking up into this package's deps.
const BUILD_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/.flight-extend-fixture',
);

/** Smallest build output createServer will boot against. */
function writeFixture() {
  const write = (relative: string, contents: string) => {
    const path = resolve(BUILD_DIR, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };

  write(
    'client/assets/cache-test.js',
    'export const message = ' + JSON.stringify('asset content '.repeat(500)),
  );
  write('client/assets/other.js', 'export default ' + JSON.stringify('other content '.repeat(500)));
  write('package.json', JSON.stringify({ name: 'extend-fixture', type: 'module' }));
  write('rsc-client-manifest.json', '{}');
  write('ssr-manifest.json', '{}');
  write('server-actions-manifest.json', '{}');
  write('build-meta.json', JSON.stringify({ clientEntryUrl: '/assets/entry.js', cssFiles: [] }));

  write('server/rsc-entry.js', 'export const routes = [];\n');
  // Rendering is never exercised here — these tests are about which handler
  // claims a path, not what it renders.
  write(
    'server/rsc-runtime.js',
    "export function renderToReadableStream() { throw new Error('fixture: no render'); }\n",
  );
  write(
    'server/ssr/react-flight-router/dist/client/router-context.js',
    'export const RouterProvider = () => null;\nexport const OutletDepthContext = {};\n',
  );
}

beforeAll(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true });
  writeFixture();
});

afterAll(() => {
  rmSync(BUILD_DIR, { recursive: true, force: true });
});

describe('extend wiring (production)', () => {
  it('hands the hook a null http server and production mode', async () => {
    let seen: ExtendContext | null = null;
    await createServer({
      buildDir: BUILD_DIR,
      extend: (context) => {
        seen = context;
      },
    });

    expect(seen).not.toBeNull();
    expect(seen!.mode).toBe('production');
    // Documented: this entry file does not own the server, so upgrades attach
    // to whatever the app's `serve()` returns instead.
    expect(seen!.httpServer).toBeNull();
  });

  it('serves a user route ahead of the SSR catch-all', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.get('/api/health', (c) => c.json({ ok: true }));
      },
    });

    const response = await app.fetch(new Request('http://localhost/api/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('awaits an async hook before returning the app', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: async ({ app: userApp }) => {
        await new Promise((r) => setTimeout(r, 10));
        userApp.get('/api/late', (c) => c.text('late'));
      },
    });

    // No readiness gate needed in production: if createServer resolved, the
    // hook has already run.
    const response = await app.fetch(new Request('http://localhost/api/late'));
    expect(await response.text()).toBe('late');
  });

  it('propagates a failing hook out of createServer', async () => {
    await expect(
      createServer({
        buildDir: BUILD_DIR,
        extend: () => {
          throw new Error('extend blew up');
        },
      }),
    ).rejects.toThrow('extend blew up');
  });

  it('cannot shadow the RSC endpoint', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.get(RSC_ENDPOINT, (c) => c.text('HIJACKED'));
      },
    });

    const response = await app.fetch(new Request(`http://localhost${RSC_ENDPOINT}?url=%2F`));

    // The framework's handler owns this path. It may well error against a
    // fixture build — what matters is that the user's handler never ran.
    expect(await response.text()).not.toBe('HIJACKED');
  });

  it('cannot shadow the action endpoint', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.post(ACTION_ENDPOINT, (c) => c.text('HIJACKED'));
      },
    });

    const response = await app.fetch(
      new Request(`http://localhost${ACTION_ENDPOINT}`, { method: 'POST' }),
    );

    expect(await response.text()).not.toBe('HIJACKED');
  });

  it('cannot shadow the asset route', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.get('/assets/*', (c) => c.text('HIJACKED'));
      },
    });

    const response = await app.fetch(new Request('http://localhost/assets/app.js'));

    expect(await response.text()).not.toBe('HIJACKED');
  });

  it("hands the hook its own app, not the framework's", async () => {
    let handed: unknown = null;
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        handed = userApp;
      },
    });

    // Matches development, where the hook gets a standalone Hono bridged into
    // Vite's middleware stack. Handing over the framework's own app would let
    // `onError`/`notFound` replace its handling app-wide.
    expect(handed).not.toBe(app);
  });

  it("scopes the hook's onError to the hook's own routes", async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.onError((_error, c) => c.text('user handled', 500));
        userApp.get('/api/boom', () => {
          throw new Error('handler exploded');
        });
      },
    });

    const response = await app.fetch(new Request('http://localhost/api/boom'));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('user handled');
  });

  it("does not let the hook's notFound swallow framework paths", async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.notFound((c) => c.text('USER 404', 404));
        userApp.get('/api/health', (c) => c.text('ok'));
      },
    });

    const response = await app.fetch(new Request('http://localhost/some/page'));

    // An unmatched page belongs to the SSR catch-all, not to the hook's
    // not-found handler.
    expect(await response.text()).not.toBe('USER 404');
  });

  it('leaves unclaimed paths to the framework', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      extend: ({ app: userApp }) => {
        userApp.get('/api/health', (c) => c.text('mine'));
      },
    });

    const response = await app.fetch(new Request('http://localhost/some/page'));

    expect(await response.text()).not.toBe('mine');
  });
});

describe('static gzip cache', () => {
  const path = resolve(BUILD_DIR, 'client/assets/cache-test.js');
  const original = 'export const message = ' + JSON.stringify('asset content '.repeat(500));
  const request = (encoding?: string, method = 'GET') =>
    new Request('http://localhost/assets/cache-test.js', {
      method,
      headers: encoding ? { 'accept-encoding': encoding } : {},
    });

  it('serves concurrent and warm gzip requests with unchanged bytes and immutable headers', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    vi.mocked(gzip).mockClear();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => app.fetch(request('gzip, deflate, br'))),
    );
    for (const response of responses) {
      expect(response.headers.get('content-encoding')).toBe('gzip');
      expect(response.headers.get('vary')).toBe('Accept-Encoding');
      expect(response.headers.get('cache-control')).toContain('immutable');
      expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(original);
    }
    const warm = await app.fetch(request('gzip'));
    expect(gunzipSync(Buffer.from(await warm.arrayBuffer())).toString()).toBe(original);
    expect(gzip).toHaveBeenCalledTimes(1);
    const identity = await app.fetch(request());
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(await identity.text()).toBe(original);
  });

  it('delegates quality values and deflate to the existing negotiator', async () => {
    const app = await createServer({ buildDir: BUILD_DIR });
    const refused = await app.fetch(request('gzip;q=0, deflate;q=0'));
    expect(refused.headers.get('content-encoding')).toBeNull();
    expect(await refused.text()).toBe(original);
    const deflate = await app.fetch(request('gzip;q=0, deflate'));
    expect(deflate.headers.get('content-encoding')).toBe('deflate');
    expect(inflateSync(Buffer.from(await deflate.arrayBuffer())).toString()).toBe(original);
    const head = await app.fetch(request('gzip', 'HEAD'));
    expect(head.headers.get('content-encoding')).toBeNull();
    expect(await head.text()).toBe('');
  });

  it.each([0, 1])('retains uncached reads with a %i byte budget', async (assetCacheBytes) => {
    const app = await createServer({ buildDir: BUILD_DIR, assetCacheBytes });
    const initial = await app.fetch(request('gzip'));
    expect(gunzipSync(Buffer.from(await initial.arrayBuffer())).toString()).toBe(original);
    try {
      writeFileSync(path, 'updated');
      const next = await app.fetch(request('gzip'));
      expect(gunzipSync(Buffer.from(await next.arrayBuffer())).toString()).toBe('updated');
    } finally {
      writeFileSync(path, original);
    }
  });

  it('retains the identity cache when both representations cannot fit', async () => {
    const app = await createServer({
      buildDir: BUILD_DIR,
      assetCacheBytes: Buffer.byteLength(original),
    });
    await (await app.fetch(request('gzip'))).arrayBuffer();
    try {
      writeFileSync(path, 'changed on disk');
      expect(await (await app.fetch(request())).text()).toBe(original);
    } finally {
      writeFileSync(path, original);
    }
  });

  it('charges compressed representations to the shared LRU budget', async () => {
    // Both identities fit, but their gzip variants push the cache over budget.
    const other = 'export default ' + JSON.stringify('other content '.repeat(500));
    const app = await createServer({
      buildDir: BUILD_DIR,
      assetCacheBytes: Buffer.byteLength(original) + Buffer.byteLength(other),
    });
    const first = await app.fetch(request('gzip'));
    await first.arrayBuffer();
    const second = await app.fetch(
      new Request('http://localhost/assets/other.js', { headers: { 'accept-encoding': 'gzip' } }),
    );
    await second.arrayBuffer();
    try {
      writeFileSync(path, 'reloaded after eviction');
      expect(await (await app.fetch(request())).text()).toBe('reloaded after eviction');
    } finally {
      writeFileSync(path, original);
    }
  });
});
