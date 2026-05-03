import { resolve } from "path";

/**
 * Loader function shape — called with a moduleId (path relative to the
 * server build dir) and returns the loaded module. The shim wraps the
 * dynamic import; the test harness substitutes a mock importer.
 */
export type SSRModuleImporter = (fullPath: string) => Promise<unknown>;

/**
 * Build the `__webpack_require__` shim used during SSR to load client
 * component modules from the server build directory. Returns the
 * function reference and the underlying cache (exposed for tests).
 *
 * Cache semantics:
 *  - Successful imports are memoized by moduleId for the lifetime of
 *    the server (modules are immutable in production).
 *  - Failed imports are evicted from the cache before the rejection
 *    propagates, so the next request retries the import. Without this
 *    eviction, a transient error (missing chunk during a deploy,
 *    dev-server compile error, intermittent disk read) would brick
 *    the route until the server restarts.
 *
 * The compare-and-swap (`cache[id] === promise`) on eviction guards
 * against a successful retry that's already in flight: only the
 * specific rejected promise is cleared, never a fresher entry that
 * raced ahead of us.
 */
export function createSSRModuleLoader(
  buildDir: string,
  importer: SSRModuleImporter = (fullPath) => import(fullPath),
): {
  load: (moduleId: string) => unknown;
  cache: Record<string, unknown>;
} {
  const cache: Record<string, unknown> = {};

  function load(moduleId: string): unknown {
    if (cache[moduleId]) return cache[moduleId];

    const fullPath = resolve(buildDir, "server", moduleId);
    const promise = importer(fullPath)
      .then((mod: unknown) => {
        cache[moduleId] = mod;
        (promise as any).value = mod;
        (promise as any).status = "fulfilled";
        return mod;
      })
      .catch((err: unknown) => {
        // Evict so the next request retries (see header comment).
        if (cache[moduleId] === promise) delete cache[moduleId];
        (promise as any).status = "rejected";
        (promise as any).reason = err;
        throw err;
      });

    (promise as any).status = "pending";
    cache[moduleId] = promise;
    return promise;
  }

  return { load, cache };
}
