import { Hono, type Context } from 'hono';
import { compress, COMPRESSIBLE_CONTENT_TYPE_REGEX } from 'hono/compress';
import { createRequire } from 'module';
import { readdirSync, readFileSync } from 'fs';
import { readFile } from 'fs/promises';
import { resolve, sep } from 'path';
import { randomUUID } from 'crypto';
import { gzip } from 'zlib';
import { promisify } from 'util';
import { loadManifests } from './manifest-loader.js';
import { renderRSC } from './rsc-renderer.js';
import { renderSSR } from './ssr-renderer.js';
import { handleAction } from './action-handler.js';
import {
  actionErrorDigest,
  actionFailureResponse,
  actionRedirectResponse,
} from './action-error.js';
import { getRequestSignal } from './request-signal.js';
import { createNodeListener } from './node-listener.js';
import { createWorkerPool, type WorkerPool, type WorkerCompletion } from './worker-pool.js';
import { requestStorage } from './request-context.js';
import { createSSRModuleLoader } from './ssr-module-loader.js';
import { withRenderTimeout } from './render-timeout.js';
import {
  RSC_CONTENT_TYPE,
  RSC_BUILD_HEADER,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_ACTION_HEADER,
  RSC_PREVIOUS_SEGMENTS_HEADER,
  RSC_PREVIOUS_URL_HEADER,
} from '../shared/constants.js';
import type { RouteConfig } from '../router/types.js';
import type { ExtendHook } from '../shared/extend.js';
import type { RequestTimingEvent, WorkerOptions } from '../shared/types.js';
import {
  maybeCreateLogger,
  isDebugEnabled,
  type FlightTimer,
  type FlightLogger,
} from '../shared/logger.js';

import { compressStreamResponse } from './streaming-compression.js';
import {
  createTelemetryReporter,
  resolveTelemetryOptions,
  type TelemetryOptions,
  serverTiming,
  telemetryError,
  telemetryPhases,
} from './telemetry.js';

const gzipAsync = promisify(gzip);

/**
 * Absolute paths of the content-hashed files Vite's manifest lists, or null
 * when the build has no manifest (then every /assets file counts as hashed,
 * as before the manifest was read).
 */
function readHashedAssets(clientDir: string): Set<string> | null {
  let manifest: Record<string, { file?: string; css?: string[]; assets?: string[] }>;
  try {
    manifest = JSON.parse(readFileSync(resolve(clientDir, '.vite/manifest.json'), 'utf-8'));
  } catch {
    return null;
  }
  const files = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])])
      if (file) files.add(resolve(clientDir, file));
  }
  return files;
}

export type { TelemetryOptions } from './telemetry.js';

interface CreateServerOptions {
  /** Collector integration. Explicit fields override neutral RFR_TELEMETRY_* environment values. */
  telemetry?: TelemetryOptions;
  /** Path to the build output directory */
  buildDir: string;
  /** Enable performance timing output. Also enabled via FLIGHT_DEBUG=1 env var. */
  debug?: boolean;
  /**
   * Called before each RSC/SSR render with the incoming Request.
   * Use this to set up additional per-request context beyond the built-in
   * request storage. The framework automatically populates `getRequest()`
   * via AsyncLocalStorage — this hook is for any extra setup you need.
   */
  onRequest?: (request: Request) => void;
  /**
   * Called after each RSC/SSR/action request completes with structured timing data.
   * Works independently of `debug` — when `debug` is false, timing is still collected
   * but not printed to stderr. Use this to build monitoring dashboards, send metrics
   * to observability services, or log performance data in your own format.
   */
  onRequestComplete?: (event: RequestTimingEvent) => void;
  /**
   * Enable worker thread pool for server action execution.
   * When enabled, programmatic server actions (via callServer/useActionState)
   * run in separate worker threads, keeping the main thread free for
   * page rendering and other requests.
   *
   * Progressive enhancement form submissions (no JavaScript) still execute
   * on the main thread because they require a full page re-render.
   *
   * **Important:** Module-level mutable state (e.g., `const messages = []`
   * in a `"use server"` file) is NOT shared between workers. Each worker
   * runs in its own V8 isolate. Use external storage (database, Redis)
   * for shared state when workers are enabled.
   *
   * Pass `true` for defaults, or an object for fine-grained control.
   */
  workers?: boolean | WorkerOptions;
  /**
   * Additional MIME type mappings to use when serving static assets.
   * Keys are file extensions (including the leading dot), values are
   * MIME type strings. These are merged with the built-in defaults,
   * so you can override existing entries or add new ones.
   *
   * @example
   * ```ts
   * createServer({
   *   buildDir: "./dist",
   *   mimeTypes: {
   *     ".glb": "model/gltf-binary",
   *     ".gltf": "model/gltf+json",
   *   },
   * });
   * ```
   */
  mimeTypes?: Record<string, string>;
  /**
   * Maximum total bytes of static assets to keep in an in-memory LRU cache.
   * Hashed asset filenames are immutable, so caching their bytes avoids a
   * filesystem read on every request. Set to 0 to disable.
   * Default: 32 MB.
   */
  assetCacheBytes?: number;
  /**
   * Maximum milliseconds the server will wait for the synchronous portion
   * of an SSR or main-thread server-action render before responding with
   * 504 Gateway Timeout.
   *
   * Without this bound, a single misbehaving server component (e.g.
   * `await fetch(...)` against an unreachable upstream with no client
   * timeout) holds the request slot until the client gives up — which
   * can exhaust server connections under load.
   *
   * Worker-based actions already enforce their own per-task timeout
   * (`workers.timeout`), so this option only affects main-thread paths.
   *
   * Default: undefined (no timeout, current behavior).
   */
  renderTimeoutMs?: number;
  /**
   * Register custom HTTP routes.
   *
   * Runs once during `createServer`, before the SSR catch-all, and mirrors
   * `flightRouter({ extend })` in development so the same hook covers both.
   *
   * `httpServer` is `null` here — this entry file creates the server itself,
   * so attach any `upgrade` listener to whatever `serve()` returns.
   */
  extend?: ExtendHook;
  /**
   * Called with an error the returned `nodeListener` caught while bridging a
   * Node request (the response is then a 500, or is cut off if it had
   * started). Default: `console.error`.
   */
  onError?: (error: unknown) => void;
  /**
   * Cache-Control values, per kind of response. Each field replaces one
   * default. The router compresses HTML, RSC and action streams itself, so it
   * adds `no-transform` to those three if a value leaves it out.
   */
  cacheControl?: CacheControlOptions;
}

