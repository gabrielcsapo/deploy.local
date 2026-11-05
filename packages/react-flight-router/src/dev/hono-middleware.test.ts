// @vitest-environment node
// This bridge is Node-only server code. happy-dom's Headers has no working
// getSetCookie, which would make the Set-Cookie assertions meaningless.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  appendFallthroughRoute,
  createExtendMiddleware,
  isFallthrough,
  toWebRequest,
  writeWebResponse,
} from "./hono-middleware.js";

function fakeRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): IncomingMessage {
  const stream = new PassThrough();
  if (init.body) stream.end(init.body);
  else stream.end();

  return Object.assign(stream, {
    url,
    method: init.method ?? "GET",
    headers: { host: "localhost:5173", ...(init.headers ?? {}) },
    socket: {},
  }) as unknown as IncomingMessage;
}

/** Minimal ServerResponse stand-in that records what was written. */
function fakeResponse() {
  const chunks: Buffer[] = [];
  const headers: Record<string, string | string[]> = {};
  let ended = false;

  const res = {
    statusCode: 200,
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
    },
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
    get headers() {
      return headers;
    },
    get ended() {
      return ended;
    },
    get status() {
      return res.statusCode;
    },
  };
}

describe("toWebRequest", () => {
  it("builds an absolute URL from the host header", () => {
    const request = toWebRequest(fakeRequest("/api/rooms?code=abc"));
    expect(request.url).toBe("http://localhost:5173/api/rooms?code=abc");
    expect(request.method).toBe("GET");
  });

  it("carries headers across", () => {
    const request = toWebRequest(fakeRequest("/", { headers: { "x-token": "secret" } }));
    expect(request.headers.get("x-token")).toBe("secret");
  });

  it("omits a body for GET and HEAD", () => {
    expect(toWebRequest(fakeRequest("/", { method: "GET" })).body).toBeNull();
    expect(toWebRequest(fakeRequest("/", { method: "HEAD" })).body).toBeNull();
  });

  it("forwards a body for POST", async () => {
    const request = toWebRequest(
      fakeRequest("/api/move", { method: "POST", body: '{"unitId":"a"}' }),
    );
    expect(await request.text()).toBe('{"unitId":"a"}');
  });
});

describe("fallthrough", () => {
  it("flags unmatched routes and leaves matched ones alone", async () => {
    const app = new Hono();
    app.get("/mine", () => new Response("mine"));
    appendFallthroughRoute(app);

    const matched = await app.fetch(new Request("http://x/mine"));
    const unmatched = await app.fetch(new Request("http://x/theirs"));

    expect(isFallthrough(matched)).toBe(false);
    expect(isFallthrough(unmatched)).toBe(true);
  });

  it("does not hijack an app's own not-found handler", async () => {
    const app = new Hono();
    app.get("/api/*", (c) => c.text("api not found", 404));
    appendFallthroughRoute(app);

    const apiMiss = await app.fetch(new Request("http://x/api/nope"));
    expect(isFallthrough(apiMiss)).toBe(false);
    expect(await apiMiss.text()).toBe("api not found");
  });
});

describe("createExtendMiddleware", () => {
  it("writes a matched response and does not call next", async () => {
    const app = new Hono();
    app.get("/healthz", (c) => c.text("ok"));
    appendFallthroughRoute(app);

    const handle = createExtendMiddleware(app);
    const out = fakeResponse();
    let nextCalled = false;

    await handle(fakeRequest("/healthz"), out.res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(false);
    expect(out.status).toBe(200);
    expect(out.body).toBe("ok");
    expect(out.ended).toBe(true);
  });

  it("calls next when nothing matched", async () => {
    const app = new Hono();
    app.get("/healthz", (c) => c.text("ok"));
    appendFallthroughRoute(app);

    const handle = createExtendMiddleware(app);
    const out = fakeResponse();
    let nextCalled = false;

    await handle(fakeRequest("/some/page"), out.res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(out.ended).toBe(false);
  });

  it("forwards handler errors to next instead of hanging", async () => {
    const app = new Hono();
    app.get("/boom", () => {
      throw new Error("handler exploded");
    });
    // Hono converts a thrown error into a 500 rather than rejecting, so the
    // middleware should write it out like any other response.
    appendFallthroughRoute(app);

    const handle = createExtendMiddleware(app);
    const out = fakeResponse();
    let nextError: unknown = null;

    await handle(fakeRequest("/boom"), out.res, (error?: unknown) => {
      nextError = error;
    });

    expect(nextError).toBeNull();
    expect(out.status).toBe(500);
  });
});

describe("writeWebResponse", () => {
  it("copies status and headers", async () => {
    const out = fakeResponse();
    await writeWebResponse(
      new Response("payload", {
        status: 201,
        headers: { "content-type": "text/plain" },
      }),
      out.res,
    );

    expect(out.status).toBe(201);
    expect(out.headers["content-type"]).toBe("text/plain");
    expect(out.body).toBe("payload");
  });

  it("preserves multiple Set-Cookie headers as an array", async () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");

    const out = fakeResponse();
    await writeWebResponse(new Response(null, { headers }), out.res);

    expect(out.headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("ends the response when there is no body", async () => {
    const out = fakeResponse();
    await writeWebResponse(new Response(null, { status: 204 }), out.res);
    expect(out.ended).toBe(true);
    expect(out.body).toBe("");
  });
});
