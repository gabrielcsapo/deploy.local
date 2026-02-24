import { Hono } from "hono";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { loadManifests } from "./manifest-loader.js";
import { renderRSC } from "./rsc-renderer.js";
import { renderSSR } from "./ssr-renderer.js";
import { handleAction } from "./action-handler.js";
import {
  RSC_CONTENT_TYPE,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_PREVIOUS_SEGMENTS_HEADER,
  RSC_PREVIOUS_URL_HEADER,
} from "../shared/constants.js";
import type { RouteConfig } from "../router/types.js";

interface CreateServerOptions {
  /** Path to the build output directory */
  buildDir: string;
}

/**
 * Create a production Hono server for a flight-router app.
 * Serves static assets, RSC endpoints, server actions, and SSR HTML.
 */
export async function createServer(opts: CreateServerOptions) {
  const buildDir = resolve(opts.buildDir);
  const manifests = loadManifests(buildDir);

  // Dynamically import the RSC server bundle
  const rscEntry = await import(resolve(buildDir, "server/rsc-entry.js"));
  const routes: RouteConfig[] = rscEntry.routes;

  // Import RSC rendering functions from the built runtime bundle.
  // This was built with resolve.conditions: ['react-server'] so it works
  // without needing --conditions=react-server at Node.js startup.
  const rscRuntime = await import(resolve(buildDir, "server/rsc-runtime.js"));
  const { renderToReadableStream: rscRenderToReadableStream } = rscRuntime;

  // Import SSR dependencies:
  // - react-server-dom-webpack/client.node for deserializing the RSC stream on the server
  // - react-dom/server for rendering the deserialized React tree to HTML
  const rscClientNode = (await import("react-server-dom-webpack/client.node")) as any;
  const { createFromReadableStream } = rscClientNode;
  const reactDomServer = (await import("react-dom/server")) as any;
  const { renderToReadableStream: domRenderToReadableStream } = reactDomServer;

  // Load SSR-built router components for wrapping the RSC payload during SSR.
  // These are the same components the client entry uses, but built for Node.js.
  const ssrRouterContext = (await import(
    resolve(buildDir, "server/ssr/flight-router/dist/client/router-context.js")
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
  const doRenderRSC = async (url: URL, segments?: string[], previousUrl?: URL) => {
    return renderRSC({
      url,
      routes,
      clientManifest: manifests.rscClientManifest,
      renderToReadableStream: rscRenderToReadableStream,
      segments,
      previousUrl,
      loadModule,
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

  const app = new Hono();

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
    const baseOrigin = `http://${c.req.header("host") ?? "localhost"}`;
    const targetUrl = new URL(c.req.query("url") ?? "/", baseOrigin);

    const prevSegments = c.req.header(RSC_PREVIOUS_SEGMENTS_HEADER);
    const segments = prevSegments ? prevSegments.split(",") : undefined;

    const prevUrlHeader = c.req.header(RSC_PREVIOUS_URL_HEADER);
    const previousUrl = prevUrlHeader ? new URL(prevUrlHeader, baseOrigin) : undefined;

    const stream = await doRenderRSC(targetUrl, segments, previousUrl);

    return new Response(stream, {
      headers: {
        "Content-Type": RSC_CONTENT_TYPE,
        "Transfer-Encoding": "chunked",
      },
    });
  });

  // Server actions endpoint
  app.post(ACTION_ENDPOINT, async (c) => {
    return handleAction({
      request: c.req.raw,
      routes,
      serverActionsManifest: manifests.serverActionsManifest,
      clientManifest: manifests.rscClientManifest,
      loadModule,
      decodeReply: rscRuntime.decodeReply as any,
      renderToReadableStream: rscRenderToReadableStream,
      renderRSC: doRenderRSC,
    });
  });

  // Initial page load: SSR with inlined RSC stream for hydration
  app.get("*", async (c) => {
    const url = new URL(c.req.url);

    // Render RSC payload
    const rscStream = await doRenderRSC(url);

    // Buffer the RSC stream to scan for client module references.
    // This lets us build a per-page MODULE_MAP containing only the
    // modules actually used by this page's RSC payload.
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

    // Extract client module IDs from Flight protocol I: instructions
    // Format: <rowId>:I["<moduleId>",[...chunks],"<name>",<async>]
    const pageModuleMap: Record<string, string> = {};
    const moduleRefPattern = /^\d+:I\["([^"]+)"/gm;
    let match;
    while ((match = moduleRefPattern.exec(rscText)) !== null) {
      const moduleId = match[1];
      if (fullModuleMap[moduleId]) {
        pageModuleMap[moduleId] = fullModuleMap[moduleId];
      }
    }

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
    });

    return new Response(htmlStream, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    });
  });

  return app;
}

export { loadManifests } from "./manifest-loader.js";
export { renderRSC } from "./rsc-renderer.js";
export { renderSSR } from "./ssr-renderer.js";
export { handleAction } from "./action-handler.js";
