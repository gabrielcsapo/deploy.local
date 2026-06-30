/**
 * Bundle the non-RFR server entries into dist/ alongside the
 * react-flight-router build output (dist/server.js):
 *   - dist/edge.js        — the data-plane process
 *   - dist/supervisor.js  — production entry: spawns control + edge
 *   - dist/log-worker.js  — worker thread for batched request-log writes
 *     (request-log.ts prefers the .js next to the bundle; the .ts source
 *     URL can never resolve from inside a bundle)
 *
 * Runs after `react-flight-router build` (see the package.json build script).
 */

import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild is a transitive dep (via vite). Resolve through vite so we don't
// rely on pnpm's `.bin/esbuild` shim (see scripts/build-cli.mjs).
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native module — resolved from node_modules at runtime, like dist/server.js.
  external: ['better-sqlite3'],
  // Bundled ESM with externals needs require() for CJS deps (bindings).
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'warning',
};

await build({
  ...common,
  entryPoints: [resolve(root, 'server/edge/index.ts')],
  outfile: resolve(root, 'dist/edge.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/supervisor.ts')],
  outfile: resolve(root, 'dist/supervisor.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/log-worker.ts')],
  outfile: resolve(root, 'dist/log-worker.js'),
});

console.log('Built dist/edge.js, dist/supervisor.js, dist/log-worker.js');
