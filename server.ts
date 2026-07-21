import { createServer } from 'node:http';
import { createSecureServer as createHttp2Server } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { apiMiddleware, setHotPathRouteSource } from './server/api.ts';
import { setupWebSocket, attachWebSocketUpgrade } from './server/ws.ts';
import { syncContainerStates, startAllContainers, stopAllContainers } from './server/lifecycle.ts';
import { startMaintenance } from './server/maintenance.ts';
import {
  cleanupStaleBuildLogs,
  flushRequestLogs,
  logRequest,
  getAllDeployments,
} from './server/store.ts';
import { ensureCerts, getTlsOptions, getCaCertBuffer } from './server/certs.ts';
import { serveInstallScript, serveCliBinary } from './server/cli-download.ts';
import { createServer as createFlightServer } from 'react-flight-router/server';
import { installCrashGuard } from './server/crash-guard.ts';
import { attachAppUpgradeProxy } from './server/edge/upgrade-proxy.ts';
import { initEdgeRuntime, getDefaultDbFile } from './server/edge/runtime.ts';
import { startEdgeIpcServer, connectEdgeIpc, getEdgeSockPath } from './server/ipc.ts';
import { emit } from './server/events.ts';

// react-flight-router/server sets globalThis.__webpack_require__ for SSR module
// loading. The `bindings` package (used by better-sqlite3) checks for this and
// then expects __non_webpack_require__ to exist. Provide a real require function.
(globalThis as Record<string, unknown>).__non_webpack_require__ = createRequire(import.meta.url);

installCrashGuard();

// ── Roles ────────────────────────────────────────────────────────────────────
// 'single'  (default): everything in one process — TLS, proxy, mDNS, API,
//           dashboard. The edge modules run embedded. This is `pnpm
//           start:single` and the dev server's topology.
// 'control' (DEPLOY_ROLE=control, spawned by the supervisor): API, builds,
//           dashboard, Docker orchestration on plain HTTP at 127.0.0.1:7843.
//           TLS/proxy/mDNS live in the separate edge process (dist/edge.js);
//           a control crash or redeploy never interrupts app traffic.
const ROLE = process.env.DEPLOY_ROLE === 'control' ? 'control' : 'single';

// Env-overridable so tests (and non-root setups) can bind unprivileged ports.
const HTTP_PORT = parseInt(process.env.PORT || '80', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '7843', 10);

function serveCaCert(res: ServerResponse) {
  const caCert = getCaCertBuffer();
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="deploy-local-ca.crt"',
    'Content-Length': caCert.length,
  });
  res.end(caCert);
}

