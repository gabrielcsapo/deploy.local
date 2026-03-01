import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerPool, type WorkerPool } from "./worker-pool.js";

/**
 * Create a temporary build directory with minimal fixtures that the
 * action-worker.ts can initialize from. Uses mock RSC runtime stubs
 * instead of the full React + react-server-dom-webpack stack.
 */
function createTestFixtures(opts?: { actionModule?: string; actionModuleId?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "flight-worker-test-"));
  const serverDir = join(dir, "server");
  mkdirSync(serverDir, { recursive: true });
  mkdirSync(join(serverDir, "chunks"), { recursive: true });

  // Server actions manifest
  const actionId = opts?.actionModuleId ?? "test/action";
  writeFileSync(
    join(dir, "server-actions-manifest.json"),
    JSON.stringify({
      [actionId]: { id: actionId, name: "*", chunks: [] },
    }),
  );

  // RSC client manifest (empty — no client components needed for action tests)
  writeFileSync(join(dir, "rsc-client-manifest.json"), "{}");

  // Mock RSC runtime: renderToReadableStream serializes to JSON,
  // decodeReply parses JSON or returns FormData as-is
  writeFileSync(
    join(serverDir, "rsc-runtime.js"),
    `
export function renderToReadableStream(model, _manifest, _opts) {
  const encoded = new TextEncoder().encode(JSON.stringify(model));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    }
  });
}

export function decodeReply(body, _manifest) {
  if (typeof body === 'string') {
    try { return Promise.resolve(JSON.parse(body)); }
    catch { return Promise.resolve([body]); }
  }
  return Promise.resolve([body]);
}
`,
  );

  // Mock server action entry file that registers an action in the global registry
  const actionCode =
    opts?.actionModule ??
    `
globalThis.__flight_server_modules ??= {};
globalThis.__flight_server_modules["${actionId}"] = {
  default: async function testAction(...args) {
    return { result: "ok", args };
  },
  throwingAction: async function throwingAction() {
    throw new Error("Test action error");
  },
};
`;
  writeFileSync(join(serverDir, "server-action-test.js"), actionCode);

  return dir;
}

let pool: WorkerPool | null = null;
let fixtureDir: string | null = null;

afterEach(async () => {
  if (pool) {
    await pool.destroy();
    pool = null;
  }
  if (fixtureDir) {
    rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = null;
  }
});

