/**
 * Provides __webpack_require__ and __webpack_chunk_load__ shims
 * so react-server-dom-webpack works with Vite's ESM output.
 */

export {};

const moduleCache: Record<string, unknown> = {};
const chunkMap: Record<string, string> = {};

// Auto-initialize from injected module map (production builds inject this in shell HTML)
if (typeof window !== 'undefined' && (window as any).__MODULE_MAP__) {
  Object.assign(chunkMap, (window as any).__MODULE_MAP__);
}

/**
 * Resolve a chunk ID to an absolute URL.
 * Chunk IDs from the RSC manifest are like "assets/foo.js" (relative).
 * We prepend "/" to make them absolute URL paths.
 */
function resolveChunkUrl(chunkId: string): string {
  if (chunkMap[chunkId]) return chunkMap[chunkId];
  // Chunk IDs from Vite start with "assets/" - make them absolute
  if (chunkId.startsWith('assets/')) return `/${chunkId}`;
  return chunkId;
}

// Shim: synchronous module access (returns thenable if not yet loaded)
(globalThis as any).__webpack_require__ = function requireModule(moduleId: string) {
  if (moduleCache[moduleId]) {
    return moduleCache[moduleId];
  }

  const url = resolveChunkUrl(moduleId);
  const promise = import(/* @vite-ignore */ url).then((mod: unknown) => {
    moduleCache[moduleId] = mod;
    (promise as any).status = 'fulfilled';
    (promise as any).value = mod;
    return mod;
  }).catch((err: unknown) => {
    (promise as any).status = 'rejected';
    (promise as any).reason = err;
    throw err;
  });

  (promise as any).status = 'pending';
  moduleCache[moduleId] = promise;
  return promise;
};

// Shim: async chunk loading
(globalThis as any).__webpack_chunk_load__ = function loadChunk(chunkId: string) {
  return import(/* @vite-ignore */ resolveChunkUrl(chunkId));
};

// Shim: chunk URL resolution
(globalThis as any).__webpack_require__.u = function getChunkUrl(chunkId: string) {
  return resolveChunkUrl(chunkId);
};

// Shim: public path prefix (empty in dev, could be CDN prefix in prod)
(globalThis as any).__webpack_require__.p = '';

// Shim: get full script filename from chunk ID
// Used by react-server-dom-webpack/client.browser to resolve module chunk URLs
(globalThis as any).__webpack_get_script_filename__ = function getScriptFilename(chunkId: string) {
  return (globalThis as any).__webpack_require__.p + ((globalThis as any).__webpack_require__.u(chunkId));
};
