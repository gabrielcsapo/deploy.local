import { Hono } from "hono";
import { compress } from "hono/compress";
import { createRequire } from "module";
import { readdirSync } from "fs";
import { readFile } from "fs/promises";
import { resolve, sep } from "path";
import { randomUUID } from "crypto";
import { createGzip, constants as zlibConstants } from "zlib";
import { loadManifests } from "./manifest-loader.js";
import { renderRSC } from "./rsc-renderer.js";
import { renderSSR } from "./ssr-renderer.js";
import { handleAction } from "./action-handler.js";
import { getRequestSignal } from "./request-signal.js";
import { createWorkerPool, type WorkerPool } from "./worker-pool.js";
import { requestStorage } from "./request-context.js";
import { createSSRModuleLoader } from "./ssr-module-loader.js";
import { withRenderTimeout } from "./render-timeout.js";
import {
  RSC_CONTENT_TYPE,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_ACTION_HEADER,
  RSC_PREVIOUS_SEGMENTS_HEADER,
  RSC_PREVIOUS_URL_HEADER,
} from "../shared/constants.js";
import type { RouteConfig } from "../router/types.js";
import type { RequestTimingEvent, WorkerOptions } from "../shared/types.js";
import {
  maybeCreateLogger,
  maskParams,
  type FlightTimer,
  type FlightLogger,
} from "../shared/logger.js";

/**
 * Creates a TransformStream that gzip-compresses each chunk individually
 * using Z_SYNC_FLUSH. Unlike CompressionStream (which buffers internally),
 * this flushes compressed output after every input chunk, preserving
 * streaming behavior for RSC Suspense while still reducing wire size.
 */
