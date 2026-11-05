import type { Hono } from "hono";
import type { Server as HttpServer } from "node:http";
import type { Http2SecureServer } from "node:http2";

/** Vite may hand back either server kind, so both are surfaced. */
export type ExtendHttpServer = HttpServer | Http2SecureServer;

/**
 * Everything an `extend` hook is handed.
 *
 * The same hook runs in development and production, so an app registers its
 * routes once and gets identical behaviour from `vite` and `node dist/server.js`.
 */
export interface ExtendContext {
  /**
   * Register custom HTTP routes here.
   *
   * These are matched before the framework's SSR catch-all, so any path the
   * framework does not already claim (`/assets/*`, the RSC endpoint, the
   * action endpoint) reaches your handlers. Requests that match nothing you
   * registered fall through to the router as normal.
   *
   * This is your own Hono instance in both modes, not the framework's, so
   * `onError` and `notFound` apply to the routes you register here and leave
   * the framework's own handling alone.
   *
   * Do not register a `*` catch-all — it would swallow every page request.
   */
  app: Hono;

  /**
   * The Node HTTP server, for `upgrade` handling (WebSockets).
   *
   * In development this is Vite's server. In production it is `null`, because
   * your entry file creates the server itself — call `serve()` and attach the
   * upgrade listener to what it returns.
   */
  httpServer: ExtendHttpServer | null;

  mode: "development" | "production";
}

export type ExtendHook = (context: ExtendContext) => void | Promise<void>;
