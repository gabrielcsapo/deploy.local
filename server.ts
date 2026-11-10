import { flightLogLine, logFlightRouterError } from './server/flight-router-error.ts';
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
      // interleave. It starts on the first action, and every thread loads the
      // whole server.
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
        if (event.totalMs >= 500) console.log(flightLogLine(event));
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
  // The router's default Cache-Control makes the HTML document revalidate on
  // every load (`no-cache`), so a page left open across a release never asks
  // for hashed chunks that were deleted.
  return flightApp.nodeListener;
}

void bootServer({
  role: process.env.DEPLOY_ROLE === 'control' ? 'control' : 'single',
  createClient: createFlightClient,
});
