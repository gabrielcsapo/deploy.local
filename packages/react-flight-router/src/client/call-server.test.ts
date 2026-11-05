import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * callServer must fail LOUDLY on non-flight responses. Feeding HTML (a
 * reverse proxy's "starting up" page during a deploy, or an auth
 * middleware's 302 that fetch silently followed) into
 * createFromReadableStream produces a promise that never settles — a
 * permanent, silent hang at every action call site. Regression coverage for
 * the content-type guard.
 */

// callServer dynamically imports the RSC client runtime — mock it so tests
// run without a react-server build. createFromReadableStream resolves with a
// sentinel so we can tell "stream handed to flight" from "guard threw".
const createFromReadableStream = vi.fn(async () => ({ flight: "ok" }));
vi.mock("react-server-dom-webpack/client.browser", () => ({
  encodeReply: async (args: unknown[]) => JSON.stringify(args),
  createFromReadableStream,
}));

import { callServer } from "./call-server.js";

function flightResponse(body = '0:{"ok":true}\n'): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/x-component" },
  });
}

function htmlResponse(status = 200): Response {
  return new Response("<!DOCTYPE html><html><body>Starting Up</body></html>", {
    status,
    headers: { "Content-Type": "text/html" },
  });
}

beforeEach(() => {
  createFromReadableStream.mockClear();
});

describe("callServer", () => {
  it("resolves a flight response through createFromReadableStream", async () => {
    globalThis.fetch = vi.fn(async () => flightResponse()) as unknown as typeof fetch;

    const result = await callServer("app/actions/x#doThing", []);
    expect(result).toEqual({ flight: "ok" });
    expect(createFromReadableStream).toHaveBeenCalledTimes(1);
  });

  it("throws (rather than hanging forever) when the response is not a flight payload", async () => {
    // The exact production failure: a proxy serves its HTML placeholder with
    // 200 while the app boots. Before the guard, this hung every caller.
    globalThis.fetch = vi.fn(async () => htmlResponse()) as unknown as typeof fetch;

    await expect(callServer("app/actions/x#doThing", [])).rejects.toThrow(
      /not a flight payload|content-type "text\/html"/,
    );
    expect(createFromReadableStream).not.toHaveBeenCalled();
  });

  it("names the redirect when fetch transparently followed one to HTML", async () => {
    // e.g. an auth middleware 302s POST /__action → /profiles; fetch follows
    // and lands on an HTML page with response.redirected = true.
    const redirected = htmlResponse();
    Object.defineProperty(redirected, "redirected", { value: true });
    Object.defineProperty(redirected, "url", { value: "https://app.local/profiles" });
    globalThis.fetch = vi.fn(async () => redirected) as unknown as typeof fetch;

    await expect(callServer("app/actions/x#doThing", [])).rejects.toThrow(
      /redirect.*profiles|profiles.*redirect/s,
    );
    expect(createFromReadableStream).not.toHaveBeenCalled();
  });

  it("throws on non-ok responses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;

    await expect(callServer("app/actions/x#doThing", [])).rejects.toThrow(/Server action failed/);
  });

  it("throws when a flight response has no body", async () => {
    const res = new Response(null, {
      status: 200,
      headers: { "Content-Type": "text/x-component" },
    });
    // Response(null) has body === null already; make it explicit for clarity.
    globalThis.fetch = vi.fn(async () => res) as unknown as typeof fetch;

    await expect(callServer("app/actions/x#doThing", [])).rejects.toThrow(/no body/);
  });

  it("accepts content-type with parameters (charset)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('0:{"ok":true}\n', {
          status: 200,
          headers: { "Content-Type": "text/x-component; charset=utf-8" },
        }),
    ) as unknown as typeof fetch;

    const result = await callServer("app/actions/x#doThing", []);
    expect(result).toEqual({ flight: "ok" });
  });
});
