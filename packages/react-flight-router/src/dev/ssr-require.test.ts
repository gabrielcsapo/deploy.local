import { describe, it, expect } from "vitest";
import { createDevSSRRequire } from "./ssr-require.js";

function setup(loadModule: (ssrId: string) => Promise<unknown>) {
  const cache: Record<string, unknown> = {};
  const seen: string[] = [];
  const load = createDevSSRRequire({
    loadModule: (ssrId) => {
      seen.push(ssrId);
      return loadModule(ssrId);
    },
    toFilePath: (moduleId) => "/app" + moduleId,
    cache,
  });
  return { load, cache, seen };
}

describe("createDevSSRRequire", () => {
  it("appends ?ssr, or &ssr when the ID already has a query", async () => {
    const { load, seen } = setup(async () => ({ default: "ok" }));

    await load("/routes/counter.client.tsx");
    await load("/routes/counter.client.tsx?v=abc");

    expect(seen).toEqual([
      "/app/routes/counter.client.tsx?ssr",
      "/app/routes/counter.client.tsx?v=abc&ssr",
    ]);
  });

  it("memoizes a successful load", async () => {
    let count = 0;
    const { load } = setup(async () => {
      count++;
      return { default: "ok" };
    });

    const first = await load("/routes/a.client.tsx");
    load("/routes/a.client.tsx");

    expect(count).toBe(1);
    expect(first).toEqual({ default: "ok" });
  });

  it("evicts a rejected load so the next request retries", async () => {
    // The dev-server restart case: the in-flight ssrLoadModule is rejected with
    // 'transport was disconnected, cannot call "fetchModule"'. Without eviction
    // the cached rejection replays that error on every later request, long
    // after the new module runner is healthy.
    let attempt = 0;
    const { load, cache } = setup(async () => {
      attempt++;
      if (attempt === 1) throw new Error('transport was disconnected, cannot call "fetchModule"');
      return { default: "recovered" };
    });

    await expect(load("/routes/a.client.tsx")).rejects.toThrow("transport was disconnected");
    expect(cache["/routes/a.client.tsx"]).toBeUndefined();

    const recovered = (await load("/routes/a.client.tsx")) as { default: string };
    expect(recovered.default).toBe("recovered");
    expect(attempt).toBe(2);
  });

  it("does not evict a fresher entry when a stale rejection settles", async () => {
    let reject: ((e: unknown) => void) | undefined;
    let attempt = 0;
    const { load, cache } = setup(() => {
      attempt++;
      if (attempt === 1) return new Promise((_res, rej) => (reject = rej));
      return Promise.resolve({ default: "fresh" });
    });

    const stale = load("/routes/a.client.tsx") as Promise<unknown>;
    // Simulate an external eviction (evictStaleModules / handleHotUpdate),
    // then a new load that installs a fresh entry in the same slot.
    delete cache["/routes/a.client.tsx"];
    const fresh = await load("/routes/a.client.tsx");

    reject!(new Error("transport was disconnected"));
    await expect(stale).rejects.toThrow("transport was disconnected");

    // The loser's rejection must not clear the winner's cached module.
    expect(cache["/routes/a.client.tsx"]).toBe(fresh);
  });

  it("prunes half the cache once it exceeds the size limit", async () => {
    const cache: Record<string, unknown> = {};
    const load = createDevSSRRequire({
      loadModule: async () => ({ default: "ok" }),
      toFilePath: (moduleId) => moduleId,
      cache,
      maxCacheSize: 4,
    });

    for (let i = 0; i < 6; i++) await load(`/m${i}.client.tsx`);

    expect(Object.keys(cache).length).toBeLessThanOrEqual(4);
    expect(cache["/m5.client.tsx"]).toBeDefined();
  });
});
