import { readTelemetryBody, TelemetryRateLimit } from './kernel/telemetry-http.ts';
export { readTelemetryBody, TelemetryRateLimit } from './kernel/telemetry-http.ts';
import { otlpPath, receiveOtlp, respondOtlp } from './otlp.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from './kernel/db/sqlite.ts';
import { getRequestsSqlite } from './requests-db.ts';
import { deploymentForToken, ingestBrowser, ingestServer } from './telemetry.ts';

const browserRate = new TelemetryRateLimit();
const interactionRate = new TelemetryRateLimit(120);
function end(res: ServerResponse, status: number) {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}
export async function handleBrowserTelemetry(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  db: () => Database = getRequestsSqlite,
  rate = browserRate,
) {
  try {
    if (!rate.allow(req.socket.remoteAddress ?? 'unknown')) {
      req.resume();
      return end(res, 429);
    }
    const body = await readTelemetryBody(req, 16 * 1024);
    ingestBrowser(db(), name, body);
    end(res, 204);
  } catch (error) {
    end(res, (error as { status?: number }).status ?? 503);
  }
}
/** Edge HTTP ingestion; the real TCP peer must belong to a Docker bridge. */
export function serverTelemetryHandler(
  allowedPeer: (ip: string) => boolean | Promise<boolean>,
  db: () => Database = getRequestsSqlite,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reject = (status: number) =>
      req.url === otlpPath ? respondOtlp(req, res, status) : end(res, status);
    try {
      if (!(await allowedPeer(req.socket.remoteAddress ?? ''))) {
        req.resume();
        return reject(404);
      }
      if (req.method !== 'POST' || (req.url !== '/__deploy/v1/server' && req.url !== otlpPath)) {
        req.resume();
        return reject(404);
      }
      const authorization = req.headers.authorization;
      const name = authorization?.startsWith('Bearer ')
        ? deploymentForToken(db(), authorization.slice(7))
        : null;
      if (!name) {
        req.resume();
        return reject(401);
      }
      if (req.url === otlpPath) {
        if (!interactionRate.allow(name)) {
          req.resume();
          return reject(429);
        }
        return await receiveOtlp(req, res, db(), name);
      }
      const body = await readTelemetryBody(req, 512 * 1024);
      if (body?.v === 2 && !interactionRate.allow(name)) return reject(429);
      ingestServer(db(), name, body);
      end(res, 204);
    } catch (error) {
      reject((error as { status?: number }).status ?? 503);
    }
  };
}

/** Wrap the HTTP listener before host routing or HTTPS redirects. */
export function withServerTelemetry(
  telemetry: (req: IncomingMessage, res: ServerResponse) => unknown,
  next: (req: IncomingMessage, res: ServerResponse) => void,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (['/__deploy/v1/server', otlpPath].includes(req.url?.split('?')[0] ?? '')) {
      void telemetry(req, res);
      return;
    }
    next(req, res);
  };
}

/** Old path is only for apps on router 0.13.0; remove once none remain. */
export function isBrowserTelemetryPath(url: string) {
  const path = url.split('?')[0];
  return path === '/__rfr/telemetry' || path === '/__deploy/telemetry';
}