export interface CacheControlOptions {
  /** Server-rendered HTML documents. Default: `no-cache, no-transform`. */
  html?: string;
  /** `/__rsc` navigation payloads. Default: `private, no-store, no-transform`. */
  rsc?: string;
  /** `/__action` responses. Default: `private, no-store, no-transform`. */
  action?: string;
  /**
   * Files under `/assets` that the build manifest lists, whose names carry a
   * content hash. Default: `public, max-age=31536000, immutable`.
   */
  hashedAssets?: string;
  /** Other files under `/assets`. Default: `public, max-age=300, must-revalidate`. */
  assets?: string;
  /** Files copied from `publicDir`. Default: `public, max-age=86400, must-revalidate`. */
  publicFiles?: string;
}

const DEFAULT_CACHE_CONTROL: Required<CacheControlOptions> = {
  html: 'no-cache, no-transform',
  rsc: 'private, no-store, no-transform',
  action: 'private, no-store, no-transform',
  hashedAssets: 'public, max-age=31536000, immutable',
  assets: 'public, max-age=300, must-revalidate',
  publicFiles: 'public, max-age=86400, must-revalidate',
};

function withNoTransform(value: string): string {
  return /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(value) ? value : `${value}, no-transform`;
}

/**
 * Create a production Hono server for a react-flight-router app.
 * Serves static assets, RSC endpoints, server actions, and SSR HTML.
 */
