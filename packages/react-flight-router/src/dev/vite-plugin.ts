import type { Plugin, ViteDevServer } from "vite";
import { createRequire } from "module";
import { resolve } from "path";
import { useClientPlugin, getModuleId } from "../build/plugin-use-client.js";
import { useServerPlugin } from "../build/plugin-use-server.js";
import { renderRSC } from "../server/rsc-renderer.js";
import { handleAction } from "../server/action-handler.js";
import { loadRSCServerRuntime } from "./react-server-loader.js";
import {
  RSC_CONTENT_TYPE,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_PREVIOUS_SEGMENTS_HEADER,
  RSC_PREVIOUS_URL_HEADER,
} from "../shared/constants.js";
import type { RouteConfig } from "../router/types.js";
import type {
  RSCClientManifest,
  ServerActionsManifest,
  SSRManifest,
  RSCPayload,
  RequestTimingEvent,
} from "../shared/types.js";
import {
  maybeCreateLogger,
  maskParams,
  type FlightTimer,
  type FlightLogger,
} from "../shared/logger.js";
import { generateBootstrapScript } from "../shared/bootstrap-script.js";
import { requestStorage } from "../server/request-context.js";

// Cached RSC runtime - loaded once with react-server condition
let rscRuntimePromise: ReturnType<typeof loadRSCServerRuntime> | null = null;
function getRSCRuntime(appRoot: string) {
  if (!rscRuntimePromise) {
    rscRuntimePromise = loadRSCServerRuntime(appRoot);
  }
  return rscRuntimePromise;
}

interface FlightRouterDevOptions {
  /** Path to the routes file relative to app root */
  routesFile?: string;
  /** Enable performance timing output. Also enabled via FLIGHT_DEBUG=1 env var. */
  debug?: boolean;
  /**
   * Called before each RSC/SSR render with the incoming Request.
   * Use this to set up per-request context (e.g., AsyncLocalStorage)
   * that server components can read during rendering.
   */
  onRequest?: (request: Request) => void;
  /**
   * Called after each RSC/SSR/action request completes with structured timing data.
   * Works independently of `debug` — when `debug` is false, timing is still collected
   * but not printed to stderr. Use this to build monitoring dashboards, send metrics
   * to observability services, or log performance data in your own format.
   */
  onRequestComplete?: (event: RequestTimingEvent) => void;
}

/**
 * Vite plugin for react-flight-router dev mode.
 *
 * Registers middleware on Vite's dev server to handle:
 * - RSC rendering (via ssrLoadModule with react-server conditions)
 * - SSR rendering (via ssrLoadModule for HTML generation)
 * - Server actions
 * - Client modules served directly by Vite (with HMR)
 */