describe("WorkerPool", () => {
  it("creates a pool and executes an action", async () => {
    fixtureDir = createTestFixtures();
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 1 });

    const { stream, done } = pool.dispatch({
      taskId: "test-1",
      actionId: "test/action#default",
      body: new TextEncoder().encode(JSON.stringify(["hello"])).buffer as ArrayBuffer,
      contentType: "text/plain",
      requestContext: {
        url: "http://localhost:3000/",
        method: "POST",
        headers: [["content-type", "text/plain"]],
      },
    });

    // Read the stream
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      chunks.push(value);
    }

    // Reconstruct buffer from chunks
    const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }
    const result = JSON.parse(new TextDecoder().decode(combined));

    assert.deepEqual(result, { result: "ok", args: ["hello"] });

    const { status } = await done;
    assert.equal(status, 200);
  });

  it("returns 404 for unknown action", async () => {
    fixtureDir = createTestFixtures();
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 1 });

    const { stream, done } = pool.dispatch({
      taskId: "test-2",
      actionId: "nonexistent/action#default",
      body: new TextEncoder().encode("[]").buffer as ArrayBuffer,
      contentType: "text/plain",
      requestContext: {
        url: "http://localhost:3000/",
        method: "POST",
        headers: [],
      },
    });

    // Stream should error
    const reader = stream.getReader();
    try {
      await reader.read();
      assert.fail("Expected stream to error");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Action not found/);
    }

    const { status } = await done;
    assert.equal(status, 404);
  });

  it("returns 500 when action throws", async () => {
    fixtureDir = createTestFixtures();
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 1 });

    const { stream, done } = pool.dispatch({
      taskId: "test-3",
      actionId: "test/action#throwingAction",
      body: new TextEncoder().encode("[]").buffer as ArrayBuffer,
      contentType: "text/plain",
      requestContext: {
        url: "http://localhost:3000/",
        method: "POST",
        headers: [],
      },
    });

    const reader = stream.getReader();
    try {
      await reader.read();
      assert.fail("Expected stream to error");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /Test action error/);
    }

    const { status } = await done;
    assert.equal(status, 500);
  });

  it("handles abort", async () => {
    // Create a slow action that waits long enough for the abort to arrive
    fixtureDir = createTestFixtures({
      actionModule: `
globalThis.__flight_server_modules ??= {};
globalThis.__flight_server_modules["test/action"] = {
  default: async function slowAction() {
    await new Promise(resolve => setTimeout(resolve, 500));
    return { result: "should not reach" };
  },
};
`,
    });

    pool = await createWorkerPool({ buildDir: fixtureDir, size: 1 });

    const { stream, done } = pool.dispatch({
      taskId: "test-4",
      actionId: "test/action#default",
      body: new TextEncoder().encode("[]").buffer as ArrayBuffer,
      contentType: "text/plain",
      requestContext: {
        url: "http://localhost:3000/",
        method: "POST",
        headers: [],
      },
    });

    // Abort after a short delay
    setTimeout(() => pool!.abort("test-4"), 50);

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      chunks.push(value);
    }

    // Stream should close cleanly (abort is client-initiated, not an error)
    const { status } = await done;
    assert.equal(status, 200);
  });

  it("respects timeout", async () => {
    fixtureDir = createTestFixtures({
      actionModule: `
globalThis.__flight_server_modules ??= {};
globalThis.__flight_server_modules["test/action"] = {
  default: async function slowAction() {
    await new Promise(resolve => setTimeout(resolve, 10000));
    return { result: "should not reach" };
  },
};
`,
    });

    // Very short timeout
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 1, timeout: 100 });

    const { stream, done } = pool.dispatch({
      taskId: "test-5",
      actionId: "test/action#default",
      body: new TextEncoder().encode("[]").buffer as ArrayBuffer,
      contentType: "text/plain",
      requestContext: {
        url: "http://localhost:3000/",
        method: "POST",
        headers: [],
      },
    });

    const reader = stream.getReader();
    try {
      await reader.read();
      assert.fail("Expected stream to error with timeout");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /timed out/);
    }

    const { status } = await done;
    assert.equal(status, 504);
  });

  it("creates multiple workers", async () => {
    fixtureDir = createTestFixtures();
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 3 });

    // Dispatch 3 actions concurrently — they should go to different workers
    const tasks = Array.from({ length: 3 }, (_, i) =>
      pool!.dispatch({
        taskId: `test-multi-${i}`,
        actionId: "test/action#default",
        body: new TextEncoder().encode(JSON.stringify([i])).buffer as ArrayBuffer,
        contentType: "text/plain",
        requestContext: {
          url: "http://localhost:3000/",
          method: "POST",
          headers: [],
        },
      }),
    );

    // All should complete successfully
    const results = await Promise.all(
      tasks.map(async ({ stream, done }) => {
        const reader = stream.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const combined = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }
        const { status } = await done;
        return { data: JSON.parse(new TextDecoder().decode(combined)), status };
      }),
    );

    for (let i = 0; i < 3; i++) {
      assert.equal(results[i].status, 200);
      assert.deepEqual(results[i].data, { result: "ok", args: [i] });
    }
  });

  it("destroys cleanly", async () => {
    fixtureDir = createTestFixtures();
    pool = await createWorkerPool({ buildDir: fixtureDir, size: 2 });
    await pool.destroy();

    // Dispatch after destroy should throw
    assert.throws(() => {
      pool!.dispatch({
        taskId: "test-destroyed",
        actionId: "test/action#default",
        body: new ArrayBuffer(0),
        contentType: "text/plain",
        requestContext: {
          url: "http://localhost:3000/",
          method: "POST",
          headers: [],
        },
      });
    }, /destroyed/);

    pool = null; // Already destroyed
  });
});
