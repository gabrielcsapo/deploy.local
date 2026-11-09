import { startDesignApprovals } from './v2/design.ts';
import { createTelemetryCollector } from './telemetry-runtime.ts';
import { withServerTelemetry } from './telemetry-http.ts';
/**
 * The one startup path. `server.ts` (the built server) and `server/index.ts`
 * (`pnpm server`, `pnpm dev`) call bootServer and add nothing else, so what
 * runs under test and in development is what runs in production.
 * `server/boot.test.ts` fails if an entry point starts anything on its own.
 */
import { initializeRequestStorage } from './requests-lifecycle.ts';
import { CopyWarmer, cleanupCopies, queueAllCopies } from './packages/copies.ts';
import './packages/hooks.ts';
import { npmRegistry } from './packages/npm.ts';
import { terminalRelay } from './workspace/terminal-service.ts';
import { startGitSshServer } from './workspace/git-ssh.ts';
import { createServer } from 'node:http';
import { handleWebRedirect } from './web-redirects.ts';
import { createSecureServer as createHttp2Server } from 'node:http2';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apiMiddleware, setHotPathRouteSource } from './api.ts';
import { setupWebSocket, attachWebSocketUpgrade } from './ws.ts';
import { syncContainerStates, startAllContainers } from './lifecycle.ts';
import { startMaintenance } from './maintenance.ts';
import { startManagedWorkers, stopManagedWorkers } from './workspace/managed-worker.ts';
import {
  cleanupStaleBuildLogs,
  flushRequestLogs,
  logRequest,
  getAllDeployments,
  getSqlite,
} from './store.ts';
import { ensureCerts, getTlsOptions, getCaCertBuffer } from './certs.ts';
import { serveInstallScript, serveWindowsInstallScript, serveCliRequest } from './cli-download.ts';
import { isDesktopDownloadPath, serveDesktopRequest } from './desktop-download.ts';
import { installCrashGuard } from './crash-guard.ts';
import { attachAppUpgradeProxy } from './edge/upgrade-proxy.ts';
import { initEdgeRuntime, getDefaultDbFile } from './edge/runtime.ts';
import { startEdgeIpcServer, connectEdgeIpc, getEdgeSockPath } from './ipc.ts';
import { emit } from './events.ts';
import { startApplicationGraphSupervisor } from './application-graph-supervisor.ts';
import { deployDataDirectory } from './data-directory.ts';
import { loadOrCreateSecretKey } from './secrets.ts';

/** Serves the pages and assets of the web app: every request the API does not claim. */
export type ClientHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export interface BootOptions {
  /**
   * 'single': everything in one process — TLS, proxy, mDNS, API, dashboard. The
   * edge modules run embedded. This is `pnpm start:single` and the dev server.
   * 'control' (spawned by the supervisor): API, builds, dashboard and Docker
   * orchestration on plain HTTP at 127.0.0.1:7843. TLS, proxy and mDNS live in
   * the separate edge process (dist/edge.js); a control crash or redeploy never
   * interrupts app traffic.
   */
  role: 'single' | 'control';
  /** Built after the certificates exist and before the API takes requests. */
  createClient: () => ClientHandler | Promise<ClientHandler>;
  /** Git SSH port when it should not come from DEPLOY_SSH_PORT or its default. */
  gitSshPort?: number;
}

const HTTPS_FALLBACK_PORT = 8443;

function serveCaCert(res: ServerResponse) {
  const caCert = getCaCertBuffer();
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="deploy-local-ca.crt"',
    'Content-Length': caCert.length,
  });
  res.end(caCert);
}

/** The CLI and desktop downloads, on every listener. True when it answered. */
function serveDownload(req: IncomingMessage, res: ServerResponse) {
  if (req.url === '/install') {
    serveInstallScript(req, res);
    return true;
  }
  if (req.url === '/install.ps1') {
    serveWindowsInstallScript(req, res);
    return true;
  }
  if (req.url?.startsWith('/cli')) {
    serveCliRequest(req, res);
    return true;
  }
  if (isDesktopDownloadPath(req.url)) {
    serveDesktopRequest(req, res);
    return true;
  }
  return false;
}

