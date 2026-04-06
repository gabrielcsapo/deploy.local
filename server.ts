import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { apiMiddleware, setHttpsServer } from './server/api.ts';
import { setupWebSocket, attachWebSocketUpgrade } from './server/ws.ts';
import { syncContainerStates, startAllContainers, stopAllContainers } from './server/lifecycle.ts';
import { startMaintenance } from './server/maintenance.ts';
import { cleanupStaleBuildLogs, flushRequestLogs, getAllDeployments } from './server/store.ts';
import { ensureCerts, getTlsOptions, getCaCertBuffer } from './server/certs.ts';
import { serveInstallScript, serveCliBinary } from './server/cli-download.ts';
import { createServer as createFlightServer } from 'react-flight-router/server';

// react-flight-router/server sets globalThis.__webpack_require__ for SSR module
// loading. The `bindings` package (used by better-sqlite3) checks for this and
// then expects __non_webpack_require__ to exist. Provide a real require function.
(globalThis as Record<string, unknown>).__non_webpack_require__ = createRequire(import.meta.url);

const HTTP_PORT = 80;
const HTTPS_PORT = 443;

function serveCaCert(res: import('node:http').ServerResponse) {
  const caCert = getCaCertBuffer();
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="deploy-local-ca.crt"',
    'Content-Length': caCert.length,
  });
  res.end(caCert);
}

async function main() {
  // Generate CA + server certs on first startup, including all known deployments
  const deploymentNames = getAllDeployments().map((d) => d.name);
  ensureCerts(deploymentNames);
  const tlsOpts = getTlsOptions();

  let flightApp: Awaited<ReturnType<typeof createFlightServer>> | null = null;
  try {
    flightApp = await createFlightServer({ buildDir: './dist' });
  } catch (err) {
    console.warn('Failed to initialize flight router (dist not built?):', (err as Error).message);
  }
  const handler = apiMiddleware();

  const httpsServer = createHttpsServer(
    { key: tlsOpts.key, cert: tlsOpts.cert, ca: tlsOpts.ca },
    async (req, res) => {
      // Serve CA cert on HTTPS too (convenience)
      if (req.url === '/ca.crt') {
        serveCaCert(res);
        return;
      }

      handler(req, res, async () => {
        // Non-API request → delegate to react-flight-router for RSC/SSR/static
        if (!flightApp) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
          return;
        }
        try {
          const url = new URL(req.url!, `https://${req.headers.host}`);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
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
            responseHeaders[key] = value;
          });
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
      });
    },
  );

  setupWebSocket(httpsServer);
  setHttpsServer(httpsServer);

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

  // Graceful shutdown
  function shutdown(signal: string) {
    console.log(`\n${signal} received, shutting down...`);
    flushRequestLogs();
    stopAllContainers();
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
        cleanupStaleBuildLogs();
        syncContainerStates();
        startAllContainers().catch((err) => console.error('Error starting containers:', err));
        startMaintenance();
      });
    } else {
      throw err;
    }
  });

  httpsServer.listen(HTTPS_PORT, () => {
    console.log(`deploy.local server running on https://deploy.local:${HTTPS_PORT}`);
    cleanupStaleBuildLogs();
    syncContainerStates();
    startAllContainers().catch((err) => console.error('Error starting containers:', err));
    startMaintenance();
  });

  httpServer.listen(HTTP_PORT, () => {
    console.log(`deploy.local HTTP redirect + CA cert server on http://deploy.local:${HTTP_PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
