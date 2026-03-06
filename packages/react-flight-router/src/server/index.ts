import { Hono } from "hono";
import { compress } from "hono/compress";
import { createRequire } from "module";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";
import { createGzip, constants as zlibConstants } from "zlib";
import { loadManifests } from "./manifest-loader.js";
import { renderRSC } from "./rsc-renderer.js";
import { renderSSR } from "./ssr-renderer.js";
import { handleAction } from "./action-handler.js";
import { createWorkerPool, type WorkerPool } from "./worker-pool.js";
import { requestStorage } from "./request-context.js";
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

  /**
   * Get an AbortSignal that fires when the client disconnects.
   *
   * Uses the incoming request's TCP socket to detect connection drops.
   * This catches forceful disconnects (e.g., `http.request().destroy()`)
   * and streaming responses where the browser closes the connection.
   *
   * Limitation: HTTP/1.1 browsers with keep-alive do NOT close the TCP
   * socket when aborting a fetch via AbortController — the connection
   * stays alive for potential reuse. Cancellation of non-streaming
   * server renders (e.g., routes with `await delay()`) is only detected
   * when the client forcefully closes the socket or when using HTTP/2
   * (which sends RST_STREAM). Streaming responses (Suspense) are
   * detected because the browser closes the connection when it stops
   * consuming the chunked response.
   *
   * For HTTP keep-alive, multiple requests share a socket, but each
   * handler has its own `completed` guard in wrapStream, so a late
   * socket close on an already-finished request is harmless.
   *
   * Falls back to c.req.raw.signal for non-Node adapters.
   */
  function getRequestSignal(c: { env: any; req: { raw: Request } }): AbortSignal {
    const incoming = c.env?.incoming;
    if (incoming?.socket) {
      const ac = new AbortController();
      const socket = incoming.socket;
      if (socket.destroyed) {
        ac.abort();
      } else {
        socket.on("close", () => {
          ac.abort();
        });
      }
      return ac.signal;
    }
    return c.req.raw.signal;
  }

  // Set serverModuleMap to null so that react-server-dom-webpack's
  // loadServerReference takes the createBoundServerReference path.
  // This creates lightweight proxies for server actions during SSR
  // without trying to load the actual server modules (which aren't
  // available in the SSR context).
  (manifests.ssrManifest as any).serverModuleMap = null;

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
  const ssrModuleCache: Record<string, unknown> = {};
  (globalThis as any).__webpack_require__ = function ssrRequireModule(moduleId: string) {
    if (ssrModuleCache[moduleId]) return ssrModuleCache[moduleId];

    const fullPath = resolve(buildDir, "server", moduleId);
    const promise = import(fullPath)
      .then((mod: unknown) => {
        ssrModuleCache[moduleId] = mod;
        (promise as any).value = mod;
        (promise as any).status = "fulfilled";
        return mod;
      })
      .catch((err: unknown) => {
        (promise as any).status = "rejected";
        (promise as any).reason = err;
        throw err;
      });

    (promise as any).status = "pending";
    ssrModuleCache[moduleId] = promise;
    return promise;
  };
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

  // MIME type lookup
  const mimeTypes: Record<string, string> = {
    ".js": "application/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  };

  // Static assets from client build
  app.get("/assets/*", async (c) => {
    const filePath = resolve(buildDir, "client", c.req.path.slice(1));
    try {
      const content = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf("."));
      const contentType = mimeTypes[ext] ?? "application/octet-stream";
      return new Response(content, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return new Response("Not Found", { status: 404 });
    }
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
    return handleAction({
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
  });

  // Initial page load: SSR with inlined RSC stream for hydration
  app.get("*", async (c) => {
    const logger = maybeCreateLogger(debugEnabled, hasCallback);
    logger?.time("total");

    const requestSignal = getRequestSignal(c);
    const url = new URL(c.req.url);

    // Render RSC payload (status is determined during rendering —
    // 404 for not-found routes, 500 for error routes, 200 otherwise)
    const {
      stream: rscStream,
      status,
      params,
    } = await doRenderRSC(url, undefined, undefined, logger);

    // Buffer the RSC stream while scanning for client module references
    // in a single pass. Extracts module IDs inline to build a per-page
    // MODULE_MAP containing only the modules used by this page's RSC payload.
    logger?.time("rsc:buffer");
    const pageModuleMap: Record<string, string> = {};
    const moduleRefPattern = /^\d+:I\["([^"]+)"/gm;
    const rscReader = rscStream.getReader();
    const rscChunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let rscText = "";
    while (true) {
      const { done, value } = await rscReader.read();
      if (done) break;
      rscChunks.push(value);
      rscText += decoder.decode(value, { stream: true });
    }
    // Scan the complete text for module references
    let match;
    while ((match = moduleRefPattern.exec(rscText)) !== null) {
      const moduleId = match[1];
      if (fullModuleMap[moduleId]) {
        pageModuleMap[moduleId] = fullModuleMap[moduleId];
      }
    }
    logger?.timeEnd("rsc:buffer");

    // Reconstruct the RSC stream from buffered chunks
    const bufferedRscStream = new ReadableStream({
      start(controller) {
        for (const chunk of rscChunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });

    // Render to HTML via SSR: deserialize RSC stream → React tree → HTML
    // The RSC payload is interleaved as script tags for zero-waterfall hydration
    const htmlStream = await renderSSR({
      rscStream: bufferedRscStream,
      ssrManifest: manifests.ssrManifest,
      clientEntryUrl: manifests.clientEntryUrl,
      cssFiles: manifests.cssFiles,
      moduleMap: pageModuleMap,
      createFromReadableStream,
      renderToReadableStream: domRenderToReadableStream,
      RouterProvider: SSRRouterProvider,
      OutletDepthContext: SSROutletDepthContext,
      createElement,
      StrictMode,
      logger,
    });

    let responseStream: ReadableStream = htmlStream;
    if (logger) {
      responseStream = logger.wrapStream(
        htmlStream,
        `SSR ${maskParams(url.pathname, params)}`,
        (cancelled) => fireRequestComplete(logger, "SSR", url.pathname, status, cancelled),
        "ssr:stream",
        requestSignal,
      );
    }

    return new Response(responseStream, {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
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
export type { RequestTimingEvent, TimingEntry, WorkerOptions } from "../shared/types.js";
