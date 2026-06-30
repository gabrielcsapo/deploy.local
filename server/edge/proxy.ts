/**
 * Reverse-proxy hot path for `<app>.local` hosts.
 *
 * Moved verbatim from api.ts behind injectable deps so the same hand-tuned
 * code serves both topologies: the single-process mode (deps wired to
 * store.ts/events.ts) and the edge process (deps wired to the edge's route
 * table, request-log buffer, and IPC event forwarder).
 *
 * Every micro-allocation, every callback, every header-object spread runs
 * per request — see the inline comments before changing anything here.
 */

import {
  type IncomingMessage,
  type ServerResponse,
  request as httpRequest,
  Agent,
} from 'node:http';
import { createGzip } from 'node:zlib';
import { appNotFoundPage, appStartingPage } from '../error-page.ts';
import {
  tapRequestBody,
  createBodyTap,
  decodeBody,
  beginCapture,
  writeCapture,
  RESPONSE_BODY_CAP,
} from '../capture.ts';

export interface ProxyRoute {
  name: string;
  port: number | null;
}

export interface RequestLogEntry {
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  ip?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  requestSize?: number | null;
  responseSize?: number | null;
  queryParams?: string | null;
  username?: string | null;
  /** Set on 5xx responses when a request/response body capture was written. */
  captureId?: string | null;
}

export interface HotPathDeps {
  /** O(1) app-name → route lookup. */
  getRoute: (appName: string) => ProxyRoute | null;
  /** Buffered request-log write (must not block). */
  logRequest: (name: string, entry: RequestLogEntry) => void;
  /** Event fan-out for `request:logged` (dashboard live feed). */
  emitEvent: (event: {
    type: string;
    deploymentName: string;
    data: Record<string, unknown>;
  }) => void;
}

// ── HTTP Agent with connection pooling ──────────────────────────────────────

const proxyAgent = new Agent({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 256,
  maxFreeSockets: 256,
  timeout: 30000,
  scheduling: 'fifo',
});

// Per-request timeout for proxied responses. Backends that hang past this
// budget are treated as down (502) rather than blocking the client forever.
const PROXY_RESPONSE_TIMEOUT_MS = 15_000;

// Cap retry attempts and grow the gap between them. Stale keep-alive sockets
// usually clear on the first retry; further retries against a truly-down
// backend are pointless and would just amplify thundering-herd pressure.
const PROXY_MAX_RETRIES = 2;
const PROXY_RETRY_BASE_MS = 25;
const PROXY_RETRY_CAP_MS = 200;