export function flightRouter(opts?: FlightRouterDevOptions): Plugin[] {
  const routesFile = opts?.routesFile ?? "./app/routes.ts";
  const debugEnabled = opts?.debug;
  const onRequestComplete = opts?.onRequestComplete;
  const hasCallback = !!onRequestComplete;
  const clientModules = new Set<string>();
  const serverModules = new Set<string>();
  const ssrRequireCache: Record<string, unknown> = {};
  const MAX_SSR_CACHE_SIZE = 500;
  let appRoot = "";

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

  return [
    // Transform 'use client' files: RSC proxies for SSR, pass-through for client
    useClientPlugin({
      mode: "auto",
      onClientModule: (id) => clientModules.add(id),
    }),
    // Transform 'use server' files: register for SSR, stubs for client
    useServerPlugin({
      mode: "auto",
      onServerModule: (id) => serverModules.add(id),
    }),
    // Resolve virtual:rsc-runtime for dev mode.
    // The use-client and use-server plugins transform modules to import from
    // virtual:rsc-runtime. In production builds, rscRuntimePlugin provides it.
    // In dev, we resolve it to the CJS package directly (which is externalized).
    {
      name: "react-flight-router:dev-rsc-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === "virtual:rsc-runtime") return "\0virtual:rsc-runtime";
      },
      load(id) {
        if (id === "\0virtual:rsc-runtime") {
          return `export { registerClientReference, registerServerReference } from 'react-server-dom-webpack/server.node';`;
        }
      },
    },
    // Main dev server plugin
    {
      name: "react-flight-router:dev",
      enforce: "post",

      config() {
        return {
          resolve: {
            // Force Vite to resolve react/react-dom from the app root, even
            // when imported from linked packages (pnpm monorepo/link setups).
            // Without this, linked packages resolve their own copies of React,
            // causing "multiple React instances" / "Cannot read useState" errors.
            dedupe: [
              "react",
              "react/jsx-runtime",
              "react/jsx-dev-runtime",
              "react-dom",
              "react-dom/server",
              "react-dom/client",
              "react-server-dom-webpack",
              "react-server-dom-webpack/client.browser",
              "react-server-dom-webpack/client.node",
              "react-server-dom-webpack/server.node",
            ],
          },
          ssr: {
            // Externalize CJS packages so they're loaded natively via require()
            external: [
              "react-server-dom-webpack",
              "react-server-dom-webpack/server.node",
              "react-server-dom-webpack/client.node",
              "react-server-dom-webpack/client.browser",
              "react",
              "react/jsx-runtime",
              "react/jsx-dev-runtime",
              "react-dom",
              "react-dom/server",
              "react-dom/client",
            ],
            // Process react-flight-router through Vite's pipeline so use-client plugin runs
            noExternal: ["react-flight-router"],
          },
          // Ensure CJS deps are pre-bundled for browser with proper ESM wrappers
          optimizeDeps: {
            include: [
              "react",
              "react/jsx-runtime",
              "react/jsx-dev-runtime",
              "react-dom",
              "react-dom/client",
              "react-server-dom-webpack/client.browser",
            ],
            // Don't pre-bundle react-flight-router - its modules must share the same
            // instances (esp. React Context) with modules loaded via __webpack_require__
            exclude: ["react-flight-router"],
          },
        };
      },

      configResolved(config) {
        appRoot = config.root;
      },

      configureServer(server: ViteDevServer) {
        // Provide __non_webpack_require__ so native-binding packages (e.g. better-sqlite3)
        // that detect __webpack_require__ don't crash looking for this companion global.
        const appRequireForNative = createRequire(
          resolve(appRoot || process.cwd(), "package.json"),
        );
        (globalThis as any).__non_webpack_require__ = appRequireForNative;

        // Set up server-side __webpack_require__ for dev SSR deserialization.
        // createFromReadableStream calls this to load client component implementations.
        // Module IDs come from the dev client manifest as Vite URLs:
        //   - Root-relative: /app/routes/counter.client.tsx
        //   - Outside root: /@fs/Users/.../outlet.js
        // We convert these back to absolute file paths for ssrLoadModule.
        (globalThis as any).__webpack_require__ = function ssrRequireModule(moduleId: string) {
          if (ssrRequireCache[moduleId]) return ssrRequireCache[moduleId];

          // Prune cache if it grows too large during long dev sessions
          const cacheKeys = Object.keys(ssrRequireCache);
          if (cacheKeys.length > MAX_SSR_CACHE_SIZE) {
            const deleteCount = Math.floor(cacheKeys.length / 2);
            for (let i = 0; i < deleteCount; i++) {
              delete ssrRequireCache[cacheKeys[i]];
            }
          }

          // Convert Vite URL to absolute file path
          let filePath = moduleId;
          if (filePath.startsWith("/@fs/")) {
            filePath = filePath.slice(4); // /@fs/Users/... → /Users/...
          } else if (filePath.startsWith("/") && !filePath.startsWith(appRoot)) {
            filePath = appRoot + filePath; // /app/routes/... → <appRoot>/app/routes/...
          }

          const ssrId = filePath + (filePath.includes("?") ? "&ssr" : "?ssr");
          const promise = server
            .ssrLoadModule(ssrId)
            .then((mod: unknown) => {
              ssrRequireCache[moduleId] = mod;
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
          ssrRequireCache[moduleId] = promise;
          return promise;
        };
        (globalThis as any).__webpack_chunk_load__ = () => Promise.resolve();

        // Add middleware for RSC, SSR, and actions
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

          // Build a lightweight Request for the framework-managed context and user hook.
          const request = nodeReqToFastRequest(req, url);

          // Call onRequest hook before rendering so consumers can set up
          // additional per-request context beyond the built-in getRequest().
          if (opts?.onRequest) {
            opts.onRequest(request);
          }

          // Wrap the entire request handling in requestStorage.run() so that
          // getRequest() works automatically in dev mode — matching production behavior.
          return requestStorage.run(request, async () => {
            try {
              // RSC endpoint for client-side navigation
              if (url.pathname === RSC_ENDPOINT) {
                const logger = maybeCreateLogger(debugEnabled, hasCallback);
                logger?.time("total");

                // Capture the abort signal early — before the (potentially slow) render.
                // If the client disconnects during rendering, the signal is already listening.
                const reqAbort = new AbortController();
                res.on("close", () => {
                  if (!res.writableFinished) reqAbort.abort();
                });

                const targetPath = url.searchParams.get("url") ?? "/";
                const targetUrl = new URL(targetPath, url.origin);
                const prevSegments = req.headers[RSC_PREVIOUS_SEGMENTS_HEADER.toLowerCase()] as
                  | string
                  | undefined;
                const segments = prevSegments ? prevSegments.split(",") : undefined;

                const prevUrlHeader = req.headers[RSC_PREVIOUS_URL_HEADER.toLowerCase()] as
                  | string
                  | undefined;
                const previousUrl = prevUrlHeader ? new URL(prevUrlHeader, url.origin) : undefined;

                // Send response headers immediately so the connection is active
                // before the render completes. This allows cancellation detection
                // for slow server renders (e.g., `await delay(3000)` in a component),
                // not just streaming Suspense responses. Without this, HTTP/1.1
                // keep-alive keeps the connection alive for pending requests whose
                // headers haven't been sent, making res "close" with writableFinished=true.
                res.writeHead(200, { "Content-Type": RSC_CONTENT_TYPE });

                try {
                  let { stream, params } = await devRenderRSC(
                    server,
                    routesFile,
                    targetUrl,
                    clientModules,
                    appRoot,
                    segments,
                    previousUrl,
                    logger,
                  );

                  if (logger) {
                    stream = logger.wrapStream(
                      stream,
                      `RSC ${maskParams(targetUrl.pathname, params)} (dev)`,
                      (cancelled) =>
                        fireRequestComplete(logger, "RSC", targetUrl.pathname, 200, cancelled),
                      "rsc:stream",
                      reqAbort.signal,
                    );
                  }

                  await pipeReadableStreamToResponse(stream, res);
                } catch (err) {
                  // Headers already sent so we can't change the status code.
                  // Just log the error and end the response.
                  console.error("[react-flight-router dev] RSC error:", err);
                  if (!res.writableFinished) res.end();
                }
                return;
              }

              // Server actions endpoint
              if (url.pathname === ACTION_ENDPOINT && req.method === "POST") {
                const logger = maybeCreateLogger(debugEnabled, hasCallback);
                logger?.time("total");

                const request = await nodeReqToRequest(req, url);
                const actionUrl = new URL((req.headers.referer as string) ?? "/", url.origin);
                const routes = await loadRoutes(server, routesFile);

                const rscServerDom = await getRSCRuntime(appRoot);

                // Create an abort signal that fires when the client disconnects.
                const actionAbort = new AbortController();
                res.on("close", () => {
                  if (!res.writableFinished) actionAbort.abort();
                });

                const response = await handleAction({
                  request,
                  routes,
                  serverActionsManifest: buildDevServerActionsManifest(serverModules),
                  clientManifest: buildDevClientManifest(clientModules, appRoot),
                  loadModule: (id: string) => server.ssrLoadModule(id),
                  decodeReply: rscServerDom.decodeReply,
                  renderToReadableStream: rscServerDom.renderToReadableStream,
                  renderRSC: async (rscUrl, segs) => {
                    const { stream } = await devRenderRSC(
                      server,
                      routesFile,
                      rscUrl,
                      clientModules,
                      appRoot,
                      segs,
                      undefined,
                      logger,
                    );
                    return stream;
                  },
                  logger,
                  onComplete: (status, cancelled) => {
                    if (logger)
                      fireRequestComplete(logger, "ACTION", actionUrl.pathname, status, cancelled);
                  },
                  requestSignal: actionAbort.signal,
                });

                // Timing is flushed by logger.wrapStream() inside handleAction
                res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
                if (response.body) {
                  await pipeReadableStreamToResponse(response.body, res);
                } else {
                  res.end();
                }
                return;
              }

              // Skip Vite internal paths, static assets, and virtual modules
              if (
                url.pathname.startsWith("/@") ||
                url.pathname.startsWith("/node_modules") ||
                url.pathname.startsWith("/assets") ||
                url.pathname.includes(".")
              ) {
                return next();
              }

              // Initial page load: SSR with inlined RSC stream (streaming Suspense)
              const logger = maybeCreateLogger(debugEnabled, hasCallback);
              logger?.time("total");

              // Capture the abort signal early — before the (potentially slow) render.
              const ssrAbort = new AbortController();
              res.on("close", () => {
                if (!res.writableFinished) ssrAbort.abort();
              });

              const {
                htmlStream: ssrHtmlStream,
                rscStream: inlineStream,
                cssUrls,
                status,
                params: ssrParams,
              } = await devRenderSSR(server, routesFile, url, clientModules, appRoot, logger);

              // Get Vite's head injections (HMR client, React Refresh preamble)
              // by processing a minimal HTML stub through Vite's plugin pipeline.
              const viteStub = await server.transformIndexHtml(
                url.pathname,
                "<!DOCTYPE html><html><head></head><body></body></html>",
              );
              const viteHeadStart = viteStub.indexOf("<head>") + 6;
              const viteHeadEnd = viteStub.indexOf("</head>");
              const viteHeadContent =
                viteHeadStart > 5 && viteHeadEnd > viteHeadStart
                  ? viteStub.slice(viteHeadStart, viteHeadEnd)
                  : "";

              // Resolve client entry module to a browser-requestable URL
              const clientEntryResolved = await server.pluginContainer.resolveId(
                "react-flight-router/client/entry",
              );
              let clientEntryUrl: string;
              if (clientEntryResolved?.id) {
                const id = clientEntryResolved.id;
                clientEntryUrl = id.startsWith(appRoot) ? id.slice(appRoot.length) : "/@fs" + id;
              } else {
                clientEntryUrl = "/node_modules/react-flight-router/dist/client/entry.js";
              }

              // Build head injection: CSS links + Vite scripts + client entry
              const cssLinks = cssUrls
                .map((u: string) => `<link rel="stylesheet" href="${u}">`)
                .join("");
              const headInjection =
                cssLinks +
                viteHeadContent +
                `\n<script type="module" src="${clientEntryUrl}"></script>`;

              // Streaming pipeline: inject into <head>, then interleave RSC payload.
              // The HTML stream is NOT buffered — Suspense fallbacks are sent immediately,
              // and resolved content streams in as async components complete.
              const injectedStream = injectIntoHead(ssrHtmlStream, headInjection);
              let finalStream = interleaveDevRSCPayload(injectedStream, inlineStream);

              if (logger) {
                finalStream = logger.wrapStream(
                  finalStream,
                  `SSR ${maskParams(url.pathname, ssrParams)} (dev)`,
                  (cancelled) =>
                    fireRequestComplete(logger, "SSR", url.pathname, status, cancelled),
                  "ssr:stream",
                  ssrAbort.signal,
                );
              }

              res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
              await pipeReadableStreamToResponse(finalStream, res);
            } catch (err) {
              console.error("[react-flight-router dev] Error:", err);
              next(err);
            }
          }); // end requestStorage.run()
        });
      },

      // HMR: when server components change, notify clients to revalidate
      handleHotUpdate({ file, server }) {
        if (!file.includes("node_modules")) {
          // Clear SSR module cache so next request loads fresh modules
          for (const key of Object.keys(ssrRequireCache)) {
            delete ssrRequireCache[key];
          }
          if (!file.includes(".client.")) {
            server.ws.send({ type: "custom", event: "react-flight-router:invalidate" });
          }
        }
      },
    },
  ];
}

