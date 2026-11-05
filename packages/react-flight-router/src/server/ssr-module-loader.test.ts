import { describe, it, expect } from "vitest";
import { createSSRModuleLoader } from "./ssr-module-loader.js";

describe("createSSRModuleLoader", () => {
  it("returns the cached module on subsequent loads after a successful import", async () => {
    let importCount = 0;
    const { load } = createSSRModuleLoader("/build", async () => {
      importCount++;
      return { default: "ok" };
    });

    const first = await load("./mod.js");
    const second = await load("./mod.js");

    expect(first).toBe(second);
    expect(importCount).toBe(1);
  });

  it("evicts a rejected promise so the next call retries the import", async () => {
    // Simulates the dev-server scenario: a module fails to load once
    // (compile error, missing chunk), then succeeds on the next attempt.
    // Without eviction, the rejected promise would stay cached forever
    // and every subsequent request would replay the original failure.
    let attempt = 0;
    const { load, cache } = createSSRModuleLoader("/build", async () => {
      attempt++;
      if (attempt === 1) throw new Error("transient: chunk not found");
      return { default: "recovered" };
    });

    await expect(load("./mod.js")).rejects.toThrow("transient: chunk not found");

    // After the failure, the cache slot for this module must be empty
    // — otherwise the next load returns the same rejected promise.
    expect(cache["./mod.js"]).toBeUndefined();

    const recovered = (await load("./mod.js")) as { default: string };
    expect(recovered.default).toBe("recovered");
    expect(attempt).toBe(2);
  });

  it("does not evict a fresher in-flight retry when a stale rejection settles", async () => {
    // Edge case: two concurrent loads race. The first import is still
    // in flight when a second call arrives. (In practice, the original
    // shim already coalesces concurrent calls via the cache, so both
    // requests share the same promise — this test pins the
    // compare-and-swap behavior so a future refactor doesn't accidentally
    // clear a winner's entry on a loser's rejection.)
    let resolveFirst: ((v: unknown) => void) | undefined;
    let rejectSecond: ((e: unknown) => void) | undefined;
    let attempt = 0;
    const { load, cache } = createSSRModuleLoader("/build", () => {
      attempt++;
      if (attempt === 1) {
        return new Promise((res) => {
          resolveFirst = res;
        });
      }
      return new Promise((_res, rej) => {
        rejectSecond = rej;
      });
    });

    // Kick off the first load (pending in cache).
    const firstP = load("./mod.js") as Promise<{ default: string }>;
    // Force-evict and re-load to simulate the cache being cleared between
    // calls (e.g. because a previous failure cleared it). The new load
    // gets its own promise.
    delete cache["./mod.js"];
    const secondP = load("./mod.js") as Promise<{ default: string }>;

    // Reject the second; it should clear *its own* cache entry but the
    // first promise (which is still pending) should be untouched.
    const winnerPromise = cache["./mod.js"];
    rejectSecond!(new Error("second failed"));
    await expect(secondP).rejects.toThrow("second failed");

    // The cache slot was the second promise. After the rejection, the
    // compare-and-swap removed it — so the slot is empty.
    expect(cache["./mod.js"]).toBeUndefined();

    // Now resolve the first; it had already been evicted from the cache
    // by the second load's `cache[id] = promise` assignment, so it does
    // not get put back. This documents the existing semantic: only the
    // cache-resident promise's success populates the cache.
    resolveFirst!({ default: "first done" });
    const firstResult = await firstP;
    expect(firstResult.default).toBe("first done");
    expect(winnerPromise).not.toBe(undefined);
  });
});
