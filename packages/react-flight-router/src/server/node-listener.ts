import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';

/** A `node:http` request or a `node:http2` compatibility-API request. */
export type NodeRequest = IncomingMessage | Http2ServerRequest;
/** A `node:http` response or a `node:http2` compatibility-API response. */
export type NodeResponse = ServerResponse | Http2ServerResponse;

/** Env key under which the listener hands Hono handlers the disconnect signal. */
export const NODE_REQUEST_SIGNAL = '__rfrRequestSignal';

/** RFC 9110 §7.6.1 connection-specific headers. HTTP/2 rejects them outright. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type FetchHandler = (
  request: Request,
  env: Record<string, unknown>,
) => Response | Promise<Response>;

/** The fetch Request a Node request describes, aborted by `signal`. */
export function toWebRequest(req: NodeRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    // HTTP/2 pseudo-headers (:method, :path, :scheme, :authority) are not
    // valid fetch headers; their data is in method, url and the origin below.
    if (value === undefined || key.charCodeAt(0) === 58 /* ':' */) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  const host = req.headers.host || (req.headers[':authority'] as string | undefined) || 'localhost';
  const scheme =
    (req.headers[':scheme'] as string | undefined) ||
    ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http');
  const url = new URL(req.url || '/', `${scheme}://${host}`);
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, {
    method,
    headers,
    signal,
    body: hasBody ? (Readable.toWeb(req as Readable) as ReadableStream<Uint8Array>) : undefined,
    // Node's fetch needs this to accept a streaming request body.
    ...(hasBody ? { duplex: 'half' } : {}),
  } as RequestInit);
}

/**
 * Copy a fetch Response body to a Node response at the client's pace: wait
 * for 'drain' when the socket is full, and cancel the body (which stops its
 * producer) when the client goes away. Does not end the response.
 */
export async function pipeWebBody(
  body: ReadableStream<Uint8Array>,
  res: Pick<ServerResponse, 'write' | 'on' | 'once' | 'off' | 'destroyed'>,
): Promise<void> {
  const reader = body.getReader();
  let closed = false;
  let wake: (() => void) | null = null;
  const onClose = () => {
    closed = true;
    wake?.();
    void reader.cancel().catch(() => {});
  };
  const onDrain = () => wake?.();
  res.once('close', onClose);
  res.on('drain', onDrain);
  try {
    while (!closed && !res.destroyed) {
      const { done, value } = await reader.read();
      if (done || closed || res.destroyed) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    }
  } finally {
    res.off('close', onClose);
    res.off('drain', onDrain);
    // Covers a response destroyed without a 'close' seen here; a finished read ignores it.
    if (closed || res.destroyed) void reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
}

/**
 * A `(req, res)` listener for `node:http` and the `node:http2` compatibility
 * API that serves `fetch`. A client that disconnects aborts the request's
 * signal, so renders and actions stop.
 */
export function createNodeListener(
  fetch: FetchHandler,
  onError: (error: unknown) => void = (error) =>
    console.error('[react-flight-router] Request failed:', error),
) {
  return async function nodeListener(req: NodeRequest, res: NodeResponse): Promise<void> {
    const out = res as ServerResponse;
    const abort = new AbortController();
    // Not 'finish': the HTTP/2 compatibility API emits it for a reset stream too.
    let ended = false;
    out.once('close', () => {
      if (!ended) abort.abort();
    });
    const end = (chunk?: string) => {
      ended = true;
      out.end(chunk);
    };
    try {
      const request = toWebRequest(req, abort.signal);
      const response = await fetch(request, {
        incoming: req,
        outgoing: res,
        [NODE_REQUEST_SIGNAL]: abort.signal,
      });
      if (out.destroyed) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      const headers: Record<string, string | string[]> = {};
      response.headers.forEach((value, key) => {
        if (HOP_BY_HOP.has(key) || key === 'set-cookie') return;
        headers[key] = value;
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
      out.writeHead(response.status, headers);
      if (response.body && req.method !== 'HEAD') await pipeWebBody(response.body, out);
      else void response.body?.cancel().catch(() => {});
      if (!out.destroyed) end();
    } catch (error) {
      if (abort.signal.aborted) return;
      onError(error);
      if (out.destroyed) return;
      if (!out.headersSent) {
        out.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        end('Internal Server Error');
      } else {
        // The status line is gone; a truncated body must not look complete.
        out.destroy();
      }
    }
  };
}