async function loadRoutes(server: ViteDevServer, routesFile: string): Promise<RouteConfig[]> {
  const mod = await server.ssrLoadModule(routesFile);
  return mod.routes;
}

async function devRenderRSC(
  server: ViteDevServer,
  routesFile: string,
  url: URL,
  clientModules: Set<string>,
  rootDir: string,
  segments?: string[],
  previousUrl?: URL,
  logger?: FlightLogger,
): Promise<{ stream: ReadableStream; status: number; params: Record<string, string> }> {
  logger?.time("loadRoutes");
  const routes = await loadRoutes(server, routesFile);
  logger?.timeEnd("loadRoutes");

  // Load RSC runtime with react-server condition patched
  const rscServerDom = await getRSCRuntime(rootDir);

  return renderRSC({
    url,
    routes,
    clientManifest: buildDevClientManifest(clientModules, rootDir),
    renderToReadableStream: rscServerDom.renderToReadableStream,
    segments,
    previousUrl,
    loadModule: (id: string) => server.ssrLoadModule(id),
    logger,
  });
}

/**
 * Render an initial page load with full SSR in dev mode.
 *
 * Flow: RSC stream → tee → deserialize with SSR manifest → React tree →
 * react-dom/server renderToReadableStream → stream HTML with injections.
 *
 * The HTML stream is NOT buffered — Suspense fallbacks are sent immediately
 * and resolved content is streamed in as async server components complete.
 */