function createStreamingGzip(): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  encoding: string;
} {
  const gzip = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
  let closed = false;

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on("data", (chunk: Buffer) => {
        if (!closed) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      gzip.on("end", () => {
        if (!closed) {
          closed = true;
          controller.close();
        }
      });
      gzip.on("error", (err) => {
        if (!closed) {
          closed = true;
          controller.error(err);
        }
      });
    },
    cancel() {
      closed = true;
      gzip.destroy();
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise((resolve, reject) => {
        gzip.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
    },
    close() {
      return new Promise((resolve) => {
        gzip.end(() => resolve());
      });
    },
    abort() {
      gzip.destroy();
    },
  });

  return { readable, writable, encoding: "gzip" };
}

interface CreateServerOptions {
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
}

/**
 * Create a production Hono server for a react-flight-router app.
 * Serves static assets, RSC endpoints, server actions, and SSR HTML.
 */
export async function createServer(opts: CreateServerOptions) {
  const buildDir = resolve(opts.buildDir);
  const debugEnabled = opts.debug;
  const onRequestComplete = opts.onRequestComplete;
  const hasCallback = !!onRequestComplete;
  const renderTimeoutMs = opts.renderTimeoutMs;
  const manifests = loadManifests(buildDir);

  function fireRequestComplete(
    logger: FlightTimer,
    type: RequestTimingEvent["type"],
    pathname: string,
    status: number,
    cancelled?: boolean,
  ) {
    if (!onRequestComplete) return;
    try {
      const entries = logger.getEntries();
      const totalEntry = entries.find((e) => e.label === "total");
      onRequestComplete({
        type,
        pathname,
        status,
        totalMs: totalEntry?.durationMs ?? 0,
        timings: entries.filter((e) => e.label !== "total"),
        timestamp: new Date().toISOString(),
        ...(cancelled ? { cancelled } : {}),
      });
    } catch (err) {
      console.error("[react-flight-router] onRequestComplete callback error:", err);
    }
  }

  // Set serverModuleMap to null so that react-server-dom-webpack's
  // loadServerReference takes the createBoundServerReference path.
  // This creates lightweight proxies for server actions during SSR
  // without trying to load the actual server modules (which aren't
  // available in the SSR context).
  manifests.ssrManifest.serverModuleMap = null;

  // Dynamically import the RSC server bundle
  const rscEntry = await import(resolve(buildDir, "server/rsc-entry.js"));
  const routes: RouteConfig[] = rscEntry.routes;

  // Import RSC rendering functions from the built runtime bundle.
  // This was built with resolve.conditions: ['react-server'] so it works
  // without needing --conditions=react-server at Node.js startup.
  const rscRuntime = await import(resolve(buildDir, "server/rsc-runtime.js"));
  const { renderToReadableStream: rscRenderToReadableStream } = rscRuntime;

  // Import SSR dependencies from the app's context (not react-flight-router's).
  // pnpm isolates dependencies, so importing bare specifiers here would resolve
  // to react-flight-router's own react/react-dom copies, causing "multiple React"
  // errors when SSR components use the app's react instance.
  const appRequire = createRequire(resolve(buildDir, "package.json"));
  const rscClientNode = (await import(
    appRequire.resolve("react-server-dom-webpack/client.node")
  )) as any;
  const { createFromReadableStream } = rscClientNode;
  const reactDomServer = (await import(appRequire.resolve("react-dom/server"))) as any;
  const { renderToReadableStream: domRenderToReadableStream } = reactDomServer;

  // Import React from the app's context (not react-flight-router's) so that
  // createElement/StrictMode use the same instance as react-dom/server.
  const appReact = appRequire("react") as typeof import("react");
  const { createElement, StrictMode } = appReact;

  // Load SSR-built router components for wrapping the RSC payload during SSR.
  // These are the same components the client entry uses, but built for Node.js.
  const ssrRouterContext = (await import(
    resolve(buildDir, "server/ssr/react-flight-router/dist/client/router-context.js")
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
  const serverDir = resolve(buildDir, "server");
  const actionEntries = readdirSync(serverDir).filter(
    (f) => f.startsWith("server-action-") && f.endsWith(".js"),
  );
  for (const entry of actionEntries) {
    await import(resolve(serverDir, entry));
  }

  // Module loader for production: look up from global registry first.
  // Server action modules are registered in globalThis.__flight_server_modules
  // when the RSC entry is imported (Rollup may inline them into other chunks,
  // so separate files at predictable paths don't always exist).
  const loadModule = async (id: string) => {
    const registry = (globalThis as any).__flight_server_modules;
    if (registry?.[id]) return registry[id];
    return import(resolve(buildDir, `server/chunks/${id}.js`));
  };

  // Helper to render RSC for a given URL
  const doRenderRSC = async (
    url: URL,
    segments?: string[],
    previousUrl?: URL,
    logger?: FlightLogger,
  ) => {
    return renderRSC({
      url,
      routes,
      clientManifest: manifests.rscClientManifest,
      renderToReadableStream: rscRenderToReadableStream,
      segments,
      previousUrl,
      loadModule,
      logger,
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
    });
  }

  const app = new Hono();

  // Enable gzip/deflate compression for responses.
  // RSC streaming endpoints set Cache-Control: no-transform to opt out,
  // preserving chunk-by-chunk streaming for Suspense.
  app.use("*", compress());

  // Wrap all request handling with the built-in request context.
  // This populates getRequest() via AsyncLocalStorage so server components
  // and actions can access the current request without manual setup.
  // The user's onRequest hook fires first for any additional context.
  const onRequest = opts.onRequest;
  app.use("*", async (c, next) => {
    if (onRequest) onRequest(c.req.raw);
    await requestStorage.run(c.req.raw, next);
  });

  // MIME type lookup — built-in defaults cover common web asset types.
  // Users can extend or override via opts.mimeTypes.
  const mimeTypes: Record<string, string> = {
    // Scripts
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    // Styles
    ".css": "text/css",
    // Markup & data
    ".html": "text/html",
    ".xml": "application/xml",
    ".json": "application/json",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".pdf": "application/pdf",
    // Images
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    // Audio
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    // Video
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    // Fonts
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".eot": "application/vnd.ms-fontobject",
    // Other
    ".wasm": "application/wasm",
    ".zip": "application/zip",
    ".map": "application/json",
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
  const clientDir = resolve(buildDir, "client");
  const clientDirPrefix = clientDir + sep;
  const assetCacheCap = opts.assetCacheBytes ?? 32 * 1024 * 1024;
  interface AssetEntry {
    /** Stored as ArrayBuffer for unambiguous BodyInit typing across TS lib versions. */
    bytes: ArrayBuffer;
    contentType: string;
  }
  const assetCache = new Map<string, AssetEntry>();
  let assetCacheBytes = 0;
  const assetNotFound = new Set<string>();

  function getMimeType(filePath: string): string {
    const dot = filePath.lastIndexOf(".");
    const ext = dot >= 0 ? filePath.slice(dot) : "";
    return mimeTypes[ext] ?? "application/octet-stream";
  }

  function admitToCache(filePath: string, entry: AssetEntry): void {
    if (assetCacheCap <= 0) return;
    if (entry.bytes.byteLength > assetCacheCap) return;
    assetCache.set(filePath, entry);
    assetCacheBytes += entry.bytes.byteLength;
    // Evict oldest entries (Map iteration is insertion-order) until under cap
    while (assetCacheBytes > assetCacheCap) {
      const oldest = assetCache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = assetCache.get(oldest)!;
      assetCache.delete(oldest);
      assetCacheBytes -= evicted.bytes.byteLength;
    }
  }

  app.get("/assets/*", async (c) => {
    const filePath = resolve(buildDir, "client", c.req.path.slice(1));

    // Path containment: reject any path that escapes the client assets dir
    if (filePath !== clientDir && !filePath.startsWith(clientDirPrefix)) {
      return new Response("Not Found", { status: 404 });
    }

    // Cache hit
    const cached = assetCache.get(filePath);
    if (cached) {
      // Promote to most-recently-used
      assetCache.delete(filePath);
      assetCache.set(filePath, cached);
      return new Response(cached.bytes, {
        headers: {
          "Content-Type": cached.contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    // Negative cache: previously-missed paths short-circuit to 404 without I/O
    if (assetNotFound.has(filePath)) {
      return new Response("Not Found", { status: 404 });
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
      return new Response("Not Found", { status: 404 });
    }

    const entry: AssetEntry = { bytes, contentType: getMimeType(filePath) };
    admitToCache(filePath, entry);

    return new Response(entry.bytes, {
      headers: {
        "Content-Type": entry.contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  // RSC endpoint for client-side navigation
  app.get(RSC_ENDPOINT, async (c) => {
    const logger = maybeCreateLogger(debugEnabled, hasCallback);
    logger?.time("total");

    // Capture the request signal early — before the (potentially slow) render.
    // If the client disconnects during rendering, the signal is already listening.
    const requestSignal = getRequestSignal(c);

    const baseOrigin = `http://${c.req.header("host") ?? "localhost"}`;
    const targetUrl = new URL(c.req.query("url") ?? "/", baseOrigin);

    const prevSegments = c.req.header(RSC_PREVIOUS_SEGMENTS_HEADER);
    const segments = prevSegments ? prevSegments.split(",") : undefined;

    const prevUrlHeader = c.req.header(RSC_PREVIOUS_URL_HEADER);
    const previousUrl = prevUrlHeader ? new URL(prevUrlHeader, baseOrigin) : undefined;

    // Check if the client accepts gzip encoding
    const acceptsGzip = c.req.header("Accept-Encoding")?.includes("gzip");

    // Use streaming gzip (Z_SYNC_FLUSH) for RSC responses when the client
    // accepts it. Unlike CompressionStream which buffers small chunks,
    // Z_SYNC_FLUSH flushes compressed output after every input chunk,
    // preserving Suspense streaming while reducing wire size.
    // Falls back to an uncompressed TransformStream otherwise.
    const streamingGzip = acceptsGzip ? createStreamingGzip() : null;
    const { readable, writable } = streamingGzip ?? new TransformStream();

    // Render in the background and pipe to the TransformStream.
    (async () => {
      try {
        let { stream, params } = await doRenderRSC(targetUrl, segments, previousUrl, logger);

        // Wrap the stream to capture the real total time — RSC serialization
        // happens lazily as the stream is consumed, not when it's created.
        // The "rsc:stream" label tracks async rendering time inside the stream
        // (Suspense boundaries, data fetching) that isn't captured by rsc:serialize.
        if (logger) {
          stream = logger.wrapStream(
            stream,
            `RSC ${maskParams(targetUrl.pathname, params)}`,
            (cancelled) => fireRequestComplete(logger, "RSC", targetUrl.pathname, 200, cancelled),
            "rsc:stream",
            requestSignal,
          );
        }

        await stream.pipeTo(writable).catch(() => {});
      } catch {
        try {
          writable.close();
        } catch {
          /* already closed */
        }
      }
    })();

    // Set Cache-Control: no-transform to prevent Hono's compress middleware
    // from double-compressing. We handle compression ourselves with
    // Z_SYNC_FLUSH for proper streaming behavior.
    return new Response(readable, {
      headers: {
        "Content-Type": RSC_CONTENT_TYPE,
        "Cache-Control": "no-transform",
        ...(streamingGzip ? { "Content-Encoding": "gzip" } : {}),
      },
    });
  });

  // Server actions endpoint
  app.post(ACTION_ENDPOINT, async (c) => {
    const logger = maybeCreateLogger(debugEnabled, hasCallback);
    logger?.time("total");

    const requestSignal = getRequestSignal(c);
    const actionUrl = new URL(c.req.raw.headers.get("referer") ?? "/", c.req.url);
    const actionId = c.req.raw.headers.get(RSC_ACTION_HEADER);

    // Worker path: dispatch programmatic actions (X-RSC-Action header) to
    // a worker thread so the main thread stays free for page rendering.
    // Progressive enhancement (form POST without JS) stays on the main
    // thread because it requires a full page re-render after the action.
    if (workerPool && actionId) {
      logger?.time("action:worker-dispatch");

      const taskId = randomUUID();
      const body = await c.req.raw.arrayBuffer();
      const contentType = c.req.raw.headers.get("content-type") ?? "";

      const { stream, done } = workerPool.dispatch({
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

      logger?.timeEnd("action:worker-dispatch");

      // Propagate client disconnect to the worker
      if (requestSignal) {
        requestSignal.addEventListener("abort", () => workerPool!.abort(taskId), { once: true });
      }

      // Handle worker errors (404, 500, 504) — the done promise resolves
      // with the status when the worker finishes or errors.
      done.then(({ status }) => {
        if (status !== 200 && logger) {
          fireRequestComplete(logger, "ACTION", actionUrl.pathname, status);
        }
      });

      let responseStream: ReadableStream = stream;
      if (logger) {
        responseStream = logger.wrapStream(
          stream,
          `ACTION ${actionId} (worker)`,
          (cancelled) => fireRequestComplete(logger, "ACTION", actionUrl.pathname, 200, cancelled),
          undefined,
          requestSignal,
        );
      }

      return new Response(responseStream, {
        headers: {
          "Content-Type": RSC_CONTENT_TYPE,
          "Transfer-Encoding": "chunked",
        },
      });
    }

    // Main-thread path: handles progressive enhancement (form POST)
    // and all actions when workers are not enabled.
    //
    // Worker-based actions enforce their own timeout via WorkerPool,
    // but the main-thread path has no built-in bound — wrap it in
    // renderTimeoutMs so a slow action can't pin the request slot.
    const actionPromise = handleAction({
      request: c.req.raw,
      routes,
      serverActionsManifest: manifests.serverActionsManifest,
      clientManifest: manifests.rscClientManifest,
      loadModule,
      decodeReply: rscRuntime.decodeReply as any,
      renderToReadableStream: rscRenderToReadableStream,
      renderRSC: async (rscUrl, segs) => {
        const { stream } = await doRenderRSC(rscUrl, segs, undefined, logger);
        return stream;
      },
      logger,
      onComplete: (status, cancelled) => {
        if (logger) fireRequestComplete(logger, "ACTION", actionUrl.pathname, status, cancelled);
      },
      requestSignal,
    });

    const raced = await withRenderTimeout(actionPromise, renderTimeoutMs);
    if (raced.timedOut) {
      if (logger) fireRequestComplete(logger, "ACTION", actionUrl.pathname, 504);
      return new Response("Gateway Timeout", { status: 504 });
    }
    return raced.value;
  });

  // Initial page load: SSR with inlined RSC stream for hydration
  app.get("*", async (c) => {
    const logger = maybeCreateLogger(debugEnabled, hasCallback);
    logger?.time("total");

    const requestSignal = getRequestSignal(c);
    const url = new URL(c.req.url);

    // Bundle the entire pre-stream render phase — RSC render, optional
    // redirect re-render, SSR shell render — into a single Promise we
    // can race against the renderTimeoutMs ceiling. Once we have an
    // htmlStream, the response is returned and any further latency is
    // a streaming concern, not a blocking-await one.
    const renderPhase = (async () => {
      const {
        stream: rscStream,
        status,
        params,
        redirect,
      } = await doRenderRSC(url, undefined, undefined, logger);

      let effectiveUrl = url;
      let effectiveStream = rscStream;
      let effectiveStatus = status;
      let effectiveParams = params;
      if (redirect) {
        const redirectUrl = new URL(redirect.url, url.origin);
        const redirectResult = await doRenderRSC(redirectUrl, undefined, undefined, logger);
        effectiveUrl = redirectUrl;
        effectiveStream = redirectResult.stream;
        effectiveStatus = redirectResult.status;
        effectiveParams = redirectResult.params;
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
        createFromReadableStream,
        renderToReadableStream: domRenderToReadableStream,
        RouterProvider: SSRRouterProvider,
        OutletDepthContext: SSROutletDepthContext,
        createElement,
        StrictMode,
        logger,
      });

      return { effectiveUrl, effectiveStatus, effectiveParams, htmlStream };
    })();

    const raced = await withRenderTimeout(renderPhase, renderTimeoutMs);
    if (raced.timedOut) {
      // Note: the in-flight render keeps running until React + RSC notice
      // there's no consumer. We surface a 504 immediately so the slot is
      // freed for new traffic; the leaked CPU work winds down on its own.
      if (logger) fireRequestComplete(logger, "SSR", url.pathname, 504);
      return new Response("Gateway Timeout", { status: 504 });
    }
    const { effectiveUrl, effectiveStatus, effectiveParams, htmlStream } = raced.value;

    let responseStream: ReadableStream = htmlStream;
    if (logger) {
      responseStream = logger.wrapStream(
        htmlStream,
        `SSR ${maskParams(effectiveUrl.pathname, effectiveParams)}`,
        (cancelled) =>
          fireRequestComplete(logger, "SSR", effectiveUrl.pathname, effectiveStatus, cancelled),
        "ssr:stream",
        requestSignal,
      );
    }

    return new Response(responseStream, {
      status: effectiveStatus,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        // Opt out of Hono's compress middleware — its CompressionStream
        // buffers chunks internally, which would delay TTFB for streaming
        // SSR (Suspense fallbacks should reach the browser as soon as the
        // shell is rendered, not after the slow content resolves).
        "Cache-Control": "no-transform",
      },
    });
  });

  return app;
}

export { loadManifests } from "./manifest-loader.js";
export { renderRSC, type RenderRSCResult } from "./rsc-renderer.js";
export { renderSSR } from "./ssr-renderer.js";
export { handleAction } from "./action-handler.js";
export { getRequest, requestStorage } from "./request-context.js";
export { redirect } from "./redirect.js";
export type { RequestTimingEvent, TimingEntry, WorkerOptions } from "../shared/types.js";
