// The built server: dist/server.js, which `pnpm start` runs through dist/supervisor.js. Everything is
// bootServer's; this file adds only the built web app.
import { bootServer, type ClientHandler } from './server/boot.ts';
import { pipeWebBody } from './server/web-response.ts';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createServer as createFlightServer } from 'react-flight-router/server';

// react-flight-router/server sets globalThis.__webpack_require__ for SSR module
// loading. The `bindings` package (used by better-sqlite3) checks for this and
// then expects __non_webpack_require__ to exist. Provide a real require function.
(globalThis as Record<string, unknown>).__non_webpack_require__ = createRequire(import.meta.url);

// RSC, SSR and static files for every request the API does not claim.
async function createFlightClient(): Promise<ClientHandler> {
  let flightApp: Awaited<ReturnType<typeof createFlightServer>> | null = null;
  try {
    flightApp = await createFlightServer({
      buildDir: './dist',
      // Run programmatic server actions (app/actions/deployments.ts is the only
      // file of them) in a worker thread. The main thread stays free for RSC/SSR
      // renders and the reverse proxy hot path — even if a server action does a
      // slow shell out (docker, tar) only its worker stalls.
      //
      // One thread is enough: those actions are mostly waiting on I/O, so they
      // interleave. The default (cpus - 1) spawns eagerly, and every thread loads
      // the whole server: 23 of them on a 24-core machine for almost no traffic.
      //
      // Module-level mutable state isn't shared with the worker; this is fine
      // because we only carry sqlite handles + caches at module scope and
      // sqlite WAL mode permits multiple connections. Worker-side deployment
      // mutations reach the edge via the IPC socket (see ipc.ts).
      workers: { size: 1 },
      // Bound the synchronous render phase. Without this, a stuck server
      // component (e.g. awaiting an unreachable upstream) pins the request
      // slot indefinitely.
      renderTimeoutMs: 10_000,
      onRequestComplete: (event) => {
        // Surface slow RSC/SSR/action requests at debug level. Anything below
        // 500ms is silent; the few that matter are easy to spot.
        if (event.totalMs >= 500) {
          console.log(
            `[flight] ${event.type} ${event.pathname} ${event.status} ${Math.round(event.totalMs)}ms`,
          );
        }
      },
    });
  } catch (err) {
    console.warn('Failed to initialize flight router (dist not built?):', (err as Error).message);
  }

  return async (req, res) => {
    if (!flightApp) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    try {
      // HTTP/2 puts the host into the `:authority` pseudo-header; fall
      // back to that when the legacy `host` header isn't populated by
      // Node's compat layer.
      const hostHeader =
        req.headers.host || (req.headers[':authority'] as string | undefined) || 'deploy.local';
      const url = new URL(req.url!, `https://${hostHeader}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        // Skip HTTP/2 pseudo-headers (`:method`, `:path`, `:scheme`,
        // `:authority`). They aren't valid in the fetch Headers API and
        // their data is already captured via req.method / req.url / the
        // synthesized URL above.
        if (!value || key.charCodeAt(0) === 58 /* ':' */) continue;
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }

      const method = req.method ?? 'GET';
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const webRequest = new Request(url.toString(), {
        method,
        headers,
        body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
        // @ts-expect-error Node.js fetch option to allow streaming request body
        duplex: hasBody ? 'half' : undefined,
      });

      const webResponse = await flightApp.fetch(webRequest);

      const responseHeaders: Record<string, string> = {};
      webResponse.headers.forEach((value, key) => {
        // RFC 7230 §6.1 hop-by-hop headers are forbidden in HTTP/2
        // responses. The flight router emits `transfer-encoding: chunked`
        // for streaming RSC/SSR responses — perfectly valid in HTTP/1.1
        // but it makes Node's h2 layer throw ERR_HTTP2_INVALID_CONNECTION_HEADERS.
        // In h2, length is handled by the framing layer; we don't need
        // to forward chunked encoding.
        switch (key) {
          case 'connection':
          case 'keep-alive':
          case 'proxy-authenticate':
          case 'proxy-authorization':
          case 'te':
          case 'trailer':
          case 'transfer-encoding':
          case 'upgrade':
            return;
        }
        responseHeaders[key] = value;
      });

      // The flight router tags the SSR HTML document `Cache-Control:
      // no-transform` (to stop Hono's compressor from buffering the stream),
      // but no-transform alone leaves the document heuristically cacheable. A
      // browser can then serve a stale index.html after a redeploy, and its
      // now-deleted content-hashed chunk imports 404 — which surfaces as
      // "Importing a module script failed" and a hydration mismatch (React
      // #418). Force the HTML document to revalidate every load while keeping
      // the no-transform opt-out; the hashed assets stay immutable-cached.
      if ((responseHeaders['content-type'] || '').includes('text/html')) {
        responseHeaders['cache-control'] = 'no-cache, no-transform';
      }

      res.writeHead(webResponse.status, responseHeaders);

      if (webResponse.body) await pipeWebBody(webResponse.body, res);
      if (!res.destroyed) res.end();
    } catch (err) {
      console.error('Flight router error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal Server Error');
    }
  };
}

void bootServer({
  role: process.env.DEPLOY_ROLE === 'control' ? 'control' : 'single',
  createClient: createFlightClient,
});
