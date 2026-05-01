import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { getRequestSignal, legacyGetRequestSignal } from "./request-signal.js";

/**
 * Build a mock @hono/node-server context. The IncomingMessage,
 * ServerResponse, and Socket all extend EventEmitter in the real Node
 * stack, so EventEmitter mocks cover the surface we touch.
 */
function makeMockContext(socket: EventEmitter & { destroyed?: boolean }) {
  const incoming = Object.assign(new EventEmitter(), { socket });
  const outgoing = new EventEmitter();
  const rawSignal = new AbortController().signal;
  return {
    env: { incoming, outgoing },
    req: { raw: { signal: rawSignal } as Request },
    incoming,
    outgoing,
    socket,
  };
}

function makeSocket(): EventEmitter & { destroyed: boolean } {
  const s = new EventEmitter() as EventEmitter & { destroyed: boolean };
  s.destroyed = false;
  // Silence Node's "Possible EventEmitter memory leak" warning — the legacy
  // tests intentionally attach >10 listeners to demonstrate the leak we're
  // fixing; the leak itself is the assertion.
  s.setMaxListeners(0);
  return s;
}

describe("getRequestSignal — correctness", () => {
  it("returns an AbortSignal that fires when the socket closes mid-request", () => {
    const socket = makeSocket();
    const c = makeMockContext(socket);
    const signal = getRequestSignal(c);

    expect(signal.aborted).toBe(false);
    socket.emit("close");
    expect(signal.aborted).toBe(true);
  });

  it("returns an already-aborted signal when the socket is already destroyed", () => {
    const socket = makeSocket();
    socket.destroyed = true;
    const c = makeMockContext(socket);
    const signal = getRequestSignal(c);
    expect(signal.aborted).toBe(true);
  });

  it("falls back to req.raw.signal when no Node socket is available", () => {
    const fallback = new AbortController();
    const c = {
      env: undefined,
      req: { raw: { signal: fallback.signal } as Request },
    };
    const signal = getRequestSignal(c);
    expect(signal).toBe(fallback.signal);
  });
});

describe("getRequestSignal — listener cleanup", () => {
  it("removes the socket listener when the response finishes", () => {
    const socket = makeSocket();
    const c = makeMockContext(socket);

    expect(socket.listenerCount("close")).toBe(0);
    getRequestSignal(c);
    expect(socket.listenerCount("close")).toBe(1);

    c.outgoing.emit("finish");
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("removes the socket listener when the response stream closes (e.g. error)", () => {
    const socket = makeSocket();
    const c = makeMockContext(socket);

    getRequestSignal(c);
    expect(socket.listenerCount("close")).toBe(1);

    c.outgoing.emit("close");
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("does not double-detach when both 'finish' and 'close' fire", () => {
    const socket = makeSocket();
    const c = makeMockContext(socket);

    getRequestSignal(c);
    c.outgoing.emit("finish");
    // 'close' fires after 'finish' on a normal HTTP response in Node
    c.outgoing.emit("close");
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("a socket close after detach does NOT abort the signal (request already done)", () => {
    const socket = makeSocket();
    const c = makeMockContext(socket);
    const signal = getRequestSignal(c);

    c.outgoing.emit("finish");
    socket.emit("close"); // socket close after request done — handler is gone
    expect(signal.aborted).toBe(false);
  });
});

describe("getRequestSignal — keep-alive accumulation", () => {
  it("does not accumulate listeners across many requests sharing one socket (new impl)", () => {
    const socket = makeSocket();
    for (let i = 0; i < 100; i++) {
      const c = makeMockContext(socket);
      getRequestSignal(c);
      // Simulate response completion
      c.outgoing.emit("finish");
    }
    expect(socket.listenerCount("close")).toBe(0);
  });

  it("legacy impl leaks one listener per request on a shared socket (regression baseline)", () => {
    const socket = makeSocket();
    const N = 100;
    for (let i = 0; i < N; i++) {
      const c = makeMockContext(socket);
      legacyGetRequestSignal(c);
      // Even though we "complete" the response, legacy doesn't clean up
      c.outgoing.emit("finish");
    }
    // The leak is exactly one listener per request
    expect(socket.listenerCount("close")).toBe(N);
  });

  it("A/B vs legacy: listeners on shared socket after 100 keep-alive requests", () => {
    const newSocket = makeSocket();
    const legacySocket = makeSocket();
    const N = 100;

    for (let i = 0; i < N; i++) {
      const newCtx = makeMockContext(newSocket);
      getRequestSignal(newCtx);
      newCtx.outgoing.emit("finish");

      const legacyCtx = makeMockContext(legacySocket);
      legacyGetRequestSignal(legacyCtx);
      legacyCtx.outgoing.emit("finish");
    }

    const newCount = newSocket.listenerCount("close");
    const legacyCount = legacySocket.listenerCount("close");
    // eslint-disable-next-line no-console
    console.log(
      `keep-alive socket after ${N} requests:  new=${newCount} listeners   legacy=${legacyCount} listeners`,
    );

    expect(newCount).toBe(0);
    expect(legacyCount).toBe(N);
  });
});