async function devRenderSSR(
  server: ViteDevServer,
  routesFile: string,
  url: URL,
  clientModules: Set<string>,
  appRoot: string,
  logger?: FlightLogger,
): Promise<{
  htmlStream: ReadableStream;
  rscStream: ReadableStream;
  cssUrls: string[];
  status: number;
  params: Record<string, string>;
}> {
  // 1. Render RSC stream and tee: one for SSR deserialization, one for client inlining
  const {
    stream: rscStream,
    status: rscStatus,
    params,
  } = await devRenderRSC(
    server,
    routesFile,
    url,
    clientModules,
    appRoot,
    undefined,
    undefined,
    logger,
  );
  const [streamForSSR, streamForInline] = rscStream.tee();

  // 2. Load SSR dependencies from the app's node_modules (not react-flight-router's).
  // With pnpm linked packages, bare imports here would resolve to react-flight-router's
  // own copies of react/react-dom, causing "multiple React instances" errors.
  const appRequire = createRequire(resolve(appRoot, "package.json"));
  const rscClientNode = appRequire("react-server-dom-webpack/client.node") as any;
  const { createFromReadableStream } = rscClientNode;
  const reactDomServer = appRequire("react-dom/server") as any;
  const { renderToReadableStream: domRenderToReadableStream } = reactDomServer;
  const React = appRequire("react") as any;
  const { createElement, StrictMode } = React;

  // 3. Load RouterProvider + OutletDepthContext via ssrLoadModule with ?ssr query.
  // The use-client plugin's resolveId hook propagates ?ssr to transitive imports,
  // so router-context.js also gets ?ssr and keeps real code (not proxies).
  const clientResolved = await server.pluginContainer.resolveId("react-flight-router/client");
  if (!clientResolved)
    throw new Error("[react-flight-router] Could not resolve react-flight-router/client");
  const routerCtx = (await server.ssrLoadModule(clientResolved.id + "?ssr")) as any;
  const { RouterProvider, OutletDepthContext } = routerCtx;
  // 4. Build dev SSR manifest (Proxy-based, like the client manifest)
  // Maps module IDs from the RSC stream to loadable paths for __webpack_require__
  const devSSRManifest: SSRManifest = {
    moduleMap: new Proxy({} as any, {
      get(_target: any, moduleId: string) {
        if (typeof moduleId !== "string") return undefined;
        return new Proxy({} as any, {
          get(_t: any, exportName: string) {
            if (typeof exportName !== "string") return undefined;
            return { id: moduleId, chunks: [], name: exportName };
          },
        });
      },
    }),
    serverModuleMap: {},
    moduleLoading: null,
  };

  // 5. Deserialize RSC stream into React elements (with real client components via SSR manifest)
  logger?.time("ssr:deserializeRSC");
  const payload = (await createFromReadableStream(streamForSSR, {
    serverConsumerManifest: devSSRManifest,
  })) as RSCPayload;
  logger?.timeEnd("ssr:deserializeRSC");

  // 6. Build the React tree matching client entry.tsx structure
  const rootKey = Object.keys(payload.segments)[0] ?? "";
  const RootSegment = payload.segments[rootKey];
  const noopCallServer = () => Promise.resolve(undefined);
  const noopCreateFromReadableStream = () => Promise.resolve({} as any);

  const app = createElement(
    StrictMode,
    null,
    createElement(
      RouterProvider,
      {
        initialUrl: payload.url,
        initialSegments: payload.segments,
        initialParams: payload.params ?? {},
        initialBoundaryComponents: payload.boundaryComponents,
        createFromReadableStream: noopCreateFromReadableStream,
        callServer: noopCallServer,
      },
      createElement(
        OutletDepthContext.Provider,
        { value: { segmentKey: rootKey, depth: 0 } },
        RootSegment,
      ),
    ),
  );

  // 7. Generate bootstrap script (RSC stream setup + SSR flag)
  const bootstrapScript = generateBootstrapScript();

  // 8. Render the React tree to an HTML stream (NOT buffered — streams Suspense)
  logger?.time("ssr:renderToHTML");
  const htmlStream = await domRenderToReadableStream(app, {
    bootstrapScriptContent: bootstrapScript,
    onError: (err: unknown) => console.error("[react-flight-router] Dev SSR error:", err),
  });
  logger?.timeEnd("ssr:renderToHTML");

  // 9. Collect CSS files from the SSR module graph.
  // After RSC rendering, all route modules (and their CSS imports) are loaded.
  const cssUrls = collectDevCssUrls(server);

  return { htmlStream, rscStream: streamForInline, status: rscStatus, params, cssUrls };
}

