import type { IncomingMessage, ServerResponse } from 'node:http';
import type Database from 'better-sqlite3';
import { getRequestsSqlite } from './requests-db.ts';
import { deploymentForToken, ingestBrowser, ingestServer } from './telemetry.ts';

/** Bounded peer-IP fixed windows. Forwarded headers are never trusted for ingestion. */
export class TelemetryRateLimit {
  private peers = new Map<string, { at: number; count: number }>();
  private limit: number;
  private capacity: number;
  constructor(limit = 120, capacity = 10_000) {
    this.limit = limit;
    this.capacity = capacity;
  }
  allow(ip: string, now = Date.now()) {
    let peer = this.peers.get(ip);
    if (peer && now - peer.at >= 60_000) {
      this.peers.delete(ip);
      peer = undefined;
    }
    if (!peer) {
      if (this.peers.size >= this.capacity) {
        for (const [key, value] of this.peers) if (now - value.at >= 60_000) this.peers.delete(key);
        if (this.peers.size >= this.capacity) return false;
      }
      this.peers.set(ip, (peer = { at: now, count: 0 }));
    }
    return ++peer.count <= this.limit;
  }
}
const browserRate = new TelemetryRateLimit();
function end(res: ServerResponse, status: number) {
  res.writeHead(status, { 'Cache-Control': 'no-store' });
  res.end();
}
async function readBody(req: IncomingMessage, cap: number) {
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > cap)) {
    req.resume();
    throw Object.assign(new Error('Telemetry body too large'), { status: 413 });
  }
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > cap) {
      req.resume();
      throw Object.assign(new Error('Telemetry body too large'), { status: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid telemetry JSON'), { status: 400 });
  }
}
export async function handleBrowserTelemetry(
  req: IncomingMessage,
  res: ServerResponse,
  name: string,
  db: () => Database.Database = getRequestsSqlite,
  rate = browserRate,
) {
  try {
    if (!rate.allow(req.socket.remoteAddress ?? 'unknown')) {
      req.resume();
      return end(res, 429);
    }
    const body = await readBody(req, 16 * 1024);
    ingestBrowser(db(), name, body);
    end(res, 204);
  } catch (error) {
    end(res, (error as { status?: number }).status ?? 503);
  }
}
/** Edge HTTP ingestion; the real TCP peer must belong to a Docker bridge. */
export function serverTelemetryHandler(
  allowedPeer: (ip: string) => boolean | Promise<boolean>,
  db: () => Database.Database = getRequestsSqlite,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!(await allowedPeer(req.socket.remoteAddress ?? ''))) {
        req.resume();
        return end(res, 404);
      }
      if (req.method !== 'POST' || req.url !== '/__deploy/v1/server') {
        req.resume();
        return end(res, 404);
      }
      const authorization = req.headers.authorization;
      const name = authorization?.startsWith('Bearer ')
        ? deploymentForToken(db(), authorization.slice(7))
        : null;
      if (!name) {
        req.resume();
        return end(res, 401);
      }
      const body = await readBody(req, 512 * 1024);
      ingestServer(db(), name, body);
      end(res, 204);
    } catch (error) {
      end(res, (error as { status?: number }).status ?? 503);
    }
  };
}

/** Wrap the HTTP listener before host routing or HTTPS redirects. */
export function withServerTelemetry(
  telemetry: (req: IncomingMessage, res: ServerResponse) => unknown,
  next: (req: IncomingMessage, res: ServerResponse) => void,
) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.split('?')[0] === '/__deploy/v1/server') {
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