export async function createServer(opts: CreateServerOptions) {
  const buildDir = resolve(opts.buildDir);
  const debugEnabled = opts.debug;
  const onRequestComplete = opts.onRequestComplete;
  const telemetry = resolveTelemetryOptions(opts.telemetry);
  const reporter = createTelemetryReporter(telemetry);
  const renderTimeoutMs = opts.renderTimeoutMs;
  const manifests = loadManifests(buildDir);
  const cacheControl = { ...DEFAULT_CACHE_CONTROL, ...opts.cacheControl };
  for (const key of ['html', 'rsc', 'action'] as const)
    cacheControl[key] = withNoTransform(cacheControl[key]);

  function fireRequestComplete(
    logger: FlightTimer,
    type: RequestTimingEvent['type'],
    pathname: string,
    status: number,
    cancelled?: boolean,
  ) {
    if (!onRequestComplete) return;
    try {
      const entries = logger.getEntries();
      const totalEntry = entries.find((e) => e.label === 'total');
      onRequestComplete({
        type,
        pathname,
        status,
        totalMs: totalEntry?.durationMs ?? 0,
        timings: entries.filter((e) => e.label !== 'total'),
        timestamp: new Date().toISOString(),
        ...(cancelled ? { cancelled } : {}),
      });
    } catch (err) {
      console.error('[react-flight-router] onRequestComplete callback error:', err);
    }
  }

  interface RequestState {
    t: number;
    type: RequestTimingEvent['type'];
    route: string;
    pathname: string;
    match: number;
    status?: number;
    errors: Set<unknown>;
    workerDone?: Promise<WorkerCompletion>;
  }
  const requests = new WeakMap<FlightTimer, RequestState>();
  function reportError(logger: FlightLogger, where: 'rsc' | 'ssr' | 'action', error: unknown) {
    const state = logger && requests.get(logger);
    if (
      !reporter ||
      !state ||
      state.errors.has(error) ||
      (error instanceof Error && error.name === 'AbortError')
    )
      return;
    state.errors.add(error);
    try {
      reporter.add(telemetryError(error, state.route, where));
    } catch {
      /* Monitoring never fails a user request. */
    }
  }
  function timed(
    type: RequestTimingEvent['type'],
    handler: (c: Context, logger: FlightTimer, state: RequestState) => Promise<Response>,
  ) {
    return async (c: Context) => {
      // Server-Timing is unconditional; reuse the existing logger, silently by default.
      const logger = maybeCreateLogger(debugEnabled, true, !reporter && !onRequestComplete)!;
      logger.time('total');
      const state: RequestState = {
        t: Date.now(),
        type,
        route: '__not_found',
        pathname: new URL(c.req.url).pathname,
        match: 0,
        errors: new Set(),
      };
      requests.set(logger, state);
      let response: Response;
      try {
        response = await handler(c, logger, state);
      } catch (error) {
        reportError(logger, type === 'ACTION' ? 'action' : 'rsc', error);
        response = new Response('Internal Server Error', { status: 500 });
      }
      const entries = logger.getEntries(false);
      const elapsed = entries.find((entry) => entry.label === 'total')?.durationMs ?? 0;
      const action = entries.filter(
        (entry) => entry.label.startsWith('action:execute(') && entry.durationMs !== undefined,
      );
      response.headers.set(
        'Server-Timing',
        type === 'ACTION'
          ? serverTiming(
              state.route,
              undefined,
              undefined,
              action.length
                ? action.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
                : undefined,
            )
          : serverTiming(state.route, state.match, elapsed),
      );
      response.headers.set(
        'Cache-Control',
        type === 'SSR'
          ? cacheControl.html
          : type === 'RSC'
            ? cacheControl.rsc
            : cacheControl.action,
      );
      response = compressStreamResponse(response, c.req.header('Accept-Encoding') ?? '');
      if (!reporter && !onRequestComplete && !isDebugEnabled(debugEnabled)) return response;
      const status = response.status;
      const finish = (aborted: boolean) => {
        fireRequestComplete(logger, type, state.pathname, state.status ?? status, aborted);
        if (reporter) {
          const timings = logger.getEntries();
          reporter.add({
            t: state.t,
            kind: type === 'SSR' ? 'page' : (type.toLowerCase() as 'rsc' | 'action'),
            route: state.route,
            status: state.status ?? status,
            ms: timings.find((entry) => entry.label === 'total')?.durationMs ?? 0,
            phases: telemetryPhases(timings),
            build: manifests.buildId ?? null,
            aborted,
          });
        }
      };
      if (!response.body || c.req.method === 'HEAD') {
        const unread = response.body;
        if (c.req.method === 'HEAD') void unread?.cancel().catch(() => {});
        logger.timeEnd('total');
        logger.flush(type);
        finish(false);
        // Middleware may rebuild the response after next(), which throws on a cancelled body.
        return c.req.method === 'HEAD'
          ? new Response(null, {
              status,
              statusText: response.statusText,
              headers: response.headers,
            })
          : response;
      }
      // Observe errors without changing the bytes or propagating telemetry failures.
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          } catch (error) {
            const worker = await state.workerDone;
            if (!worker?.errorRecord)
              reportError(
                logger,
                type === 'ACTION' ? 'action' : type === 'SSR' ? 'ssr' : 'rsc',
                error,
              );
            controller.error(error);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(
        logger.wrapStream(
          body,
          `${type} ${state.route}`,
          finish,
          type === 'SSR' ? 'ssr:stream' : type === 'RSC' ? 'rsc:stream' : 'action:stream',
          getRequestSignal(c),
        ),
        { status, statusText: response.statusText, headers: response.headers },
      );
    };
  }

  // Set serverModuleMap to null so that react-server-dom-webpack's
  // loadServerReference takes the createBoundServerReference path.
  // This creates lightweight proxies for server actions during SSR
  // without trying to load the actual server modules (which aren't
  // available in the SSR context).
  manifests.ssrManifest.serverModuleMap = null;

  // Dynamically import the RSC server bundle.
  // The `@vite-ignore` hint silences the dev-mode import-analysis warning —
  // this path resolves at Node runtime against the production build dir, so
  // Vite cannot (and shouldn't) statically follow it.
  const rscEntry = await import(/* @vite-ignore */ resolve(buildDir, 'server/rsc-entry.js'));
  const routes: RouteConfig[] = rscEntry.routes;

  // Import RSC rendering functions from the built runtime bundle.
  // This was built with resolve.conditions: ['react-server'] so it works
  // without needing --conditions=react-server at Node.js startup.
  const rscRuntime = await import(/* @vite-ignore */ resolve(buildDir, 'server/rsc-runtime.js'));
  const { renderToReadableStream: rscRenderToReadableStream } = rscRuntime;

  // Import SSR dependencies from the app's context (not react-flight-router's).
  // pnpm isolates dependencies, so importing bare specifiers here would resolve
  // to react-flight-router's own react/react-dom copies, causing "multiple React"
  // errors when SSR components use the app's react instance.
  const appRequire = createRequire(resolve(buildDir, 'package.json'));
  const rscClientNode = (await import(
    /* @vite-ignore */ appRequire.resolve('react-server-dom-webpack/client.node')
  )) as any;
  const { createFromReadableStream } = rscClientNode;
  const reactDomServer = (await import(
    /* @vite-ignore */ appRequire.resolve('react-dom/server')
  )) as any;
  const { renderToReadableStream: domRenderToReadableStream } = reactDomServer;

  // Import React from the app's context (not react-flight-router's) so that
  // createElement/StrictMode use the same instance as react-dom/server.
  const appReact = appRequire('react') as typeof import('react');
  const { createElement, StrictMode } = appReact;

  // Load SSR-built router components for wrapping the RSC payload during SSR.
  // These are the same components the client entry uses, but built for Node.js.
  const ssrRouterContext = (await import(
    /* @vite-ignore */ resolve(
      buildDir,
      'server/ssr/react-flight-router/dist/client/router-context.js',
    )
  )) as any;
  const { RouterProvider: SSRRouterProvider, OutletDepthContext: SSROutletDepthContext } =
    ssrRouterContext;

  // Set up server-side __webpack_require__ shim for SSR.
  // When createFromReadableStream encounters client component references in the
  // RSC stream, it calls __webpack_require__ with the `id` from the SSR manifest
  // entry (e.g., "./ssr/app/routes/counter.client.js"), which is a path relative
  // to the server directory.
  const { load: ssrRequireModule } = createSSRModuleLoader(buildDir);
  (globalThis as any).__webpack_require__ = ssrRequireModule;
  (globalThis as any).__webpack_chunk_load__ = () => Promise.resolve();

  // Import server action entry files to populate globalThis.__flight_server_modules.
  // These are separate entries because client components (which import server actions)
  // get replaced in the RSC build, so actions may not be reachable from rsc-entry.
  const serverDir = resolve(buildDir, 'server');
  const actionEntries = readdirSync(serverDir).filter(
    (f) => f.startsWith('server-action-') && f.endsWith('.js'),
  );
  for (const entry of actionEntries) {
    await import(/* @vite-ignore */ resolve(serverDir, entry));
  }

  // Module loader for production: look up from global registry first.
  // Server action modules are registered in globalThis.__flight_server_modules
  // when the RSC entry is imported (Rollup may inline them into other chunks,
  // so separate files at predictable paths don't always exist).
  const loadModule = async (id: string) => {
    const registry = (globalThis as any).__flight_server_modules;
    if (registry?.[id]) return registry[id];
    return import(/* @vite-ignore */ resolve(buildDir, `server/chunks/${id}.js`));
  };

  // Helper to render RSC for a given URL
  const doRenderRSC = async (
    url: URL,
    segments?: string[],
    previousUrl?: URL,
    logger?: FlightLogger,
    signal?: AbortSignal,
  ) => {
    return renderRSC({
      url,
      routes,
      clientManifest: manifests.rscClientManifest,
      stylesheets: manifests,
      renderToReadableStream: rscRenderToReadableStream,
      segments,
      previousUrl,
      loadModule,
      logger,
      signal,
      telemetry: !!reporter,
      onMatch: (route, duration) => {
        const state = logger && requests.get(logger);
        if (state && state.type !== 'ACTION') {
          state.route = route;
          state.match = duration;
          state.pathname = url.pathname;
        }
      },
      onError: (error) => reportError(logger, 'rsc', error),
    });
  };

  // Build the full module ID → URL map from the RSC client manifest.
  // Used to create per-page moduleMap (only modules referenced in the RSC stream).
  const fullModuleMap: Record<string, string> = {};
  for (const [moduleId, entry] of Object.entries(manifests.rscClientManifest)) {
    // chunks is pairs: [chunkId, chunkUrl, chunkId2, chunkUrl2, ...]
    // The first pair is the main chunk for this module
    if (entry.chunks && entry.chunks.length >= 2) {
      fullModuleMap[moduleId] = entry.chunks[1]; // chunkUrl (absolute path)
    }
  }

  // Optionally create a worker pool for offloading server actions
  let workerPool: WorkerPool | null = null;
  if (opts.workers) {
    const workerOpts = opts.workers === true ? {} : opts.workers;
    workerPool = await createWorkerPool({
      buildDir,
      size: workerOpts.size,
      timeout: workerOpts.timeout,
      telemetry: !!reporter,
    });
  }

  const app = new Hono();

  // Enable gzip/deflate compression for responses.
  // Framework streams set Cache-Control: no-transform and compress per chunk,
  // preserving chunk-by-chunk streaming for Suspense.
  app.use('*', compress());

  // Wrap all request handling with the built-in request context.
  // This populates getRequest() via AsyncLocalStorage so server components
  // and actions can access the current request without manual setup.
  // The user's onRequest hook fires first for any additional context.
  const onRequest = opts.onRequest;
  app.use('*', async (c, next) => {
    if (onRequest) onRequest(c.req.raw);
    await requestStorage.run(c.req.raw, next);
  });

  // MIME type lookup — built-in defaults cover common web asset types.
  // Users can extend or override via opts.mimeTypes.
  const mimeTypes: Record<string, string> = {
    // Scripts
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    // Styles
    '.css': 'text/css',
    // Markup & data
    '.html': 'text/html',
    '.xml': 'application/xml',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    // Images
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.bmp': 'image/bmp',
    // Audio
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    // Video
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    // Fonts
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
    // Other
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
    '.map': 'application/json',
    // User overrides
    ...opts.mimeTypes,
  };

  // Static assets from client build.
  //
  // Asset filenames are content-hashed by Vite (immutable), so we cache the
  // bytes + content-type in a bounded LRU. Cache hits skip the filesystem
  // entirely; misses use async readFile so a slow disk doesn't block other
  // requests on the event loop.
  //
  // Path containment is verified after resolve(): a request path like
  // "../etc/passwd" would otherwise escape buildDir.
  const clientDir = resolve(buildDir, 'client');
  const clientDirPrefix = clientDir + sep;
  const assetCacheCap = opts.assetCacheBytes ?? 32 * 1024 * 1024;
  interface AssetEntry {
    /** Stored as ArrayBuffer for unambiguous BodyInit typing across TS lib versions. */
    bytes: ArrayBuffer;
    gzip?: ArrayBuffer;
    contentType: string;
  }
  const assetCache = new Map<string, AssetEntry>();
  let assetCacheBytes = 0;
  const assetNotFound = new Set<string>();
  const pendingGzip = new Map<string, Promise<ArrayBuffer>>();

  function assetSize(entry: AssetEntry): number {
    return entry.bytes.byteLength + (entry.gzip?.byteLength ?? 0);
  }

  function getMimeType(filePath: string): string {
    const dot = filePath.lastIndexOf('.');
    const ext = dot >= 0 ? filePath.slice(dot) : '';
    return mimeTypes[ext] ?? 'application/octet-stream';
  }

  function admitToCache(filePath: string, entry: AssetEntry): void {
    if (assetCacheCap <= 0) return;
    if (assetSize(entry) > assetCacheCap) return;
    // Concurrent cold reads may admit the same path more than once.
    const previous = assetCache.get(filePath);
    if (previous) assetCacheBytes -= assetSize(previous);
    assetCache.delete(filePath);
    assetCache.set(filePath, entry);
    assetCacheBytes += assetSize(entry);
    // Evict oldest entries (Map iteration is insertion-order) until under cap
    while (assetCacheBytes > assetCacheCap) {
      const oldest = assetCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = assetCache.get(oldest)!;
      assetCache.delete(oldest);
      assetCacheBytes -= assetSize(evicted);
    }
  }

  // Only files the build manifest names are content-hashed; anything else
  // under /assets (copied in by hand, or by another tool) can change in place.
  const hashedAssets = readHashedAssets(clientDir);
  async function assetResponse(filePath: string, entry: AssetEntry, request: Request) {
    const headers: Record<string, string> = {
      'Content-Type': entry.contentType,
      'Cache-Control':
        !hashedAssets || hashedAssets.has(filePath)
          ? cacheControl.hashedAssets
          : cacheControl.assets,
      Vary: 'Accept-Encoding',
    };
    const accept = request.headers.get('accept-encoding') ?? '';
    // Fast path for ordinary browser headers. Let Hono retain responsibility
    // for quality values, wildcards, deflate and other negotiation cases.
    // Both representations share assetCacheBytes' LRU budget. Disabled and
    // oversized caches retain the original streaming compression path.
    if (
      request.method !== 'HEAD' &&
      assetCacheCap > 0 &&
      entry.bytes.byteLength <= assetCacheCap &&
      !accept.includes(';') &&
      /(?:^|,)\s*gzip\s*(?:,|$)/i.test(accept) &&
      COMPRESSIBLE_CONTENT_TYPE_REGEX.test(entry.contentType)
    ) {
      let compressed = entry.gzip;
      if (!compressed) {
        let pending = pendingGzip.get(filePath);
        if (!pending) {
          pending = (async () => {
            const buf = await gzipAsync(new Uint8Array(entry.bytes));
            const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            // Keep representations together so a tight budget cannot evict
            // identity bytes while retaining a now-unreachable gzip entry.
            admitToCache(filePath, { ...entry, gzip: bytes });
            return bytes;
          })().finally(() => pendingGzip.delete(filePath));
          pendingGzip.set(filePath, pending);
        }
        compressed = await pending;
      }
      headers['Content-Encoding'] = 'gzip';
      return new Response(compressed, { headers });
    }
    return new Response(entry.bytes, { headers });
  }

  app.get('/assets/*', async (c) => {
    const filePath = resolve(buildDir, 'client', c.req.path.slice(1));

    // Path containment: reject any path that escapes the client assets dir
    if (filePath !== clientDir && !filePath.startsWith(clientDirPrefix)) {
      return new Response('Not Found', { status: 404 });
    }

    // Cache hit
    const cached = assetCache.get(filePath);
    if (cached) {
      // Promote to most-recently-used
      assetCache.delete(filePath);
      assetCache.set(filePath, cached);
      return assetResponse(filePath, cached, c.req.raw);
    }

    // Negative cache: previously-missed paths short-circuit to 404 without I/O
    if (assetNotFound.has(filePath)) {
      return new Response('Not Found', { status: 404 });
    }

    let bytes: ArrayBuffer;
    try {
      const buf = await readFile(filePath);
      // Slice into a standalone ArrayBuffer so the underlying pool buffer
      // is not retained and the cached entry has unambiguous BodyInit type.
      bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch {
      // Bound the negative cache to avoid unbounded growth from random probes
      if (assetNotFound.size >= 1024) assetNotFound.clear();
      assetNotFound.add(filePath);
      return new Response('Not Found', { status: 404 });
    }

    // Another cold request may have finished (and compressed) this asset while
    // readFile was pending. Retain its representation rather than replacing it.
    const entry: AssetEntry = assetCache.get(filePath) ?? {
      bytes,
      contentType: getMimeType(filePath),
    };
    admitToCache(filePath, entry);

    return assetResponse(filePath, entry, c.req.raw);
  });

  // Static files copied from `publicDir` at build time (Vite's `publicDir`
  // copies its contents verbatim into `dist/client/`, preserving nested
  // directory structure). These are unhashed user assets — favicons,
  // robots.txt, web app manifests, nested images — and they fall outside
  // `/assets/*`, so we register an explicit route per file at startup.
  //
  // Done as an enumeration (rather than a wildcard) so the SSR catch-all
  // still gets to handle arbitrary unknown paths. A "*" registered here
  // would shadow the catch-all for every URL containing a dot, and a
  // wildcard scoped to a top-level subdirectory would shadow real SSR
  // routes that happen to share that directory name. The bytes share the
  // same LRU cache used by `/assets/*`; the only difference is a much
  // shorter cache-control TTL since publicDir filenames aren't
  // content-hashed.
  const PUBLIC_FILE_SKIP = new Set<string>([
    // RFR-managed manifests that live alongside the client bundle. They
    // aren't user-facing static files.
    'manifest.json',
    'ssr-manifest.json',
    'rsc-client-manifest.json',
    'index.html',
  ]);

  const publicFiles: string[] = [];
  try {
    // Manual recursion so we can skip the `assets/` subdirectory cheaply
    // (it's already served by `/assets/*` and contains many hashed chunks
    // we don't want to enumerate or register routes for).
    const stack: string[] = [''];
    while (stack.length > 0) {
      const rel = stack.pop()!;
      const dir = rel === '' ? clientDir : resolve(clientDir, rel);
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (rel === '' && entry.name === 'assets') continue;
          stack.push(childRel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (rel === '' && PUBLIC_FILE_SKIP.has(entry.name)) continue;
        publicFiles.push(childRel);
      }
    }
  } catch {
    // Build output may not exist (e.g. dev mode hot-attaching before first
    // build). Static files will then 404 — same behaviour as before.
  }

  for (const relPath of publicFiles) {
    const filePath = resolve(clientDir, relPath);
    app.get(`/${relPath}`, async () => {
      const cached = assetCache.get(filePath);
      if (cached) {
        assetCache.delete(filePath);
        assetCache.set(filePath, cached);
        return new Response(cached.bytes, {
          headers: {
            'Content-Type': cached.contentType,
            'Cache-Control': cacheControl.publicFiles,
          },
        });
      }
      let bytes: ArrayBuffer;
      try {
        const buf = await readFile(filePath);
        bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      } catch {
        return new Response('Not Found', { status: 404 });
      }
      const entry: AssetEntry = { bytes, contentType: getMimeType(filePath) };
      admitToCache(filePath, entry);
      return new Response(entry.bytes, {
        headers: {
          'Content-Type': entry.contentType,
          // Publicly-shipped files (favicons, manifests) aren't content
          // hashed, so we revalidate daily instead of marking immutable.
          'Cache-Control': cacheControl.publicFiles,
        },
      });
    });
  }

  // RSC endpoint for client-side navigation
  app.get(
    RSC_ENDPOINT,
    timed('RSC', async (c, logger) => {
      const baseOrigin = new URL(c.req.url).origin;
      const targetUrl = new URL(c.req.query('url') ?? '/', baseOrigin);
      const prevSegments = c.req.header(RSC_PREVIOUS_SEGMENTS_HEADER);
      const previous = c.req.header(RSC_PREVIOUS_URL_HEADER);
      const syntheticRequest = new Request(targetUrl, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
      });
      const renderAbort = new AbortController();
      const result = await withRenderTimeout(
        requestStorage.run(syntheticRequest, () =>
          doRenderRSC(
            targetUrl,
            prevSegments?.split(','),
            previous ? new URL(previous, baseOrigin) : undefined,
            logger,
            renderAbort.signal,
          ),
        ),
        renderTimeoutMs,
        () => renderAbort.abort(),
      );
      if (result.timedOut) return new Response('Gateway Timeout', { status: 504 });
      return new Response(result.value.stream, {
        status: result.value.status,
        headers: {
          'Content-Type': RSC_CONTENT_TYPE,
          [RSC_BUILD_HEADER]: manifests.buildId,
        },
      });
    }),
  );

  // Server actions endpoint
  app.post(
    ACTION_ENDPOINT,
    timed('ACTION', async (c, logger, state) => {
      const requestSignal = getRequestSignal(c);
      const actionUrl = new URL(c.req.raw.headers.get('referer') ?? '/', c.req.url);
      const actionId = c.req.raw.headers.get(RSC_ACTION_HEADER);
      state.route = `action:${actionId ?? 'unknown'}`;
      state.pathname = actionUrl.pathname;

      // Worker path: dispatch programmatic actions (X-RSC-Action header) to
      // a worker thread so the main thread stays free for page rendering.
      // Progressive enhancement (form POST without JS) stays on the main
      // thread because it requires a full page re-render after the action.
      if (workerPool && actionId) {
        logger?.time('action:worker-dispatch');

        const taskId = randomUUID();
        const body = await c.req.raw.arrayBuffer();
        const contentType = c.req.raw.headers.get('content-type') ?? '';

        const { stream, head, done } = workerPool.dispatch({
          taskId,
          actionId,
          body,
          contentType,
          requestContext: {
            url: c.req.raw.url,
            method: c.req.raw.method,
            headers: [...c.req.raw.headers.entries()],
          },
        });

        logger?.timeEnd('action:worker-dispatch');

        // Propagate client disconnect to the worker
        if (requestSignal) {
          requestSignal.addEventListener('abort', () => workerPool!.abort(taskId), { once: true });
        }

        // Handle worker errors (404, 500, 504) — the done promise resolves
        // with the status when the worker finishes or errors.
        state.workerDone = done;
        done.then(({ status, errorRecord, timings }) => {
          state.status = status;
          if (errorRecord) reporter?.add(errorRecord);
          for (const entry of timings ?? [])
            logger.record(
              entry.label,
              performance.now() - (entry.durationMs ?? 0),
              entry.durationMs ?? 0,
            );
        });
        // Wait for the worker's first answer so a thrown action gets a real
        // status and message instead of a 200 whose body breaks mid-stream.
        const answer = await head;
        if (answer.kind === 'error') {
          state.status = answer.status;
          void stream.cancel().catch(() => {});
          return actionFailureResponse({
            status: answer.status,
            message: answer.message,
            digest: answer.digest ?? actionErrorDigest(),
          });
        }
        if (answer.kind === 'redirect') {
          void stream.cancel().catch(() => {});
          return actionRedirectResponse(answer);
        }

        return new Response(stream, {
          headers: {
            'Content-Type': RSC_CONTENT_TYPE,
          },
        });
      }

      // Main-thread path: handles progressive enhancement (form POST)
      // and all actions when workers are not enabled.
      //
      // Worker-based actions enforce their own timeout via WorkerPool,
      // but the main-thread path has no built-in bound — wrap it in
      // renderTimeoutMs so a slow action can't pin the request slot.
      // The timeout abort is merged into the request signal so the action's
      // post-action re-render also stops when the 504 has been sent.
      const actionAbort = new AbortController();
      const actionSignal = requestSignal
        ? AbortSignal.any([requestSignal, actionAbort.signal])
        : actionAbort.signal;
      const actionPromise = handleAction({
        request: c.req.raw,
        routes,
        serverActionsManifest: manifests.serverActionsManifest,
        clientManifest: manifests.rscClientManifest,
        loadModule,
        decodeReply: rscRuntime.decodeReply as any,
        renderToReadableStream: rscRenderToReadableStream,
        renderRSC: async (rscUrl, segs) => {
          const { stream } = await doRenderRSC(rscUrl, segs, undefined, logger, actionSignal);
          return stream;
        },
        logger,
        onComplete: (status) => {
          state.status = status;
        },
        deferStreamTiming: true,
        onError: (error) => reportError(logger, 'action', error),
        onAction: (id) => {
          state.route = `action:${id}`;
        },
        requestSignal: actionSignal,
      });

      const raced = await withRenderTimeout(actionPromise, renderTimeoutMs, () =>
        actionAbort.abort(),
      );
      if (raced.timedOut) {
        state.status = 504;
        return new Response('Gateway Timeout', { status: 504 });
      }
      return raced.value;
    }),
  );

  // User routes go last among the explicit routes but ahead of the SSR
  // catch-all, so an app can claim any path the framework has not already
  // taken without being able to shadow /assets, RSC, or actions.
  //
  // The hook gets its own Hono rather than this one, matching development
  // (where it is a standalone app bridged into Vite's middleware stack).
  // Mounting keeps registration order — so the shadowing rule above still
  // holds — while scoping `onError`/`notFound` to the caller's own routes
  // instead of silently replacing the framework's.
  if (opts.extend) {
    const userApp = new Hono();
    await opts.extend({ app: userApp, httpServer: null, mode: 'production' });
    app.route('/', userApp);
  }

  // Initial page load: SSR with inlined RSC stream for hydration
  app.get(
    '*',
    timed('SSR', async (c, logger) => {
      const url = new URL(c.req.url);

      // Bundle the entire pre-stream render phase — RSC render, optional
      // redirect re-render, SSR shell render — into a single Promise we
      // can race against the renderTimeoutMs ceiling. Once we have an
      // htmlStream, the response is returned and any further latency is
      // a streaming concern, not a blocking-await one.
      // Aborted by withRenderTimeout below — stops the RSC + SSR renders so a
      // timed-out request doesn't keep burning CPU/memory after the 504.
      const renderAbort = new AbortController();

      const renderPhase = (async () => {
        const {
          stream: rscStream,
          status,
          redirect,
        } = await doRenderRSC(url, undefined, undefined, logger, renderAbort.signal);

        let effectiveStream = rscStream;
        let effectiveStatus = status;
        if (redirect) {
          const redirectUrl = new URL(redirect.url, url.origin);
          const redirectResult = await doRenderRSC(
            redirectUrl,
            undefined,
            undefined,
            logger,
            renderAbort.signal,
          );
          effectiveStream = redirectResult.stream;
          effectiveStatus = redirectResult.status;
        }

        // Stream the RSC payload directly into the SSR renderer. The previous
        // implementation fully buffered the stream here and regex-scanned the
        // text to build a per-page module map — which forced TTFB to wait for
        // the entire async render tree (Suspense, awaits) to resolve before SSR
        // could begin. Instead, we ship the full module map (built once at
        // server startup, ~bytes-per-client-module — gzips to a few hundred
        // bytes for typical apps) so the runtime moduleMap lookup is always
        // satisfied without inspecting the payload. SSR can now stream
        // concurrently with the RSC render.
        //
        // Render to HTML via SSR: deserialize RSC stream → React tree → HTML
        // The RSC payload is interleaved as script tags for zero-waterfall hydration
        const htmlStream = await renderSSR({
          rscStream: effectiveStream,
          ssrManifest: manifests.ssrManifest,
          clientEntryUrl: manifests.clientEntryUrl,
          cssFiles: manifests.cssFiles,
          moduleMap: fullModuleMap,
          buildId: manifests.buildId,
          createFromReadableStream,
          renderToReadableStream: domRenderToReadableStream,
          RouterProvider: SSRRouterProvider,
          OutletDepthContext: SSROutletDepthContext,
          createElement,
          StrictMode,
          logger,
          signal: renderAbort.signal,
          telemetry:
            reporter && telemetry.beaconPath !== false
              ? { beaconPath: telemetry.beaconPath }
              : undefined,
          onError: (error) => reportError(logger, 'ssr', error),
        });

        return { effectiveStatus, htmlStream };
      })();

      const raced = await withRenderTimeout(renderPhase, renderTimeoutMs, () =>
        renderAbort.abort(),
      );
      if (raced.timedOut) {
        return new Response('Gateway Timeout', { status: 504 });
      }
      const { effectiveStatus, htmlStream } = raced.value;

      return new Response(htmlStream, {
        status: effectiveStatus,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // Cache-Control is set by timed(); its no-transform opts out of
          // Hono's compress middleware, whose CompressionStream buffers chunks
          // and would delay streaming SSR (Suspense fallbacks should reach
          // the browser as soon as the shell is rendered).
        },
      });
    }),
  );

  return Object.assign(app, {
    /**
     * A `(req, res)` listener for `node:http` and the `node:http2`
     * compatibility API. It strips HTTP/2 pseudo-headers and hop-by-hop
     * headers, writes at the client's pace, and aborts the render or action
     * when the client disconnects.
     *
     * @example
     * ```ts
     * const app = await createServer({ buildDir: './dist' });
     * http.createServer(app.nodeListener).listen(3000);
     * ```
     */
    nodeListener: createNodeListener((request, env) => app.fetch(request, env), opts.onError),
    /** Stops the server-action worker threads. Call it when the host shuts down. */
    close: async (): Promise<void> => {
      await workerPool?.destroy();
    },
  });
}

export { loadManifests } from './manifest-loader.js';
export { renderRSC, type RenderRSCResult } from './rsc-renderer.js';
export { renderSSR } from './ssr-renderer.js';
export { handleAction } from './action-handler.js';
export { getRequest, requestStorage } from './request-context.js';
export { redirect } from './redirect.js';
export { createNodeListener, type NodeRequest, type NodeResponse } from './node-listener.js';
export type { RequestTimingEvent, TimingEntry, WorkerOptions } from '../shared/types.js';
export type { ExtendContext, ExtendHook } from '../shared/extend.js';
