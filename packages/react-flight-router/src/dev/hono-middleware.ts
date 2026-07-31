import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import type { Hono } from "hono";

/**
 * Bridges a Hono app into Vite's connect-style middleware stack.
 *
 * Production serves the user's routes from the Hono app directly. Development
 * runs inside Vite, whose middlewares are Node req/res — so the same Hono app
 * has to be adapted. Keeping the adaptation here is what lets one `extend`
 * hook behave identically in both environments.
 */

/**
 * Marks a response as "no route matched, keep going". A trailing catch-all is
 * used rather than `app.notFound()` so apps stay free to define their own
 * not-found handler for the routes they do own.
 */
const FALLTHROUGH_HEADER = "x-react-flight-router-fallthrough";

/** Registers the sentinel. Must run *after* the user's routes. */
export function appendFallthroughRoute(app: Hono): void {
  app.all("*", () => new Response(null, { status: 404, headers: { [FALLTHROUGH_HEADER]: "1" } }));
}

export function isFallthrough(response: Response): boolean {
  return response.headers.has(FALLTHROUGH_HEADER);
}

export function toWebRequest(request: IncomingMessage): Request {
  const encrypted = (request.socket as Socket & { encrypted?: boolean }).encrypted;
  const origin = `${encrypted ? "https" : "http"}://${request.headers.host ?? "localhost"}`;
  const url = new URL(request.url ?? "/", origin);

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else {
      headers.set(name, value);
    }
  }

  const method = request.method ?? "GET";
  // GET/HEAD must not carry a body, and Node streams need `duplex: "half"`.
  const body =
    method === "GET" || method === "HEAD" ? undefined : (Readable.toWeb(request) as ReadableStream);

  return new Request(url, {
    method,
    headers,
    body,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit);
}

export async function writeWebResponse(response: Response, target: ServerResponse): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name.toLowerCase() === "set-cookie") return;
    target.setHeader(name, value);
  });
  // Multiple Set-Cookie headers have to be set as an array, not joined.
  const cookies = response.headers.getSetCookie?.();
  if (cookies?.length) target.setHeader("set-cookie", cookies);

  if (!response.body) {
    target.end();
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      target.write(value);
    }
  } finally {
    target.end();
  }
}

type NextFunction = (error?: unknown) => void;

/**
 * Connect middleware that offers each request to `app`, and calls `next()`
 * when no route matched so Vite and the router still get their turn.
 */
export function createExtendMiddleware(app: Hono) {
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const result = await app.fetch(toWebRequest(request));
      if (isFallthrough(result)) {
        next();
        return;
      }
      await writeWebResponse(result, response);
    } catch (error) {
      next(error);
    }
  };
}
