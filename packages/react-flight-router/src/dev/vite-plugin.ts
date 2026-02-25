import type { Plugin, ViteDevServer } from "vite";
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
} from "../shared/types.js";

// Cached RSC runtime - loaded once with react-server condition
let rscRuntimePromise: ReturnType<typeof loadRSCServerRuntime> | null = null;
function getRSCRuntime() {
  if (!rscRuntimePromise) {
    rscRuntimePromise = loadRSCServerRuntime();
  }
  return rscRuntimePromise;
}

interface FlightRouterDevOptions {
  /** Path to the routes file relative to app root */
  routesFile?: string;
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
  const clientModules = new Set<string>();
  const serverModules = new Set<string>();
  const ssrRequireCache: Record<string, unknown> = {};
  let appRoot = "";

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
        // Set up server-side __webpack_require__ for dev SSR deserialization.
        // createFromReadableStream calls this to load client component implementations.
        // Module IDs come from the dev client manifest as Vite URLs:
        //   - Root-relative: /app/routes/counter.client.tsx
        //   - Outside root: /@fs/Users/.../outlet.js
        // We convert these back to absolute file paths for ssrLoadModule.
        (globalThis as any).__webpack_require__ = function ssrRequireModule(moduleId: string) {
          if (ssrRequireCache[moduleId]) return ssrRequireCache[moduleId];

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

          try {
            // RSC endpoint for client-side navigation
            if (url.pathname === RSC_ENDPOINT) {
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

              const { stream } = await devRenderRSC(
                server,
                routesFile,
                targetUrl,
                clientModules,
                appRoot,
                segments,
                previousUrl,
              );
              res.writeHead(200, { "Content-Type": RSC_CONTENT_TYPE });
              await pipeReadableStreamToResponse(stream, res);
              return;
            }

            // Server actions endpoint
            if (url.pathname === ACTION_ENDPOINT && req.method === "POST") {
              const request = await nodeReqToRequest(req, url);
              const routes = await loadRoutes(server, routesFile);

              const rscServerDom = await getRSCRuntime();

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
                  );
                  return stream;
                },
              });

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

            // Initial page load: SSR with inlined RSC stream
            const {
              html: ssrHtml,
              rscStream: inlineStream,
              status,
            } = await devRenderSSR(server, routesFile, url, clientModules, appRoot);

            // Let Vite process HTML (injects HMR client, React Refresh, resolves imports)
            const processedHtml = await server.transformIndexHtml(url.pathname, ssrHtml);

            // Create HTML stream and interleave RSC payload for hydration
            const encoder = new TextEncoder();
            const htmlStream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(processedHtml));
                controller.close();
              },
            });
            const finalStream = interleaveDevRSCPayload(htmlStream, inlineStream);

            res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
            await pipeReadableStreamToResponse(finalStream, res);
          } catch (err) {
            console.error("[react-flight-router dev] Error:", err);
            next(err);
          }
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
): Promise<{ stream: ReadableStream; status: number }> {
  const routes = await loadRoutes(server, routesFile);
  // Load RSC runtime with react-server condition patched
  const rscServerDom = await getRSCRuntime();

  return renderRSC({
    url,
    routes,
    clientManifest: buildDevClientManifest(clientModules, rootDir),
    renderToReadableStream: rscServerDom.renderToReadableStream,
    segments,
    previousUrl,
    loadModule: (id: string) => server.ssrLoadModule(id),
  });
}

/**
 * Render an initial page load with full SSR in dev mode.
 *
 * Flow: RSC stream → tee → deserialize with SSR manifest → React tree →
 * react-dom/server renderToReadableStream → buffer to HTML string →
 * inject client entry script → return HTML + RSC stream for inlining.
 */
async function devRenderSSR(
  server: ViteDevServer,
  routesFile: string,
  url: URL,
  clientModules: Set<string>,
  appRoot: string,
): Promise<{ html: string; rscStream: ReadableStream; status: number }> {
  // 1. Render RSC stream and tee: one for SSR deserialization, one for client inlining
  const { stream: rscStream, status: rscStatus } = await devRenderRSC(
    server,
    routesFile,
    url,
    clientModules,
    appRoot,
  );
  const [streamForSSR, streamForInline] = rscStream.tee();

  // 2. Load SSR dependencies (externalized CJS packages — direct import works)
  const rscClientNode = (await import("react-server-dom-webpack/client.node")) as any;
  const { createFromReadableStream } = rscClientNode;
  const reactDomServer = (await import("react-dom/server")) as any;
  const { renderToReadableStream: domRenderToReadableStream } = reactDomServer;
  const React = (await import("react")) as any;
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
  const payload = (await createFromReadableStream(streamForSSR, {
    serverConsumerManifest: devSSRManifest,
  })) as RSCPayload;

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
  const bootstrapScript = `
    window.__SSR__ = true;
    window.__MODULE_MAP__ = {};
    window.__RSC_CHUNKS__ = [];
    window.__RSC_STREAM_CONTROLLER__ = null;
    window.__RSC_STREAM__ = new ReadableStream({
      start(controller) {
        window.__RSC_STREAM_CONTROLLER__ = controller;
        window.__RSC_CHUNKS__.forEach(function(c) {
          controller.enqueue(new TextEncoder().encode(c));
        });
        delete window.__RSC_CHUNKS__;
      }
    });
    window.__RSC_PUSH__ = function(chunk) {
      if (window.__RSC_STREAM_CONTROLLER__) {
        window.__RSC_STREAM_CONTROLLER__.enqueue(new TextEncoder().encode(chunk));
      } else {
        window.__RSC_CHUNKS__.push(chunk);
      }
    };
    window.__RSC_CLOSE__ = function() {
      if (window.__RSC_STREAM_CONTROLLER__) {
        window.__RSC_STREAM_CONTROLLER__.close();
      }
    };
  `.replace(/\n\s+/g, "");

  // 8. Render the React tree to an HTML stream
  const htmlStream = await domRenderToReadableStream(app, {
    bootstrapScriptContent: bootstrapScript,
    onError: (err: unknown) => console.error("[react-flight-router] Dev SSR error:", err),
  });

  // 9. Buffer HTML stream to string
  const htmlReader = htmlStream.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (true) {
    const { done, value } = await htmlReader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }

  // 10. Collect CSS files from the SSR module graph and inject <link> tags.
  // After RSC rendering, all route modules (and their CSS imports) are loaded.
  const cssUrls = collectDevCssUrls(server);
  if (cssUrls.length > 0) {
    const cssLinks = cssUrls.map((u: string) => `<link rel="stylesheet" href="${u}">`).join("");
    html = html.replace("</head>", cssLinks + "</head>");
  }

  // 11. Insert client entry script before </body> — transformIndexHtml will
  // resolve the bare import and inject the Vite HMR client
  html = html.replace(
    "</body>",
    '<script type="module">import "react-flight-router/client/entry";</script>\n</body>',
  );

  return { html, rscStream: streamForInline, status: rscStatus };
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
      controller.enqueue(value);
      while (rscChunks.length > 0) {
        const chunk = rscChunks.shift()!;
        controller.enqueue(
          encoder.encode(`<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`),
        );
      }
    },
  });
}

async function pipeReadableStreamToResponse(
  stream: ReadableStream,
  res: import("http").ServerResponse,
): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
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
