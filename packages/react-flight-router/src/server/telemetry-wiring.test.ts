// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createServer } from './index.js';
import { generateBootstrapScript } from '../shared/bootstrap-script.js';

const reporters = vi.hoisted(() => [] as { close(): void }[]);
vi.mock('./telemetry.js', async (original) => {
  const actual = await original<typeof import('./telemetry.js')>();
  return {
    ...actual,
    createTelemetryReporter: (...args: Parameters<typeof actual.createTelemetryReporter>) => {
      const reporter = actual.createTelemetryReporter(...args);
      if (reporter) reporters.push(reporter);
      return reporter;
    },
  };
});
vi.mock('./ssr-renderer.js', () => ({
  renderSSR: async (options: any) => {
    const payload = JSON.parse(await new Response(options.rscStream).text());
    const bootstrap = generateBootstrapScript(
      {},
      true,
      options.buildId,
      options.telemetry ? { route: payload.route, ...options.telemetry } : undefined,
    );
    return new Response(`<html><script>${bootstrap}</script>shell</html>`).body;
  },
}));
let directory: string;
beforeAll(() => {
  directory = mkdtempSync(resolve(tmpdir(), 'rfr-telemetry-test-'));
  symlinkSync(resolve('node_modules'), resolve(directory, 'node_modules'));
  const write = (file: string, source: string) => {
    const path = resolve(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  };
  write('package.json', '{"type":"module"}');
  write('rsc-client-manifest.json', '{}');
  write('ssr-manifest.json', '{}');
  write('server-actions-manifest.json', '{"actions":{"id":"actions","name":"save","chunks":[]}}');
  write('build-meta.json', '{"clientEntryUrl":"/entry.js","cssFiles":[]}');
  write(
    'server/rsc-entry.js',
    `const component = async () => ({ default: () => 'content' });
    export const routes = [{ id:'root', component, children: [
      {id:'photos',path:'photos/:id',component},
      {id:'files',path:'files/:path*',component},
      {id:'broken',path:'broken/:id',component:async()=>({default(){throw new Error('broken render')}})}
    ]}];`,
  );
  write(
    'server/rsc-runtime.js',
    `export const decodeReply = async () => [];
    export function renderToReadableStream(payload) { return new Response(JSON.stringify(payload)).body; }`,
  );
  write(
    'server/ssr/react-flight-router/dist/client/router-context.js',
    'export const RouterProvider = () => null; export const OutletDepthContext = {};',
  );
  write(
    'server/chunks/actions.js',
    "export const save = async () => 'saved'; export function fail() { throw new Error('action failed') }",
  );
});
afterEach(() => {
  reporters.splice(0).forEach((reporter) => reporter.close());
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(() => rmSync(directory, { force: true, recursive: true }));
const request = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

describe('production telemetry wiring', () => {
  it('adds masked Server-Timing to pages, RSC and not-found without opting into reporting', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', '');
    const complete = vi.fn();
    const app = await createServer({ buildDir: directory, onRequestComplete: complete });
    for (const [path, route] of [
      ['/photos/private?token=secret', '/photos/:id'],
      ['/__rsc?url=%2Ffiles%2Fa%252Fb%2Fc%3Ftoken%3Dsecret', '/files/:path*'],
      ['/missing?token=secret', '__not_found'],
    ]) {
      const response = await app.fetch(request(path));
      expect(response.headers.get('server-timing')).toMatch(
        new RegExp(
          '^route;desc="' + route.replace('*', '\\*') + '", match;dur=[0-9.]+, render;dur=[0-9.]+$',
        ),
      );
      const body = await response.text();
      expect(body).not.toContain('__RFR_TELEMETRY__');
    }
    expect(complete).toHaveBeenCalledTimes(3);
  });
  it('compresses page HTML and retains callbacks through the final stream', async () => {
    const complete = vi.fn();
    const app = await createServer({ buildDir: directory, onRequestComplete: complete });
    const response = await app.fetch(
      request('/photos/private', { headers: { 'accept-encoding': 'gzip' } }),
    );
    expect(response.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toContain('shell');
    expect(complete).toHaveBeenCalledOnce();
    expect(
      complete.mock.calls[0][0].timings.some((entry: any) => entry.label === 'ssr:stream'),
    ).toBe(true);
  });
  it('reports one finished record, bootstrap opt-in and render/action errors in the same v1 batch', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', 'http://127.0.0.1:5301');
    vi.stubEnv('RFR_TELEMETRY_TOKEN', 'secret');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await createServer({ buildDir: directory });
    const page = await app.fetch(request('/photos/private?token=secret'));
    expect(await page.text()).toContain(
      '__RFR_TELEMETRY__={"route":"/photos/:id","beaconPath":"/__rfr/telemetry"}',
    );
    const broken = await app.fetch(request('/broken/private'));
    expect(broken.status).toBe(500);
    await broken.text();
    const action = await app.fetch(
      request('/__action', {
        method: 'POST',
        headers: { 'X-RSC-Action': 'actions#fail' },
        body: '[]',
      }),
    );
    expect(action.status).toBe(500);
    await action.text();
    vi.useFakeTimers();
    // Explicit best-effort exit flush avoids depending on a real 5-second wait.
    process.emit('beforeExit', 0);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledOnce();
    const records = JSON.parse(fetcher.mock.calls[0][1].body).records;
    expect(records.filter((record: any) => record.kind !== 'error')).toHaveLength(3);
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'page',
        route: '/photos/:id',
        status: 200,
        aborted: false,
        phases: expect.objectContaining({ match: expect.any(Number), stream: expect.any(Number) }),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        route: '/broken/:id',
        where: 'rsc',
        message: 'broken render',
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        route: 'action:actions#fail',
        where: 'action',
        message: 'action failed',
      }),
    );
    expect(records.map((record: any) => record.route).join(' ')).not.toContain('private');
    expect(JSON.stringify(records)).not.toContain('token=');
  });
  it('explicit telemetry options override neutral environment values and carry an escaped custom beacon path', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', 'http://127.0.0.1:5302');
    vi.stubEnv('RFR_TELEMETRY_TOKEN', 'env-token');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const app = await createServer({
      buildDir: directory,
      telemetry: {
        endpoint: 'http://127.0.0.1:5301/',
        token: 'option-token',
        beaconPath: '/metrics/<browser',
      },
    });
    const response = await app.fetch(request('/photos/private'));
    const html = await response.text();
    expect(html).toContain(
      '__RFR_TELEMETRY__={"route":"/photos/:id","beaconPath":"/metrics/\\u003cbrowser"}',
    );
    expect(html).not.toContain('option-token');
    process.emit('beforeExit', 0);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:5301/v1/server',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer option-token' }),
      }),
    );
  });
  it('falls back per field and lets an explicit empty endpoint turn environment reporting off', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', 'http://127.0.0.1:5302');
    vi.stubEnv('RFR_TELEMETRY_TOKEN', 'env-token');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const app = await createServer({ buildDir: directory, telemetry: { token: '' } });
    await (await app.fetch(request('/photos/private'))).text();
    process.emit('beforeExit', 0);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:5302/v1/server',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer ' }),
      }),
    );
    fetcher.mockClear();
    const disabled = await createServer({ buildDir: directory, telemetry: { endpoint: '' } });
    const response = await disabled.fetch(request('/photos/private'));
    expect(await response.text()).not.toContain('__RFR_TELEMETRY__');
    process.emit('beforeExit', 0);
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('beaconPath false disables browser bootstrap but retains server reporting', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const app = await createServer({
      buildDir: directory,
      telemetry: {
        endpoint: 'http://127.0.0.1:5301',
        beaconPath: false,
      },
    });
    const response = await app.fetch(request('/photos/private'));
    expect(await response.text()).not.toContain('__RFR_TELEMETRY__');
    process.emit('beforeExit', 0);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(fetcher.mock.calls[0][1].body).records[0]).toMatchObject({ kind: 'page' });
  });
  it('ignores legacy host environment variables', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', '');
    vi.stubEnv('DEP' + 'LOY_TELEMETRY_URL', 'http://127.0.0.1:5301');
    const app = await createServer({ buildDir: directory });
    const response = await app.fetch(request('/photos/private'));
    expect(await response.text()).not.toContain('_TELEMETRY__=');
  });
  it('marks a cancelled response aborted and completes only once', async () => {
    vi.stubEnv('RFR_TELEMETRY_URL', 'http://127.0.0.1:5301');
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const complete = vi.fn();
    const app = await createServer({ buildDir: directory, onRequestComplete: complete });
    const response = await app.fetch(request('/photos/private'));
    await response.body!.cancel();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0].cancelled).toBe(true);
    process.emit('beforeExit', 0);
    await Promise.resolve();
    const records = JSON.parse(fetcher.mock.calls[0][1].body).records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      route: '/photos/:id',
      kind: 'page',
      status: 200,
      aborted: true,
    });
  });

  it('completes HEAD pages exactly once without waiting for an unread body', async () => {
    const complete = vi.fn();
    const app = await createServer({ buildDir: directory, onRequestComplete: complete });
    const response = await app.fetch(request('/photos/private', { method: 'HEAD' }));
    expect(response.body).toBeNull();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete.mock.calls[0][0]).toMatchObject({ status: 200, type: 'SSR' });
  });

  it('lets extend middleware set headers on HEAD pages after the body is dropped', async () => {
    const complete = vi.fn();
    const app = await createServer({
      buildDir: directory,
      onRequestComplete: complete,
      extend: ({ app: userApp }) => {
        userApp.use('*', async (c, next) => {
          await next();
          c.header('X-After-Next', 'yes');
        });
      },
    });
    const response = await app.fetch(request('/photos/private', { method: 'HEAD' }));
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-after-next')).toBe('yes');
    expect(response.headers.get('server-timing')).toMatch(/^route;desc="\/photos\/:id"/);
    expect(complete).toHaveBeenCalledOnce();
  });

  it('identifies successful actions and includes known execution duration', async () => {
    const app = await createServer({ buildDir: directory });
    const response = await app.fetch(
      request('/__action', {
        method: 'POST',
        headers: { 'X-RSC-Action': 'actions#save' },
        body: '[]',
      }),
    );
    expect(response.headers.get('server-timing')).toMatch(
      /^route;desc="action:actions#save", action;dur=[0-9.]+$/,
    );
    expect(await response.text()).toBe('"saved"');
  });
});
