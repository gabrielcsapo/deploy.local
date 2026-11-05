/**
 * Dev-mode counterpart to `createSSRModuleLoader`.
 *
 * During dev SSR, `createFromReadableStream` calls `__webpack_require__` with
 * module IDs from the dev client manifest (Vite URLs) to load client component
 * implementations. Those go through `ssrLoadModule` rather than a native
 * `import`, so the loader lives here instead of reusing the production one.
 *
 * Cache semantics match production: successful loads are memoized, failed loads
 * are evicted before the rejection propagates. Eviction matters more in dev —
 * a dev-server restart rejects in-flight `ssrLoadModule` calls ("transport was
 * disconnected", "Vite module runner has been closed"), and a cached rejection
 * would replay that error on every later request even though the new module
 * runner is healthy.
 */
export interface DevSSRRequireOptions {
  /** Load a module by its `?ssr`-suffixed Vite ID (`server.ssrLoadModule`). */
  loadModule: (ssrId: string) => Promise<unknown>;
  /** Convert a manifest module ID (a Vite URL) to an absolute file path. */
  toFilePath: (moduleId: string) => string;
  /**
   * Module cache, owned by the caller so HMR and stale-runner recovery can
   * evict entries from outside this loader.
   */
  cache: Record<string, unknown>;
  /** Prune half the cache once it exceeds this many entries. */
  maxCacheSize?: number;
}

export function createDevSSRRequire(opts: DevSSRRequireOptions): (moduleId: string) => unknown {
  const { loadModule, toFilePath, cache, maxCacheSize = 500 } = opts;

  return function ssrRequireModule(moduleId: string): unknown {
    if (cache[moduleId]) return cache[moduleId];

    // Prune cache if it grows too large during long dev sessions
    const cacheKeys = Object.keys(cache);
    if (cacheKeys.length > maxCacheSize) {
      const deleteCount = Math.floor(cacheKeys.length / 2);
      for (let i = 0; i < deleteCount; i++) {
        delete cache[cacheKeys[i]];
      }
    }

    const filePath = toFilePath(moduleId);
    const ssrId = filePath + (filePath.includes("?") ? "&ssr" : "?ssr");

    const promise = loadModule(ssrId)
      .then((mod: unknown) => {
        cache[moduleId] = mod;
        (promise as any).value = mod;
        (promise as any).status = "fulfilled";
        return mod;
      })
      .catch((err: unknown) => {
        // Evict so the next request re-imports instead of replaying the
        // failure forever (see header comment). Compare-and-swap so a fresher
        // entry that raced ahead of us survives.
        if (cache[moduleId] === promise) delete cache[moduleId];
        (promise as any).status = "rejected";
        (promise as any).reason = err;
        throw err;
      });

    (promise as any).status = "pending";
    cache[moduleId] = promise;
    return promise;
  };
}
