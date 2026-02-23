import type { Plugin, ViteDevServer } from 'vite';
import { useClientPlugin, getModuleId } from '../build/plugin-use-client.js';
import { useServerPlugin } from '../build/plugin-use-server.js';
import { renderRSC } from '../server/rsc-renderer.js';
import { handleAction } from '../server/action-handler.js';
import { loadRSCServerRuntime } from './react-server-loader.js';
import {
  RSC_CONTENT_TYPE,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_PREVIOUS_SEGMENTS_HEADER,
} from '../shared/constants.js';
import type { RouteConfig } from '../router/types.js';
import type { RSCClientManifest, ServerActionsManifest } from '../shared/types.js';

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
 * Vite plugin for flight-router dev mode.
 *
 * Registers middleware on Vite's dev server to handle:
 * - RSC rendering (via ssrLoadModule with react-server conditions)
 * - SSR rendering (via ssrLoadModule for HTML generation)
 * - Server actions
 * - Client modules served directly by Vite (with HMR)
 */
export function flightRouter(opts?: FlightRouterDevOptions): Plugin[] {
  const routesFile = opts?.routesFile ?? './app/routes.ts';
  const clientModules = new Set<string>();
  const serverModules = new Set<string>();
  let appRoot = '';

  return [
    // Transform 'use client' files: RSC proxies for SSR, pass-through for client
    useClientPlugin({
      mode: 'auto',
      onClientModule: (id) => clientModules.add(id),
    }),
    // Transform 'use server' files: register for SSR, stubs for client
    useServerPlugin({
      mode: 'auto',
      onServerModule: (id) => serverModules.add(id),
    }),
    // Main dev server plugin
    {
      name: 'flight-router:dev',
      enforce: 'post',

      config() {
        return {
          ssr: {
            // Externalize CJS packages so they're loaded natively via require()
            external: [
              'react-server-dom-webpack',
              'react-server-dom-webpack/server.node',
              'react-server-dom-webpack/client.node',
              'react-server-dom-webpack/client.browser',
              'react',
              'react/jsx-runtime',
              'react/jsx-dev-runtime',
              'react-dom',
              'react-dom/server',
              'react-dom/client',
            ],
            // Process flight-router through Vite's pipeline so use-client plugin runs
            noExternal: ['flight-router'],
          },
          // Ensure CJS deps are pre-bundled for browser with proper ESM wrappers
          optimizeDeps: {
            include: [
              'react',
              'react/jsx-runtime',
              'react/jsx-dev-runtime',
              'react-dom',
              'react-dom/client',
              'react-server-dom-webpack/client.browser',
            ],
            // Don't pre-bundle flight-router - its modules must share the same
            // instances (esp. React Context) with modules loaded via __webpack_require__
            exclude: ['flight-router'],
          },
        };
      },

      configResolved(config) {
        appRoot = config.root;
      },

      configureServer(server: ViteDevServer) {
        // Add middleware for RSC, SSR, and actions
        server.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

          try {
            // RSC endpoint for client-side navigation
            if (url.pathname === RSC_ENDPOINT) {
              const targetPath = url.searchParams.get('url') ?? '/';
              const targetUrl = new URL(targetPath, url.origin);
              const prevSegments = req.headers[RSC_PREVIOUS_SEGMENTS_HEADER.toLowerCase()] as string | undefined;
              const segments = prevSegments ? prevSegments.split(',') : undefined;

              const stream = await devRenderRSC(server, routesFile, targetUrl, clientModules, appRoot, segments);
              res.writeHead(200, { 'Content-Type': RSC_CONTENT_TYPE });
              await pipeReadableStreamToResponse(stream, res);
              return;
            }

            // Server actions endpoint
            if (url.pathname === ACTION_ENDPOINT && req.method === 'POST') {
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
                renderRSC: (rscUrl, segs) => devRenderRSC(server, routesFile, rscUrl, clientModules, appRoot, segs),
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
              url.pathname.startsWith('/@') ||
              url.pathname.startsWith('/node_modules') ||
              url.pathname.startsWith('/assets') ||
              url.pathname.includes('.')
            ) {
              return next();
            }

            // Initial page load: send shell HTML with inlined RSC stream
            // Client-side rendering with inlined RSC data (no SSR waterfall)
            const rscStream = await devRenderRSC(server, routesFile, url, clientModules, appRoot);

            // Generate shell HTML and let Vite process it (resolves module imports, injects HMR client)
            const rawHtml = generateDevShellHtml();
            const shellHtml = await server.transformIndexHtml(url.pathname, rawHtml);
            const encoder = new TextEncoder();
            const shellStream = new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(shellHtml));
                controller.close();
              },
            });

            const finalStream = interleaveDevRSCPayload(shellStream, rscStream);

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            await pipeReadableStreamToResponse(finalStream, res);
          } catch (err) {
            console.error('[flight-router dev] Error:', err);
            next(err);
          }
        });
      },

      // HMR: when server components change, notify clients to revalidate
      handleHotUpdate({ file, server }) {
        if (!file.includes('node_modules') && !file.includes('.client.')) {
          server.ws.send({ type: 'custom', event: 'flight-router:invalidate' });
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
): Promise<ReadableStream> {
  const routes = await loadRoutes(server, routesFile);
  // Load RSC runtime with react-server condition patched
  const rscServerDom = await getRSCRuntime();

  return renderRSC({
    url,
    routes,
    clientManifest: buildDevClientManifest(clientModules, rootDir),
    renderToReadableStream: rscServerDom.renderToReadableStream,
    segments,
    loadModule: (id: string) => server.ssrLoadModule(id),
  });
}

/**
 * In dev mode, the client manifest uses a Proxy for lazy lookup.
 * This solves the timing issue where modules are discovered during rendering
 * (after the manifest is passed to renderToReadableStream).
 */
function buildDevClientManifest(clientModules: Set<string>, rootDir: string): RSCClientManifest {
  return new Proxy({} as RSCClientManifest, {
    get(_target, key: string) {
      if (typeof key !== 'string') return undefined;
      for (const mod of clientModules) {
        const moduleId = getModuleId(mod);
        if (moduleId === key) {
          const viteUrl = mod.startsWith(rootDir)
            ? mod.slice(rootDir.length)
            : '/@fs' + mod;
          return {
            id: viteUrl,
            chunks: [viteUrl],
            name: '*',
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
      if (typeof key !== 'string') return undefined;
      // key is "moduleId#exportName" (e.g., "app/routes/actions#addMessage")
      const hashIndex = key.indexOf('#');
      const moduleKey = hashIndex !== -1 ? key.slice(0, hashIndex) : key;
      const exportName = hashIndex !== -1 ? key.slice(hashIndex + 1) : '*';

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

function generateDevShellHtml(): string {
  const bootstrapScript = `
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
  `.replace(/\n\s+/g, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flight Router</title>
  <script>${bootstrapScript}</script>
</head>
<body>
  <div id="root"></div>
  <script type="module">import "flight-router/client/entry";</script>
</body>
</html>`;
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
        if (done) { rscDone = true; break; }
        rscChunks.push(decoder.decode(value, { stream: true }));
      }
    } catch { rscDone = true; }
  };
  readRSC();

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await htmlReader.read();
      if (done) {
        // Wait for RSC to finish and flush
        while (!rscDone) await new Promise(r => setTimeout(r, 10));
        for (const chunk of rscChunks) {
          controller.enqueue(encoder.encode(`<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`));
        }
        rscChunks.length = 0;
        controller.enqueue(encoder.encode(`<script>window.__RSC_CLOSE__()</script>`));
        controller.close();
        return;
      }
      controller.enqueue(value);
      while (rscChunks.length > 0) {
        const chunk = rscChunks.shift()!;
        controller.enqueue(encoder.encode(`<script>window.__RSC_PUSH__(${JSON.stringify(chunk)})</script>`));
      }
    },
  });
}

async function pipeReadableStreamToResponse(
  stream: ReadableStream,
  res: import('http').ServerResponse,
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

async function nodeReqToRequest(
  req: import('http').IncomingMessage,
  url: URL,
): Promise<Request> {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  let body: BodyInit | null = null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
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
