/**
 * Dashboard/API forwarding from the edge to the control plane.
 *
 * A plain pipe proxy with three jobs beyond copying bytes:
 *
 *  - Release the upstream request whenever the client leaves before the
 *    response is delivered. On HTTP/2 a client cancel before response headers
 *    reports `writableFinished === true`, so "close but not finished" is
 *    tracked from our own `finish` event rather than the response's getters.
 *    A missed cancel used to pin a pooled control socket for good: the late
 *    upstream response piped into a dead stream that never drains.
 *  - Retry idempotent requests across a control-plane restart (connection
 *    refused) and across a stale keep-alive socket, but never on behalf of a
 *    client that already left and never for a slow response.
 *  - Report what actually failed. "control plane restarting" means control
 *    refused the connection; a reset or timeout gets its own status and text.
 */

import {
  Agent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { controlFailurePage } from '../error-page.ts';
import { controlRestartingPage } from './restarting.ts';

// A control-plane restart takes well under a second (supervisor backoff
// starts at 250ms) plus a few seconds of boot. Retrying idempotent requests
// across that window makes restarts invisible to the dashboard — instead of
// a flash of 503s (which, for hashed asset URLs, the browser surfaces as
// module MIME errors), in-flight page loads just stall briefly.
export const CONTROL_RETRY_WINDOW_MS = 8_000;
export const CONTROL_RETRY_DELAY_MS = 250;

/** Connection-scoped headers that must not cross the proxy (and are illegal in HTTP/2). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'http2-settings',
]);

export type ControlFailureKind = 'unreachable' | 'reset' | 'timeout' | 'failed';

export interface ControlFailure {
  kind: ControlFailureKind;
  status: number;
  error: string;
}

/**
 * Classify a request error that happened before control sent response headers.
 * Only a refused connection means control is not listening (restarting).
 */
export function classifyControlError(err: NodeJS.ErrnoException): ControlFailure {
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ENOENT':
    case 'EADDRNOTAVAIL':
      return { kind: 'unreachable', status: 503, error: 'control plane restarting' };
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return { kind: 'timeout', status: 504, error: 'control plane did not respond in time' };
    case 'ECONNRESET':
    case 'EPIPE':
      return {
        kind: 'reset',
        status: 502,
        error: 'control plane closed the connection before responding',
      };
    default:
      return {
        kind: 'failed',
        status: 502,
        error: `control plane request failed${err.code ? ` (${err.code})` : ''}`,
      };
  }
}

function copyHeaders(source: IncomingMessage['headers'], skipPseudo: boolean) {
  const headers: OutgoingHttpHeaders = {};
  for (const key in source) {
    if (skipPseudo && key.charCodeAt(0) === 58 /* ':' */) continue;
    if (HOP_BY_HOP.has(key)) continue;
    const value = source[key];
    if (value !== undefined) headers[key] = value;
  }
  return headers;
}

/** Only the edge's socket supplies forwarding metadata; never pass through a client's claims. */
export function controlRequestHeaders(req: IncomingMessage) {
  const headers = copyHeaders(req.headers, true);
  const authority = req.headers.host || req.headers[':authority'];
  if (typeof authority === 'string') headers.host = authority;
  headers['x-forwarded-proto'] = (req.socket as { encrypted?: boolean }).encrypted
    ? 'https'
    : 'http';
  headers['x-forwarded-for'] = req.socket.remoteAddress;
  return headers;
}

/**
 * Pooled sockets to control. Node's agent only honors the server's
 * `Keep-Alive: timeout=N` hint (closing an idle socket a second before
 * control would) when the agent itself has a `timeout`, and only while that
 * response header is still on the upstream message. Without both, a socket
 * control closed after its 5s keep-alive could be handed to the next request
 * and fail with ECONNRESET, which used to surface as "control plane
 * restarting". The timeout only expires idle pooled sockets; an active
 * request has no 'timeout' listener and is never cut off by it.
 */
export function createControlAgent() {
  return new Agent({ keepAlive: true, maxSockets: 64, timeout: 60_000 });
}

