import { readFileSync } from 'node:fs';
import {
  request as httpRequest,
  Agent,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { deployDataPath } from './data-directory.ts';

const DEV_UI_MARKER = deployDataPath('dev-ui.json');
const devUiAgent = new Agent({ keepAlive: true, maxSockets: 32 });
const CACHE_MS = 250;

export interface DevUiTarget {
  hostname: '127.0.0.1';
  port: number;
}

let cachedAt = 0;
let cachedTarget: DevUiTarget | null = null;

/**
 * The marker is deliberately local-only. It lets an unprivileged Vite process
 * opt into the dashboard route without changing the coordinator URL agents use.
 */
export function getDevUiTarget(now = Date.now()): DevUiTarget | null {
  if (now - cachedAt < CACHE_MS) return cachedTarget;
  cachedAt = now;
  cachedTarget = null;

  try {
    const marker = JSON.parse(readFileSync(DEV_UI_MARKER, 'utf8')) as { origin?: unknown };
    if (typeof marker.origin !== 'string') return null;
    const origin = new URL(marker.origin);
    const port = Number(origin.port);
    if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1') return null;
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) return null;
    cachedTarget = { hostname: '127.0.0.1', port };
  } catch {
    // Missing, partially written, and stale markers all mean "use production UI".
  }
  return cachedTarget;
}

export function forwardToDevUi(
  req: IncomingMessage,
  res: ServerResponse,
  target: DevUiTarget,
  onUnavailable: () => void,
) {
  const method = req.method || 'GET';
  const headers = { ...req.headers };
  for (const key in headers) {
    if (key.charCodeAt(0) === 58 /* ':' */) delete headers[key];
  }

  const proxyReq = httpRequest(
    {
      agent: devUiAgent,
      hostname: target.hostname,
      port: target.port,
      path: req.url || '/',
      method,
      headers,
    },
    (proxyRes) => {
      const responseHeaders = { ...proxyRes.headers };
      delete responseHeaders.connection;
      delete responseHeaders['keep-alive'];
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders.upgrade;
      responseHeaders['x-deploy-ui'] = 'development';
      res.writeHead(proxyRes.statusCode!, responseHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.once('error', () => {
    if (!res.headersSent && (method === 'GET' || method === 'HEAD')) onUnavailable();
    else if (!res.writableEnded) res.end();
  });
  req.pipe(proxyReq);
}