async function main() {
  // Generate CA + server certs on first startup, including all known
  // deployments. Both roles: the control plane owns cert generation; the
  // edge only reads them.
  const deploymentNames = getAllDeployments().map((d) => d.name);
  ensureCerts(deploymentNames);

  let flightApp: Awaited<ReturnType<typeof createFlightServer>> | null = null;
  try {
    flightApp = await createFlightServer({
      buildDir: './dist',
      // Run programmatic server actions (e.g. fetchDeployments, fetchRequestData)
      // in worker threads. The main thread stays free for RSC/SSR renders and
      // the reverse proxy hot path — even if a server action does a slow shell
      // out (docker, tar) only its worker stalls.
      //
      // Module-level mutable state isn't shared between workers; this is fine
      // because we only carry sqlite handles + caches at module scope and
      // sqlite WAL mode permits multiple connections. Worker-side deployment
      // mutations reach the edge via the IPC socket (see ipc.ts).
      workers: true,
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
  const handler = apiMiddleware();

  // Non-API request → delegate to react-flight-router for RSC/SSR/static.
  async function flightHandler(req: IncomingMessage, res: ServerResponse) {
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

      if (webResponse.body) {
        const reader = webResponse.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } catch (err) {
      console.error('Flight router error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
      }
      res.end('Internal Server Error');
    }
  }

  function startupTasks() {
    cleanupStaleBuildLogs();
    syncContainerStates()
      .catch((err) => console.error('Error syncing container states:', err))
      .then(() =>
        startAllContainers().catch((err) => console.error('Error starting containers:', err)),
      );
    startMaintenance();
  }

  if (ROLE === 'control') {
    // ── Control plane: plain HTTP on loopback, fronted by the edge ─────────
    const controlServer = createServer((req, res) => {
      if (req.url === '/install') {
        serveInstallScript(req, res);
        return;
      }
      if (req.url?.startsWith('/cli')) {
        serveCliBinary(req, res);
        return;
      }
      handler(req, res, () => void flightHandler(req, res));
    });

    setupWebSocket(controlServer);

    // Receive edge events (request:logged from the proxy hot path and TCP
    // proxies) and re-emit them locally so the dashboard WS broadcast and
    // metrics pipeline see one unified stream.
    connectEdgeIpc(getEdgeSockPath(), { onEvent: (event) => emit(event) });

    function shutdown(signal: string) {
      console.log(`\n[control] ${signal} received, shutting down...`);
      flushRequestLogs();
      void stopAllContainers();
      controlServer.close(() => {
        console.log('[control] stopped');
        process.exit(0);
      });
      setTimeout(() => {
        console.error('[control] forcing shutdown after timeout');
        process.exit(1);
      }, 10000);
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Failing to bind must be fatal — without this, the crash guard swallows
    // the EADDRINUSE exception and control lingers as a zombie that the edge
    // forwards into forever. Exiting lets the supervisor back off and retry
    // (and makes a port conflict visible instead of silent).
    controlServer.on('error', (err: NodeJS.ErrnoException) => {
      console.error(`[control] failed to bind 127.0.0.1:${CONTROL_PORT} (${err.code})`);
      process.exit(1);
    });

    controlServer.listen(CONTROL_PORT, '127.0.0.1', () => {
      console.log(`[control] listening on http://127.0.0.1:${CONTROL_PORT}`);
      startupTasks();
    });
    return;
  }

  // ── Single-process mode: embedded edge + TLS + dashboard in one ──────────
  const tlsOpts = getTlsOptions();

  const httpsServer = createHttp2Server(
    {
      key: tlsOpts.key,
      cert: tlsOpts.cert,
      ca: tlsOpts.ca,
      allowHTTP1: true,
      // Larger initial window so HTTP/2 streams don't stall waiting for
      // WINDOW_UPDATE during streaming SSR / large asset transfers. 1 MiB is
      // a sane default; Node's stock 64 KiB is conservative for our LAN use.
      settings: { initialWindowSize: 1024 * 1024 },
    },
    async (rawReq, rawRes) => {
      const req = rawReq as unknown as IncomingMessage;
      const res = rawRes as unknown as ServerResponse;

      // Serve CA cert on HTTPS too (convenience)
      if (req.url === '/ca.crt') {
        serveCaCert(res);
        return;
      }

      handler(req, res, () => void flightHandler(req, res));
    },
  );

  // Embedded edge runtime: route table (sees worker-thread mutations via the
  // IPC socket), mDNS, TCP proxies, cert hot-reload.
  const edgeRuntime = initEdgeRuntime({
    dbFile: getDefaultDbFile(),
    logRequest,
    emitEvent: emit,
    onCertReload: () => {
      const opts = getTlsOptions();
      httpsServer.setSecureContext({ key: opts.key, cert: opts.cert, ca: opts.ca });
      console.log('TLS context reloaded');
    },
  });
  const edgeIpc = startEdgeIpcServer(getEdgeSockPath(), edgeRuntime.handlers);
  setHotPathRouteSource(edgeRuntime.hotPathDeps.getRoute);

  setupWebSocket(httpsServer);
  // App-host WebSocket upgrades tunnel to the container; must be attached
  // alongside setupWebSocket so both listeners coordinate (ws.ts skips app
  // hosts, this skips dashboard /ws).
  attachAppUpgradeProxy(httpsServer, { getRoute: edgeRuntime.hotPathDeps.getRoute });

  // HTTP server on port 80: serve CA cert, handle API requests, redirect browsers to HTTPS
  const httpServer = createServer((req, res) => {
    if (req.url === '/ca.crt') {
      serveCaCert(res);
      return;
    }
    if (req.url === '/install') {
      serveInstallScript(req, res);
      return;
    }
    if (req.url?.startsWith('/cli')) {
      serveCliBinary(req, res);
      return;
    }
    // Handle API requests over HTTP (for CLI compatibility)
    if (req.url?.startsWith('/api/')) {
      handler(req, res, async () => {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      });
      return;
    }
    const host = req.headers.host?.split(':')[0] || 'deploy.local';
    const portSuffix = actualHttpsPort !== 443 ? `:${actualHttpsPort}` : '';
    res.writeHead(301, { Location: `https://${host}${portSuffix}${req.url}` });
    res.end();
  });

  attachWebSocketUpgrade(httpServer);
  attachAppUpgradeProxy(httpServer, { getRoute: edgeRuntime.hotPathDeps.getRoute });

  // Graceful shutdown
  function shutdown(signal: string) {
    console.log(`\n${signal} received, shutting down...`);
    flushRequestLogs();
    void stopAllContainers();
    edgeRuntime.close();
    edgeIpc.close();
    httpsServer.close();
    httpServer.close(() => {
      console.log('deploy.local stopped');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  let actualHttpsPort = HTTPS_PORT;

  httpsServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      actualHttpsPort = 8443;
      console.warn(
        `Port ${HTTPS_PORT} unavailable (${err.code}), falling back to port ${actualHttpsPort}`,
      );
      httpsServer.listen(actualHttpsPort, () => {
        console.log(`deploy.local server running on https://deploy.local:${actualHttpsPort}`);
        startupTasks();
      });
    } else {
      throw err;
    }
  });

  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`deploy.local server running on https://deploy.local:${HTTPS_PORT}`);
    startupTasks();
  });

  // The HTTP redirect server is non-critical — losing it (e.g. EACCES on a
  // non-root run) must not take the HTTPS server down with an unhandled
  // 'error' event.
  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    console.warn(`HTTP redirect server failed to bind port ${HTTP_PORT} (${err.code}) — skipping`);
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`deploy.local HTTP redirect + CA cert server on http://deploy.local:${HTTP_PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