/**
 * In dev mode, the client manifest uses a Proxy for lazy lookup.
 * This solves the timing issue where modules are discovered during rendering
 * (after the manifest is passed to renderToReadableStream).
 */
function buildDevClientManifest(clientModules: Set<string>, rootDir: string): RSCClientManifest {
  return new Proxy({} as RSCClientManifest, {
    get(_target, key: string) {
      if (typeof key !== "string") return undefined;
      for (const mod of clientModules) {
        const moduleId = getModuleId(mod);
        if (moduleId === key) {
          const viteUrl = mod.startsWith(rootDir) ? mod.slice(rootDir.length) : "/@fs" + mod;
          return {
            id: viteUrl,
            chunks: [viteUrl],
            name: "*",
            async: true,
          };
        }
      }
      return undefined;
    },
  });
}

/**
 * Build a Proxy-based server actions manifest for dev mode.
 * React's decodeAction looks up by full action ID ("moduleId#exportName").
 * We dynamically match against known server modules.
 */
function buildDevServerActionsManifest(serverModules: Set<string>): ServerActionsManifest {
  return new Proxy({} as ServerActionsManifest, {
    get(_target, key: string) {
      if (typeof key !== "string") return undefined;
      // key is "moduleId#exportName" (e.g., "app/routes/actions#addMessage")
      const hashIndex = key.indexOf("#");
      const moduleKey = hashIndex !== -1 ? key.slice(0, hashIndex) : key;
      const exportName = hashIndex !== -1 ? key.slice(hashIndex + 1) : "*";

      for (const mod of serverModules) {
        const moduleId = getModuleId(mod);
        if (moduleId === moduleKey) {
          return { id: mod, name: exportName, chunks: [] };
        }
      }
      return undefined;
    },
  });
}

