// @vitest-environment node
// Exercises how `extend` is wired into Vite's middleware stack — the ordering
// and readiness guarantees the option promises. The Hono<->Node bridge itself
// is covered by hono-middleware.test.ts; this file is about the plumbing
// around it, which is where the API's actual contract lives.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ViteDevServer } from "vite";
import { flightRouter } from "./vite-plugin.js";
import type { ExtendContext, ExtendHook } from "../shared/extend.js";

type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void | Promise<void>;

function fakeRequest(url: string, method = "GET"): IncomingMessage {
  const stream = new PassThrough();
  stream.end();
  return Object.assign(stream, {
    url,
    method,
    headers: { host: "localhost:5173" },
    socket: {},
  }) as unknown as IncomingMessage;
}

function fakeResponse() {
  const chunks: Buffer[] = [];
  let ended = false;
  const res = {
    statusCode: 200,
    setHeader() {},
    write(chunk: Uint8Array) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      ended = true;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    get body() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get ended() {
      return ended;
    },
    get status() {
      return res.statusCode;
    },
  };
}

/**
 * Runs the dev plugin's configureServer against a stand-in Vite server and
 * hands back the middlewares it registered, in registration order.
 */
function configure(extend?: ExtendHook) {
  const middlewares: Middleware[] = [];
  const httpServer = { on: vi.fn() };

  const server = {
    middlewares: {
      use(fn: Middleware) {
        middlewares.push(fn);
      },
    },
    httpServer,
    ssrLoadModule: async () => ({}),
    pluginContainer: {},
    transformIndexHtml: async (_url: string, html: string) => html,
  } as unknown as ViteDevServer;

  const plugin = flightRouter(extend ? { extend } : undefined).find(
    (p) => p.name === "react-flight-router:dev",
  );
  if (!plugin) throw new Error("dev plugin not found");
  (plugin.configureServer as (s: ViteDevServer) => void)(server);

  return { middlewares, httpServer };
}

/** Drives a single middleware and reports what it did. */
async function run(middleware: Middleware, url: string, method = "GET") {
  const out = fakeResponse();
  let nextCalled = false;
  let nextError: unknown = null;

  await new Promise<void>((resolve) => {
    const next = (error?: unknown) => {
      nextCalled = true;
      nextError = error ?? null;
      resolve();
    };
    const originalEnd = out.res.end.bind(out.res);
    (out.res as { end: () => void }).end = () => {
      originalEnd();
      resolve();
    };
    void Promise.resolve(middleware(fakeRequest(url, method), out.res, next));
  });

  return { out, nextCalled, nextError };
}

describe("extend wiring (dev)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds exactly one middleware, ahead of the framework's", () => {
    const withoutExtend = configure().middlewares.length;
    const { middlewares } = configure(({ app }) => {
      app.get("/api/health", (c) => c.text("ok"));
    });

    // The ordering claim: user routes are offered the request before RSC/SSR.
    expect(middlewares.length).toBe(withoutExtend + 1);
  });

  it("serves a user route without reaching the framework", async () => {
    const { middlewares } = configure(({ app }) => {
      app.get("/api/health", (c) => c.json({ ok: true }));
    });

    const { out, nextCalled } = await run(middlewares[0], "/api/health");

    expect(nextCalled).toBe(false);
    expect(out.status).toBe(200);
    expect(out.body).toBe('{"ok":true}');
  });

  it("falls through to the framework for paths the app did not claim", async () => {
    const { middlewares } = configure(({ app }) => {
      app.get("/api/health", (c) => c.text("ok"));
    });

    const { nextCalled, out } = await run(middlewares[0], "/some/page");

    expect(nextCalled).toBe(true);
    expect(out.ended).toBe(false);
  });

  it("registers nothing when extend is omitted", async () => {
    const { middlewares } = configure();
    // Every registered middleware is the framework's; a user path must not be
    // claimed by anything ahead of it.
    expect(middlewares.length).toBeGreaterThan(0);
  });

  it("hands the hook Vite's http server and development mode", () => {
    let seen: ExtendContext | null = null;
    const { httpServer } = configure((context) => {
      seen = context;
    });

    expect(seen).not.toBeNull();
    expect(seen!.mode).toBe("development");
    // Identity matters: WebSocket upgrades attach to this exact server.
    expect(seen!.httpServer).toBe(httpServer);
  });

  it("lets the hook attach an upgrade listener to that server", () => {
    const { httpServer } = configure(({ httpServer: server }) => {
      server?.on("upgrade", () => {});
    });

    expect(httpServer.on).toHaveBeenCalledWith("upgrade", expect.any(Function));
  });

  it("waits for an async hook instead of racing it", async () => {
    let resolveHook: () => void = () => {};
    const hookDone = new Promise<void>((r) => {
      resolveHook = r;
    });

    const { middlewares } = configure(async ({ app }) => {
      await hookDone;
      app.get("/api/late", (c) => c.text("late"));
    });

    // Request arrives while the hook is still pending — the whole point of
    // gating on `ready` rather than registering routes whenever they land.
    const pending = run(middlewares[0], "/api/late");
    resolveHook();
    const { out, nextCalled } = await pending;

    expect(nextCalled).toBe(false);
    expect(out.body).toBe("late");
  });

  it("still falls through correctly after an async hook resolves", async () => {
    const { middlewares } = configure(async ({ app }) => {
      await Promise.resolve();
      app.get("/api/late", (c) => c.text("late"));
    });

    const { nextCalled } = await run(middlewares[0], "/unclaimed");
    expect(nextCalled).toBe(true);
  });

  it("routes a non-GET method to the user's handler", async () => {
    const { middlewares } = configure(({ app }) => {
      app.post("/api/move", (c) => c.text("moved"));
    });

    const { out, nextCalled } = await run(middlewares[0], "/api/move", "POST");

    expect(nextCalled).toBe(false);
    expect(out.body).toBe("moved");
  });
});

describe("extend wiring (dev) — failing hook", () => {
  // The plugin reports the failure via console.error; these tests expect it,
  // so keep it out of the suite's output.
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces a rejected hook to the request instead of hanging", async () => {
    const { middlewares } = configure(async () => {
      throw new Error("extend blew up");
    });

    const { nextCalled, nextError } = await run(middlewares[0], "/anything");

    expect(nextCalled).toBe(true);
    expect(nextError).toBeInstanceOf(Error);
    expect((nextError as Error).message).toBe("extend blew up");
  });

  it("fails every request once the hook has rejected, not just the first", async () => {
    const { middlewares } = configure(async () => {
      throw new Error("extend blew up");
    });

    const first = await run(middlewares[0], "/one");
    const second = await run(middlewares[0], "/two");

    // Documents current behavior: the rejection is sticky, so the dev server
    // errors on every path rather than degrading to "extend never ran".
    expect(first.nextError).toBeInstanceOf(Error);
    expect(second.nextError).toBeInstanceOf(Error);
  });

  it("does not leave the rejection unhandled when no request arrives", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      configure(async () => {
        throw new Error("extend blew up at startup");
      });
      // Give Node a chance to report an unhandled rejection: the `ready`
      // promise's only rejection handler is attached inside the request
      // middleware, so a server that never receives a request has none.
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