export function proxyToApp(
  deps: HotPathDeps,
  req: IncomingMessage,
  res: ServerResponse,
  deployment: ProxyRoute,
  targetPath: string,
  search: string,
  method: string,
  retryCount = 0,
) {
  const startTime = Date.now();

  // Speculative request-body tap (≤16 KiB) — bodies stream to the app before
  // we know the response status, so 5xx debugging needs the copy made up
  // front. No-op for GET/HEAD/OPTIONS; idempotent across retries.
  const reqBodyTap = tapRequestBody(req, method);

  // Mutate request headers in place instead of spreading into a new object.
  // The same IncomingMessage isn't re-used after this function returns, so
  // mutation is safe and avoids one allocation per request.
  const outHeaders = req.headers;
  // Strip HTTP/2 pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`)
  // before forwarding to the HTTP/1.1 backend. Node's http.request rejects
  // any header name starting with `:`. Cheap loop — for HTTP/1.1 requests
  // there's nothing to delete.
  for (const key in outHeaders) {
    if (key.charCodeAt(0) === 58 /* ':' */) delete outHeaders[key];
  }
  const originalHost = outHeaders.host || (req.headers[':authority'] as string | undefined) || '';
  const xff = outHeaders['x-forwarded-for'] as string | undefined;
  const remoteAddr = req.socket.remoteAddress || '';
  outHeaders.host = `localhost:${deployment.port}`;
  outHeaders['x-forwarded-host'] = originalHost;
  outHeaders['x-forwarded-proto'] =
    (xff && (outHeaders['x-forwarded-proto'] as string)) ||
    ((req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http');
  outHeaders['x-forwarded-for'] = xff || remoteAddr;

  const proxyReq = httpRequest(
    {
      agent: proxyAgent,
      hostname: 'localhost',
      port: deployment.port,
      path: search ? targetPath + search : targetPath,
      method,
      headers: outHeaders,
    },
    (proxyRes) => {
      const proxyHeaders = proxyRes.headers;
      // Strip RFC 7230 §6.1 hop-by-hop headers + Node's `Keep-Alive` extension
      // before forwarding to the client. HTTP/2 explicitly forbids them in
      // responses (Node errors with ERR_HTTP2_INVALID_CONNECTION_HEADERS) and
      // they're meaningless across a proxy hop anyway. The deletes are no-ops
      // when the backend didn't set them.
      delete proxyHeaders.connection;
      delete proxyHeaders['keep-alive'];
      delete proxyHeaders['proxy-authenticate'];
      delete proxyHeaders['proxy-authorization'];
      delete proxyHeaders.te;
      delete proxyHeaders.trailer;
      delete proxyHeaders['transfer-encoding'];
      delete proxyHeaders.upgrade;
      // CORS for cross-origin XHR/fetch into deployed apps from other tabs.
      // Mutate the response headers in place — they're only consumed once here.
      proxyHeaders['access-control-allow-origin'] = '*';

      // Long-lived streams (SSE, or any backend that set `x-accel-buffering: no`)
      // need to flow through untouched: no gzip buffering, no idle timeout.
      const contentType = proxyHeaders['content-type'] || '';
      const isStream =
        contentType.includes('text/event-stream') || proxyHeaders['x-accel-buffering'] === 'no';
      if (isStream) {
        proxyReq.setTimeout(0);
      }

      // Compression decision. Skip the cost of parsing/checking when the
      // response is already compressed by the backend.
      const existingEncoding = proxyHeaders['content-encoding'];
      const status = proxyRes.statusCode!;
      let shouldCompress = false;
      if (!isStream && !existingEncoding && status !== 204 && status !== 304) {
        const acceptEncoding = req.headers['accept-encoding'];
        if (acceptEncoding && acceptEncoding.includes('gzip')) {
          const lenStr = proxyHeaders['content-length'];
          const len = lenStr ? +lenStr : 0;
          // Compress text-shaped payloads ≥1 KiB (or unknown length).
          if (
            (len === 0 || len >= 1024) &&
            (contentType.includes('text/') ||
              contentType.includes('application/json') ||
              contentType.includes('application/javascript'))
          ) {
            shouldCompress = true;
          }
        }
      }

      // 5xx capture: snapshot headers now (before the gzip branch mutates
      // them) and tap the pre-gzip response body; the capture file is written
      // once the response finishes. Healthy responses skip all of this.
      let captureId: string | null = null;
      if (status >= 500) {
        captureId = beginCapture(deployment.name);
        if (captureId) {
          const respTap = createBodyTap(proxyRes, RESPONSE_BODY_CAP);
          const capturedReqHeaders = { ...req.headers };
          const capturedResHeaders = { ...proxyHeaders };
          let written = false;
          const finish = () => {
            if (written) return;
            written = true;
            writeCapture({
              id: captureId!,
              deploymentName: deployment.name,
              timestamp: startTime,
              method,
              path: targetPath,
              query: search || null,
              status,
              durationMs: Date.now() - startTime,
              request: {
                headers: capturedReqHeaders,
                ...decodeBody(reqBodyTap, capturedReqHeaders['content-type'] as string | undefined),
              },
              response: {
                headers: capturedResHeaders,
                ...decodeBody(respTap, capturedResHeaders['content-type'] as string | undefined),
              },
            });
          };
          proxyRes.once('end', finish);
          // 'close' without 'end' = client aborted mid-body; keep what we have.
          proxyRes.once('close', finish);
        }
      }

      if (shouldCompress) {
        proxyHeaders['content-encoding'] = 'gzip';
        delete proxyHeaders['content-length'];
        res.writeHead(status, proxyHeaders);
        // Level 1: on LAN links bandwidth is cheap and CPU is the constrained
        // resource — fastest setting costs a few % size for ~3-4x less CPU
        // than the zlib default (6).
        proxyRes.pipe(createGzip({ level: 1 })).pipe(res);
      } else {
        res.writeHead(status, proxyHeaders);
        proxyRes.pipe(res);
      }

      // Defer logging until the response is flushed — the client sees data
      // first, the request log row gets buffered a tick later. Pre-capture
      // only the cheap-to-read bits; build the log entry inside setImmediate
      // so we don't pay for it on the hot path.
      const responseSize = proxyHeaders['content-length'] ? +proxyHeaders['content-length'] : null;
      const queryParams = search || null;
      const username = (req.headers['x-deploy-username'] as string | null) || null;
      const userAgent = req.headers['user-agent'] || null;
      const referrer = req.headers['referer'] || null;
      const requestSize = req.headers['content-length']
        ? +(req.headers['content-length'] as string)
        : 0;
      const ip = xff ? xff.split(',')[0].trim() : remoteAddr || 'unknown';
      const duration = Date.now() - startTime;

      setImmediate(() => {
        const entry = {
          method,
          path: targetPath,
          status,
          duration,
          timestamp: Date.now(),
          ip,
          userAgent,
          referrer,
          requestSize,
          responseSize,
          queryParams,
          username,
          captureId,
        };
        deps.logRequest(deployment.name, entry);
        deps.emitEvent({ type: 'request:logged', deploymentName: deployment.name, data: entry });
      });
    },
  );

  // Fail fast on hung backends. setTimeout on the request fires if the socket
  // is idle for the given window — works for both "TCP connected but never
  // responding" and "response started but stalled mid-stream". On fire we
  // destroy the request, which triggers the 'error' handler below.
  proxyReq.setTimeout(PROXY_RESPONSE_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error('proxy_timeout'));
  });

  proxyReq.on('error', (err) => {
    const isTimeout = (err as Error & { message?: string }).message === 'proxy_timeout';
    // Only retry idempotent methods — the body of a non-GET/HEAD request was
    // piped to the upstream and is no longer replayable. Exponential backoff
    // before the next attempt: collapses thundering-herd from many concurrent
    // stale sockets to ~one retry per window.
    if (retryCount < PROXY_MAX_RETRIES && !isTimeout && (method === 'GET' || method === 'HEAD')) {
      const delay = Math.min(PROXY_RETRY_BASE_MS * Math.pow(2, retryCount), PROXY_RETRY_CAP_MS);
      setTimeout(() => {
        const retryReq = proxyToApp(
          deps,
          req,
          res,
          deployment,
          targetPath,
          search,
          method,
          retryCount + 1,
        );
        retryReq.end();
      }, delay);
      return;
    }

    // Distinguish failure mode in logs so the dashboard can show "timed out"
    // vs. "connection refused" — both are 502 to the client but they mean
    // very different things operationally.
    const failureReason = isTimeout
      ? 'timeout'
      : (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ? 'refused'
        : 'error';

    setImmediate(() => {
      const duration = Date.now() - startTime;
      // The app never responded, so the capture holds the request side plus
      // the failure reason — enough to see WHAT was being asked when the
      // backend timed out or refused.
      const captureId = beginCapture(deployment.name);
      if (captureId) {
        const reqHeaders = { ...req.headers };
        writeCapture({
          id: captureId,
          deploymentName: deployment.name,
          timestamp: startTime,
          method,
          path: targetPath,
          query: search || null,
          status: 502,
          durationMs: duration,
          failureReason,
          request: {
            headers: reqHeaders,
            ...decodeBody(reqBodyTap, reqHeaders['content-type'] as string | undefined),
          },
          response: null,
        });
      }
      const entry = {
        method,
        path: targetPath,
        status: 502,
        duration,
        timestamp: Date.now(),
        ip: xff ? xff.split(',')[0].trim() : remoteAddr || 'unknown',
        userAgent: (req.headers['user-agent'] as string | null) || null,
        referrer: (req.headers['referer'] as string | null) || null,
        requestSize: req.headers['content-length'] ? +(req.headers['content-length'] as string) : 0,
        responseSize: 0,
        queryParams: search || null,
        username: (req.headers['x-deploy-username'] as string | null) || null,
        captureId,
      };
      deps.logRequest(deployment.name, entry);
      deps.emitEvent({
        type: 'request:logged',
        deploymentName: deployment.name,
        data: { ...entry, failureReason },
      });
    });

    if (!res.headersSent) {
      appStartingPage(res, deployment.name);
    } else {
      res.end();
    }
  });

  return proxyReq;
}

/**
 * Hot-path middleware factory. Returns a handler that serves the request when
 * the hostname is a proxied app host (returns true), or declines (false) so
 * the caller can continue with API/dashboard routing.
 */
export function createHotPathHandler(deps: HotPathDeps) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    // Hand-parse the URL to avoid the `new URL(...)` cost (≈3-8 µs/request)
    // when the request is just a proxied app hit.
    //
    // For HTTP/2 requests, the `Host` header is replaced by the `:authority`
    // pseudo-header. Node's compat layer aliases :authority → host on
    // `req.headers`, but only for "real" HTTP/2 streams; some clients (h2load,
    // certain HTTP/2 ping frames) skip it. Read both so we degrade safely.
    const rawUrl = req.url!;
    const method = req.method;
    const hostHeader =
      req.headers.host || (req.headers[':authority'] as string | undefined) || 'deploy.local';
    const colonIdx = hostHeader.indexOf(':');
    const hostname = colonIdx === -1 ? hostHeader : hostHeader.substring(0, colonIdx);

    if (
      method !== 'OPTIONS' &&
      hostname.length > 6 && // ".local"
      hostname.endsWith('.local') &&
      hostname !== 'deploy.local' &&
      hostname !== 'discover.local'
    ) {
      const appName = hostname.substring(0, hostname.length - 6);
      // O(1) in-memory map lookup.
      const d = deps.getRoute(appName);
      if (!d) {
        appNotFoundPage(res, appName);
        return true;
      }
      const queryIdx = rawUrl.indexOf('?');
      const targetPath = queryIdx === -1 ? rawUrl : rawUrl.substring(0, queryIdx);
      const search = queryIdx === -1 ? '' : rawUrl.substring(queryIdx);
      const proxyReq = proxyToApp(deps, req, res, d, targetPath, search, method!);
      req.pipe(proxyReq);
      return true;
    }

    return false;
  };
}
