import { parseAuthCookie, clearAuthCookie } from './server/auth-cookie.ts';
import { authenticate } from './server/store.ts';
import { flightLogLine, logFlightRouterError } from './server/flight-router-error.ts';
// The built server: dist/server.js, which `pnpm start` runs through dist/supervisor.js. Everything is
// bootServer's; this file adds only the built web app.
import { bootServer, type ClientHandler } from './server/boot.ts';
import { createServer as createFlightServer } from 'react-flight-router/server';

// RSC, SSR and static files for every request the API does not claim.
async function createFlightClient(): Promise<ClientHandler> {
  let flightApp: Awaited<ReturnType<typeof createFlightServer>> | null = null;
  try {
    flightApp = await createFlightServer({
      buildDir: './dist',
      cacheControl: { html: 'private, no-store, no-transform' },
      // The app has no server actions, so the router starts no worker threads.
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
  // Identity-bearing HTML must never enter a shared cache. Revoked browser
  // sessions also discard their cookie when requesting a document or RSC payload.
  const listener = flightApp.nodeListener;
  return (req, res) => {
    const cookie = parseAuthCookie(req);
    if (cookie.token && !authenticate(cookie.username, cookie.token))
      res.setHeader('Set-Cookie', clearAuthCookie(req));
    return listener(req, res);
  };
}

void bootServer({
  role: process.env.DEPLOY_ROLE === 'control' ? 'control' : 'single',
  createClient: createFlightClient,
});
