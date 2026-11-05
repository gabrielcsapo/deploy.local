/**
 * Hono context shape that exposes Node's IncomingMessage / ServerResponse
 * via env.incoming / env.outgoing (provided by @hono/node-server).
 * `env` is typed as `any` to accept Hono's loosely-typed context without
 * losing access to the Node-adapter fields we depend on.
 */
export interface NodeAdapterContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  env: any;
  req: { raw: Request };
}

/**
 * Get an AbortSignal that fires when the client disconnects.
 *
 * Uses the incoming request's TCP socket to detect connection drops. This
 * catches forceful disconnects (e.g., `http.request().destroy()`) and
 * streaming responses where the browser closes the connection.
 *
 * Limitation: HTTP/1.1 browsers with keep-alive do NOT close the TCP socket
 * when aborting a fetch via AbortController — the connection stays alive for
 * potential reuse. Cancellation of non-streaming server renders (e.g., routes
 * with `await delay()`) is only detected when the client forcefully closes
 * the socket or when using HTTP/2 (which sends RST_STREAM). Streaming
 * responses (Suspense) are detected because the browser closes the connection
 * when it stops consuming the chunked response.
 *
 * Listener cleanup: HTTP/1.1 keep-alive sockets serve many requests in
 * sequence. Without cleanup, every request would attach a new "close"
 * listener (each retaining an AbortController) for the lifetime of the
 * socket. We remove the listener as soon as the response finishes (or the
 * outgoing stream closes), so completed requests don't pin their AC in
 * memory until the socket finally drops.
 *
 * Falls back to c.req.raw.signal for non-Node adapters.
 */
export function getRequestSignal(c: NodeAdapterContext): AbortSignal {
  const incoming = c.env?.incoming;
  const outgoing = c.env?.outgoing;
  const socket = incoming?.socket;

  if (!socket) return c.req.raw.signal;

  const ac = new AbortController();
  if (socket.destroyed) {
    ac.abort();
    return ac.signal;
  }

  const onSocketClose = () => ac.abort();
  socket.on("close", onSocketClose);

  // Remove the listener when the response finishes so it doesn't accumulate
  // across keep-alive requests. The detach is idempotent — `off()` is a
  // no-op if the listener was already removed (e.g. fired then auto-removed).
  if (outgoing) {
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      socket.off("close", onSocketClose);
      outgoing.off("close", detach);
      outgoing.off("finish", detach);
    };
    outgoing.once("finish", detach);
    outgoing.once("close", detach);
  }

  return ac.signal;
}

/**
 * Pre-cleanup implementation, retained for the regression test in
 * request-signal.test.ts. Not used by the server.
 *
 * @internal
 */
export function legacyGetRequestSignal(c: NodeAdapterContext): AbortSignal {
  const incoming = c.env?.incoming;
  if (incoming?.socket) {
    const ac = new AbortController();
    const socket = incoming.socket;
    if (socket.destroyed) {
      ac.abort();
    } else {
      socket.on("close", () => {
        ac.abort();
      });
    }
    return ac.signal;
  }
  return c.req.raw.signal;
}