/**
 * Collect CSS URLs from the SSR module graph.
 * After route modules are loaded via ssrLoadModule, their CSS imports
 * appear in the module graph. We inject <link> tags for these into the SSR HTML.
 */
function collectDevCssUrls(server: ViteDevServer): string[] {
  const cssUrls: string[] = [];

  // Vite 7: per-environment module graphs
  const ssrEnv = (server as any).environments?.ssr;
  if (!ssrEnv?.moduleGraph) return cssUrls;

  for (const [url] of ssrEnv.moduleGraph.urlToModuleMap) {
    if (/\.css(\?.*)?$/.test(url)) {
      const cleanUrl = url.replace(/[?&]ssr\b/, "");
      if (!cssUrls.includes(cleanUrl)) {
        cssUrls.push(cleanUrl);
      }
    }
  }

  return cssUrls;
}

/**
 * Streaming transform that injects content before </head> in an HTML stream.
 * Only the <head> portion is buffered (small, synchronous). Everything after
 * (including Suspense-streamed body content) passes through without buffering.
 */
function injectIntoHead(htmlStream: ReadableStream, injection: string): ReadableStream {
  const reader = htmlStream.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let injected = false;

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();

      if (done) {
        // Stream ended — flush any remaining buffer
        if (buffer) {
          controller.enqueue(encoder.encode(buffer));
          buffer = "";
        }
        controller.close();
        return;
      }

      if (injected) {
        // After injection, pass through all chunks directly (streaming Suspense content)
        controller.enqueue(value);
        return;
      }

      // Buffer until we find </head> (typically arrives in the first chunk)
      buffer += decoder.decode(value, { stream: true });
      const headCloseIdx = buffer.indexOf("</head>");
      if (headCloseIdx !== -1) {
        const result = buffer.slice(0, headCloseIdx) + injection + buffer.slice(headCloseIdx);
        controller.enqueue(encoder.encode(result));
        buffer = "";
        injected = true;
      }
      // If </head> not found yet, keep buffering (only the <head> which is small)
    },
  });
}

