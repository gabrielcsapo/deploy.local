import { logFlightRouterError } from './server/flight-router-error.ts';
// The built server: dist/server.js, which `pnpm start` runs through dist/supervisor.js. Everything is
// bootServer's; this file adds only the built web app.
import { bootServer, type ClientHandler } from './server/boot.ts';
import { createRequire } from 'node:module';
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
      onError: logFlightRouterError,
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

  if (!flightApp) {
    return (_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    };
  }
  // Converts the request, strips HTTP/2 pseudo-headers and hop-by-hop headers,
  // writes at the client's pace and stops the render when the client leaves.
  const { nodeListener } = flightApp;
  return (req, res) => {
    // The flight router tags the SSR HTML document `Cache-Control:
    // no-transform` (to stop Hono's compressor from buffering the stream),
    // but no-transform alone leaves the document heuristically cacheable. A
    // browser can then serve a stale index.html after a redeploy, and its
    // now-deleted content-hashed chunk imports 404 — which surfaces as
    // "Importing a module script failed" and a hydration mismatch (React
    // #418). Force the HTML document to revalidate every load while keeping
    // the no-transform opt-out; the hashed assets stay immutable-cached.
    const writeHead = res.writeHead;
    res.writeHead = function (this: typeof res, ...args: unknown[]) {
      const headers = args.find((arg) => arg && typeof arg === 'object') as
        | Record<string, string | string[]>
        | undefined;
      if (headers && String(headers['content-type'] ?? '').includes('text/html'))
        headers['cache-control'] = 'no-cache, no-transform';
      return (writeHead as (...a: unknown[]) => typeof res).apply(this, args);
    } as typeof res.writeHead;
    return nodeListener(req, res);
  };
}

void bootServer({
  role: process.env.DEPLOY_ROLE === 'control' ? 'control' : 'single',
  createClient: createFlightClient,
});