export interface ControlForwarderOptions {
  port: number;
  host?: string;
  agent?: Agent;
  retryWindowMs?: number;
  retryDelayMs?: number;
}

export interface ForwardOptions {
  /** The request body was already consumed elsewhere; send GET/HEAD without one. */
  replayEmptyRequest?: boolean;
}

export function createControlForwarder(options: ControlForwarderOptions) {
  const host = options.host ?? '127.0.0.1';
  const agent = options.agent ?? createControlAgent();
  const retryWindowMs = options.retryWindowMs ?? CONTROL_RETRY_WINDOW_MS;
  const retryDelayMs = options.retryDelayMs ?? CONTROL_RETRY_DELAY_MS;

  function forward(req: IncomingMessage, res: ServerResponse, forwardOptions: ForwardOptions = {}) {
    // Read before anything touches the headers: on HTTP/2 compat requests
    // req.url/req.method are getters backed by headers[':path']/[':method'].
    const path = req.url || '/';
    const method = req.method || 'GET';
    const headers = controlRequestHeaders(req);
    const replayable = method === 'GET' || method === 'HEAD';

    let current: ClientRequest | null = null;
    let delivered = false;
    let clientGone = false;
    let retryDeadline = 0;
    let retryTimer: NodeJS.Timeout | null = null;

    // `finish` and `writableFinished` cannot tell delivery from a cancel on
    // HTTP/2: the compat response emits `finish` for every closed stream. The
    // response counts as delivered once control's body ended (or the edge
    // answered with its own error).
    res.once('close', () => {
      if (delivered) return;
      clientGone = true;
      if (retryTimer) clearTimeout(retryTimer);
      current?.destroy();
    });

    function fail(failure: ControlFailure) {
      if (clientGone || res.headersSent || res.destroyed) return;
      delivered = true;
      if (failure.kind === 'unreachable' && !path.startsWith('/api/')) {
        controlRestartingPage(res);
        return;
      }
      if (path.startsWith('/api/')) {
        res.writeHead(failure.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify({ error: failure.error }));
      } else {
        controlFailurePage(res, failure.status, failure.error);
      }
    }

    function attempt(sendBody: boolean) {
      if (clientGone) return;
      const proxyReq = httpRequest(
        { agent, hostname: host, port: options.port, path, method, headers },
        (proxyRes) => {
          if (clientGone) {
            proxyRes.destroy();
            return;
          }
          res.writeHead(proxyRes.statusCode!, copyHeaders(proxyRes.headers, false));
          // pipe() honors backpressure on both HTTP/1 and HTTP/2 compat
          // responses. A body that stops short (control crashed mid-stream)
          // must not look complete to the client, so the downstream stream
          // is reset instead of ended.
          const abort = () => {
            if (!delivered) res.destroy(new Error('control response ended early'));
          };
          proxyRes.on('error', abort);
          proxyRes.on('aborted', abort);
          proxyRes.on('end', () => {
            delivered = true;
          });
          proxyRes.pipe(res);
        },
      );
      current = proxyReq;
      proxyReq.on('error', (err: NodeJS.ErrnoException) => {
        if (clientGone) return;
        if (res.headersSent) {
          if (!delivered) res.destroy(err);
          return;
        }
        const failure = classifyControlError(err);
        const now = Date.now();
        if (!retryDeadline) retryDeadline = now + retryWindowMs;
        const retry =
          replayable &&
          now < retryDeadline &&
          (failure.kind === 'unreachable' || failure.kind === 'reset');
        if (!retry) {
          fail(failure);
          return;
        }
        // A pooled socket that control closed while idle fails immediately on
        // reuse; retrying at once gets a fresh connection. Anything else waits
        // out the restart, within a window that starts at the first failure.
        const delay = failure.kind === 'reset' && proxyReq.reusedSocket ? 0 : retryDelayMs;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          attempt(false);
        }, delay);
      });
      if (sendBody) req.pipe(proxyReq);
      else proxyReq.end();
    }

    attempt(!forwardOptions.replayEmptyRequest);
  }

  return { forward, agent };
}
