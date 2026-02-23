import { Hono } from 'hono';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { loadManifests } from './manifest-loader.js';
import { renderRSC } from './rsc-renderer.js';
import { handleAction } from './action-handler.js';
import {
  RSC_CONTENT_TYPE,
  RSC_ENDPOINT,
  ACTION_ENDPOINT,
  RSC_PREVIOUS_SEGMENTS_HEADER,
} from '../shared/constants.js';
import type { RouteConfig } from '../router/types.js';

interface CreateServerOptions {
  /** Path to the build output directory */
  buildDir: string;
}

/**
 * Create a production Hono server for a flight-router app.
 * Serves static assets, RSC endpoints, server actions, and initial HTML.
 */
export async function createServer(opts: CreateServerOptions) {
  const buildDir = resolve(opts.buildDir);
  const manifests = loadManifests(buildDir);

  // Dynamically import the RSC server bundle
  const rscEntry = await import(resolve(buildDir, 'server/rsc-entry.js'));
  const routes: RouteConfig[] = rscEntry.routes;

  // Import RSC rendering functions from the built runtime bundle.
  // This was built with resolve.conditions: ['react-server'] so it works
  // without needing --conditions=react-server at Node.js startup.
  const rscRuntime = await import(resolve(buildDir, 'server/rsc-runtime.js'));
  const { renderToReadableStream } = rscRuntime;

  // Import server action entry files to populate globalThis.__flight_server_modules.
  // These are separate entries because client components (which import server actions)
  // get replaced in the RSC build, so actions may not be reachable from rsc-entry.
  const serverDir = resolve(buildDir, 'server');
  const actionEntries = readdirSync(serverDir)
    .filter(f => f.startsWith('server-action-') && f.endsWith('.js'));
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
  const doRenderRSC = async (url: URL, segments?: string[]) => {
    return renderRSC({
      url,
      routes,
      clientManifest: manifests.rscClientManifest,
      renderToReadableStream,
      segments,
      loadModule,
    });
  };

  // Build module ID → URL map from the RSC client manifest.
  // This lets the client-side __webpack_require__ shim resolve module IDs
  // (like "flight-router/dist/client/link") to actual asset URLs.
  const moduleMap: Record<string, string> = {};
  for (const [moduleId, entry] of Object.entries(manifests.rscClientManifest)) {
    // chunks is pairs: [chunkId, chunkUrl, chunkId2, chunkUrl2, ...]
    // The first pair is the main chunk for this module
    if (entry.chunks && entry.chunks.length >= 2) {
      moduleMap[moduleId] = entry.chunks[1]; // chunkUrl (absolute path)
    }
  }

  // Generate the shell HTML with bootstrap script and client entry
  const shellHtml = generateShellHtml(
    manifests.clientEntryUrl,
    manifests.cssFiles,
    moduleMap,
  );

  const app = new Hono();

  // MIME type lookup
  const mimeTypes: Record<string, string> = {
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
  };

  // Static assets from client build
  app.get('/assets/*', async (c) => {
    const filePath = resolve(buildDir, 'client', c.req.path.slice(1));
    try {
      const content = readFileSync(filePath);
      const ext = filePath.slice(filePath.lastIndexOf('.'));
      const contentType = mimeTypes[ext] ?? 'application/octet-stream';
      return new Response(content, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  // RSC endpoint for client-side navigation
  app.get(RSC_ENDPOINT, async (c) => {
    const targetUrl = new URL(
      c.req.query('url') ?? '/',
      `http://${c.req.header('host') ?? 'localhost'}`,
    );
    const prevSegments = c.req.header(RSC_PREVIOUS_SEGMENTS_HEADER);
    const segments = prevSegments ? prevSegments.split(',') : undefined;

    const stream = await doRenderRSC(targetUrl, segments);

    return new Response(stream, {
      headers: {
        'Content-Type': RSC_CONTENT_TYPE,
        'Transfer-Encoding': 'chunked',
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
      renderToReadableStream,
      renderRSC: doRenderRSC,
    });
  });

  // Initial page load: shell HTML with inlined RSC stream
  app.get('*', async (c) => {
    const url = new URL(c.req.url);

    // Render RSC payload
    const rscStream = await doRenderRSC(url);

    // Create HTML stream: shell HTML + inlined RSC data as script tags
    const htmlStream = interleaveRSCPayload(shellHtml, rscStream);

    return new Response(htmlStream, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  });

  return app;
}

/**
 * Generate the shell HTML with bootstrap script for RSC stream reception.
 * The client entry module hydrates from the inlined RSC stream.
 */
function generateShellHtml(clientEntryUrl: string, cssFiles: string[], moduleMap: Record<string, string>): string {
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

  const cssLinks = cssFiles
    .map((f) => `<link rel="stylesheet" href="${f}" />`)
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flight Router</title>
  ${cssLinks}
  <script>${bootstrapScript}</script>
  <script>window.__MODULE_MAP__ = ${JSON.stringify(moduleMap)};</script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="${clientEntryUrl}"></script>
</body>
</html>`;
}

/**
 * Interleave shell HTML with RSC payload as inline script tags.
 * RSC data is streamed after the HTML so the client can start
 * processing it immediately.
 */
function interleaveRSCPayload(
  shellHtml: string,
  rscStream: ReadableStream,
): ReadableStream {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const rscReader = rscStream.getReader();
  let htmlSent = false;

  return new ReadableStream({
    async pull(controller) {
      // Send shell HTML first
      if (!htmlSent) {
        controller.enqueue(encoder.encode(shellHtml));
        htmlSent = true;
        return;
      }

      // Then stream RSC data as script tags
      const { done, value } = await rscReader.read();
      if (done) {
        controller.enqueue(
          encoder.encode(`<script>window.__RSC_CLOSE__()</script>`),
        );
        controller.close();
        return;
      }

      const text = decoder.decode(value, { stream: true });
      controller.enqueue(
        encoder.encode(
          `<script>window.__RSC_PUSH__(${JSON.stringify(text)})</script>`,
        ),
      );
    },
  });
}

export { loadManifests } from './manifest-loader.js';
export { renderRSC } from './rsc-renderer.js';
export { handleAction } from './action-handler.js';
