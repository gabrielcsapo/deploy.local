import { createServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { apiMiddleware, setHttpsServer } from './api.ts';
import { setupWebSocket, attachWebSocketUpgrade } from './ws.ts';
import { syncContainerStates, startAllContainers, stopAllContainers } from './lifecycle.ts';
import { startMaintenance } from './maintenance.ts';
import { cleanupStaleBuildLogs, flushRequestLogs, getAllDeployments } from './store.ts';
import { notFoundPage } from './error-page.ts';
import { ensureCerts, getTlsOptions, getCaCertBuffer } from './certs.ts';

const HTTP_PORT = parseInt(process.env.PORT || '80', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '443', 10);
const VITE_PORT = parseInt(process.env.VITE_PORT || '5173', 10);

// Generate CA + server certs on first startup, including all known deployments
const deploymentNames = getAllDeployments().map((d) => d.name);
ensureCerts(deploymentNames);
const tlsOpts = getTlsOptions();

function serveCaCert(res: import('node:http').ServerResponse) {
  const caCert = getCaCertBuffer();
  res.writeHead(200, {
    'Content-Type': 'application/x-x509-ca-cert',
    'Content-Disposition': 'attachment; filename="deploy-sh-ca.crt"',
    'Content-Length': caCert.length,
  });
  res.end(caCert);
}

const handler = apiMiddleware();

// HTTPS server (main app server)
const httpsServer = createHttpsServer(
  { key: tlsOpts.key, cert: tlsOpts.cert, ca: tlsOpts.ca },
  (req, res) => {
    if (req.url === '/ca.crt') {
      serveCaCert(res);
      return;
    }

    handler(req, res, () => {
      // Proxy non-API requests to Vite dev server
      const proxyReq = httpRequest(
        {
          hostname: 'localhost',
          port: VITE_PORT,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode!, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', () => {
        notFoundPage(res);
      });
      req.pipe(proxyReq);
    });
  },
);

setupWebSocket(httpsServer);
setHttpsServer(httpsServer);

let actualHttpsPort = HTTPS_PORT;

// HTTP server: serve CA cert, handle API requests, redirect browsers to HTTPS
const httpServer = createServer((req, res) => {
  if (req.url === '/ca.crt') {
    serveCaCert(res);
    return;
  }
  // Handle API requests over HTTP (for CLI compatibility)
  if (req.url?.startsWith('/api/')) {
    handler(req, res, () => {
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

// Graceful shutdown - stop all containers when deploy.sh stops
function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down...`);

  flushRequestLogs();
  stopAllContainers();

  httpsServer.close();
  httpServer.close(() => {
    console.log('deploy.sh stopped');
    process.exit(0);
  });

  // Force exit after 10 seconds if server hasn't closed
  setTimeout(() => {
    console.error('Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

httpsServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
    actualHttpsPort = 8443;
    console.warn(
      `Port ${HTTPS_PORT} unavailable (${err.code}), falling back to port ${actualHttpsPort}`,
    );
    httpsServer.listen(actualHttpsPort, () => {
      console.log(`deploy.sh server running on https://deploy.local:${actualHttpsPort}`);
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
  console.log(`deploy.sh server running on https://deploy.local:${HTTPS_PORT}`);
  cleanupStaleBuildLogs();
  syncContainerStates();
  startAllContainers().catch((err) => console.error('Error starting containers:', err));
  startMaintenance();
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`deploy.sh HTTP redirect + CA cert server on http://deploy.local:${HTTP_PORT}`);
});