function interleaveDevRSCPayload(
  htmlStream: ReadableStream,
  rscStream: ReadableStream,
): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rscReader = rscStream.getReader();
  const htmlReader = htmlStream.getReader();
  const rscChunks: string[] = [];
  let rscDone = false;

  // Start reading RSC in background
  const readRSC = async () => {
    try {
      while (true) {
        const { done, value } = await rscReader.read();
        if (done) {
          rscDone = true;
          break;
        }
        rscChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      rscDone = true;
    }
  };
  readRSC();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await htmlReader.read();
      if (done) {
        // Wait for RSC to finish and flush
        while (!rscDone) await new Promise((r) => setTimeout(r, 10));
        for (const chunk of rscChunks) {
          controller.enqueue(
            encoder.encode(`<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`),
          );
        }
        rscChunks.length = 0;
        controller.enqueue(encoder.encode(`<script>window.__RSC_CLOSE__()</script>`));
        controller.close();
        return;
      }
      // Pass through HTML chunk as-is.
      // Do NOT inject RSC scripts between HTML chunks — chunk boundaries
      // can fall inside elements like <script> or <style>, where injected
      // <script> tags would break the document structure. RSC data is
      // flushed after the HTML stream ends (the bootstrap script that
      // defines __RSC_PUSH__ may not have been sent yet either).
      controller.enqueue(value);
    },
  });
}

async function pipeReadableStreamToResponse(
  stream: ReadableStream,
  res: import("http").ServerResponse,
): Promise<void> {
  const reader = stream.getReader();
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    reader.cancel().catch(() => {});
  };
  res.on("close", onClose);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || clientGone) break;
      res.write(value);
    }
  } finally {
    res.off("close", onClose);
    res.end();
  }
}

/**
 * Build a lightweight Request from a Node.js IncomingMessage (headers only, no body).
 * Used by the onRequest hook where consumers only need headers/cookies.
 */
function nodeReqToFastRequest(req: import("http").IncomingMessage, url: URL): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return new Request(url, { method: req.method ?? "GET", headers });
}

async function nodeReqToRequest(req: import("http").IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  let body: BodyInit | null = null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    body = merged;
  }

  return new Request(url.toString(), {
    method: req.method,
    headers,
    body,
  });
}

export default flightRouter;