async function start(options: BootOptions) {
  // Env-overridable so tests (and non-root setups) can bind unprivileged ports.
  const HTTP_PORT = parseInt(process.env.PORT || '80', 10);
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
  const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '7843', 10);

  // Before anything starts: a data directory that lost its key stops here with the reason, rather
  // than running with stored secrets it can't open.
  loadOrCreateSecretKey(deployDataDirectory());
  initializeRequestStorage(getSqlite()!);
  // Generate CA + server certs on first startup, including all known
  // deployments. Both roles: the control plane owns cert generation; the
  // edge only reads them.
  const deploymentNames = getAllDeployments().map((d) => d.name);
  ensureCerts(deploymentNames);

  const client = await options.createClient();
  const handler = apiMiddleware();
  const graphSupervisor = startApplicationGraphSupervisor();

  async function serveClient(req: IncomingMessage, res: ServerResponse) {
    if (await handleWebRedirect(req, res)) return;
    await client(req, res);
  }

  function startupTasks(managedWorkerOrigin: string) {
    startDesignApprovals();
    startManagedWorkers(managedWorkerOrigin);
    cleanupStaleBuildLogs();
    syncContainerStates()
      .catch((err) => console.error('Error syncing container states:', err))
      .then(() =>
        startAllContainers().catch((err) => console.error('Error starting containers:', err)),
      );
    npmRegistry.copy.startChecks();
    queueAllCopies();
    const packageWarmer = new CopyWarmer(npmRegistry.copy);
    startMaintenance({
      warm: () => packageWarmer.tick(),
      daily: async () => {
        queueAllCopies();
        await cleanupCopies();
      },
    });
  }

  if (options.role === 'control') {
    // ── Control plane: plain HTTP on loopback, fronted by the edge ─────────
    const controlServer = createServer((req, res) => {
      // A response sent before its request body was read leaves those bytes on the socket, and
      // the edge would pool the next request behind them until the idle timeout (~6s). Handlers
      // that can reject uploads drain first (workspace `send`); this catches the rest.
      res.once('finish', () => {
        if (req.complete === false && !req.socket.destroyed) req.socket.end();
      });
      if (serveDownload(req, res)) return;
      handler(req, res, () => void serveClient(req, res));
    });

    setupWebSocket(controlServer);
    const gitSshServer = await startGitSshServer({ port: options.gitSshPort });

    // Receive edge events (request:logged from the proxy hot path and TCP
    // proxies) and re-emit them locally so the dashboard WS broadcast and
    // metrics pipeline see one unified stream.
    connectEdgeIpc(getEdgeSockPath(), { onEvent: (event) => emit(event) });

    function shutdown(signal: string) {
      console.log(`\n[control] ${signal} received, shutting down...`);
      const sshStopped = gitSshServer?.close();
      flushRequestLogs();
      terminalRelay.dispose();
      stopManagedWorkers();
      // Deployed workloads have an independent lifecycle. A control-plane
      // restart must not stop them or overwrite their observed status.
      graphSupervisor.stop();
      controlServer.close(async () => {
        await sshStopped;
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
      startupTasks(`http://127.0.0.1:${CONTROL_PORT}`);
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
      // The CLI's configured server URL is https://, so the installer and
      // `deploy upgrade` must resolve here too, not only on the port-80 server.
      if (serveDownload(req, res)) return;

      handler(req, res, () => void serveClient(req, res));
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

  let actualHttpsPort = HTTPS_PORT;

  // HTTP server on port 80: serve CA cert, handle API requests, redirect browsers to HTTPS
  const collector = await createTelemetryCollector();
  const httpServer = createServer(
    withServerTelemetry(collector.handler, (req, res) => {
      if (req.url === '/ca.crt') {
        serveCaCert(res);
        return;
      }
      if (serveDownload(req, res)) return;
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
    }),
  );

  attachWebSocketUpgrade(httpServer);
  attachAppUpgradeProxy(httpServer, { getRoute: edgeRuntime.hotPathDeps.getRoute });

  const gitSshServer = await startGitSshServer({ port: options.gitSshPort });

  // Graceful shutdown only stops the control plane. Deployed workloads remain
  // available while the single-process server restarts.
  function shutdown(signal: string) {
    console.log(`\n${signal} received, shutting down...`);
    const sshStopped = gitSshServer?.close();
    flushRequestLogs();
    terminalRelay.dispose();
    stopManagedWorkers();
    graphSupervisor.stop();
    const mdnsStopped = edgeRuntime.close();
    edgeIpc.close();
    collector.close();
    httpsServer.close();
    httpServer.close(async () => {
      await Promise.all([sshStopped, mdnsStopped]);
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

  // One listener, not a callback on each listen(): a callback from the failed
  // first attempt would stay armed and run the startup tasks a second time.
  httpsServer.once('listening', () => {
    console.log(`deploy.local server running on https://deploy.local:${actualHttpsPort}`);
    startupTasks(`https://deploy.local:${actualHttpsPort}`);
  });

  httpsServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') throw err;
    // Retrying the same port would spin here forever with nothing serving.
    if (actualHttpsPort === HTTPS_FALLBACK_PORT) {
      console.error(`Port ${actualHttpsPort} unavailable (${err.code}), giving up`);
      process.exit(1);
    }
    console.warn(
      `Port ${HTTPS_PORT} unavailable (${err.code}), falling back to port ${HTTPS_FALLBACK_PORT}`,
    );
    actualHttpsPort = HTTPS_FALLBACK_PORT;
    httpsServer.listen(actualHttpsPort);
  });

  httpsServer.listen(HTTPS_PORT);

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

export function bootServer(options: BootOptions) {
  installCrashGuard();
  return start(options).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
