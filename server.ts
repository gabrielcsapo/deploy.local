import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { apiMiddleware } from './server/api.ts';
import { setupWebSocket } from './server/ws.ts';
import { syncContainerStates, startAllContainers, stopAllContainers } from './server/lifecycle.ts';
import { startMaintenance } from './server/maintenance.ts';
import { cleanupStaleBuildLogs } from './server/store.ts';
import { createServer as createFlightServer } from 'react-flight-router/server';

// react-flight-router/server sets globalThis.__webpack_require__ for SSR module
// loading. The `bindings` package (used by better-sqlite3) checks for this and
// then expects __non_webpack_require__ to exist. Provide a real require function.
(globalThis as Record<string, unknown>).__non_webpack_require__ = createRequire(import.meta.url);

const PORT = parseInt(process.env.PORT || '80', 10);

async function main() {
  const flightApp = await createFlightServer({ buildDir: './dist' });
  const handler = apiMiddleware();

  const server = createServer(async (req, res) => {
    handler(req, res, async () => {
      // Non-API request → delegate to react-flight-router for RSC/SSR/static
      try {
        const url = new URL(req.url!, `http://${req.headers.host}`);
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
  });

  setupWebSocket(server);

  // Graceful shutdown
  function shutdown(signal: string) {
    console.log(`\n${signal} received, shutting down...`);
    stopAllContainers();
    server.close(() => {
      console.log('deploy.sh stopped');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('Forcing shutdown after timeout');
      process.exit(1);
    }, 10000);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`deploy.sh server running on http://localhost:${PORT}`);
    cleanupStaleBuildLogs();
    syncContainerStates();
    startAllContainers().catch((err) => console.error('Error starting containers:', err));
    startMaintenance();
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
