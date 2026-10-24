import type { ServerHttp2Session, Settings } from 'node:http2';

/**
 * HTTP/2 flow control on the public listener.
 *
 * These windows bound what a *client* may send before the edge acknowledges
 * it (uploads, attachment and deploy-archive POSTs). Download speed is bound
 * by the windows the client advertises, which the server cannot raise.
 *
 * `initialWindowSize` only applies per stream; the connection-level window
 * stays at the protocol's 64 KiB unless it is raised on every session, which
 * capped every upload on a connection at 64 KiB per round trip regardless of
 * the stream window.
 */
export const EDGE_HTTP2_STREAM_WINDOW = 1024 * 1024;
export const EDGE_HTTP2_CONNECTION_WINDOW = 8 * 1024 * 1024;

export const EDGE_HTTP2_SETTINGS: Settings = { initialWindowSize: EDGE_HTTP2_STREAM_WINDOW };

export function tuneHttp2Session(session: ServerHttp2Session) {
  try {
    session.setLocalWindowSize(EDGE_HTTP2_CONNECTION_WINDOW);
  } catch {
    // The session can be destroyed before its first tick (client vanished).
  }
}
