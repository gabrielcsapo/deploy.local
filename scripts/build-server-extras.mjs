import { computeBuildInfo } from './build-info.mjs';
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

import { copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild is a transitive dep (via vite). Resolve through vite so we don't
// rely on pnpm's `.bin/esbuild` shim (see scripts/build-cli.mjs).
const { build } = createRequire(import.meta.resolve('vite'))('esbuild');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const buildInfo = computeBuildInfo(root);
const common = {
  define: {
    __APP_VERSION__: JSON.stringify(buildInfo.packageVersion),
    __WORKER_BUILD_COMMIT__: JSON.stringify(buildInfo.commit === 'unknown' ? '' : buildInfo.commit),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve runtime packages externally; ssh2 catches its optional, intentionally unbuilt native accelerators.
  external: ['better-sqlite3', 'playwright', 'ssh2'],
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

await build({
  ...common,
  entryPoints: [resolve(root, 'server/requests-copy-worker.ts')],
  outfile: resolve(root, 'dist/requests-copy-worker.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/backup-snapshot-worker.ts')],
  outfile: resolve(root, 'dist/backup-snapshot-worker.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/readiness-integrity-worker.ts')],
  outfile: resolve(root, 'dist/readiness-integrity-worker.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/workspace-vacuum-worker.ts')],
  outfile: resolve(root, 'dist/workspace-vacuum-worker.js'),
});

for (const [entry, name] of [
  ['pipeline-worker', 'workspace-pipeline-worker'],
  ['recovery', 'workspace-recovery'],
  ['repository-worker', 'workspace-repository-worker'],
  ['repository-doctor', 'workspace-repository-doctor'],
  ['worker', 'workspace-worker'],
  ['remote-worker', 'workspace-remote-worker'],
  ['compatible-agent', 'workspace-compatible-agent'],
  ['claude-agent', 'workspace-claude-agent'],
  ['mcp', 'workspace-mcp'],
]) {
  await build({
    ...common,
    entryPoints: [resolve(root, `server/workspace/${entry}.ts`)],
    outfile: resolve(root, `dist/${name}.js`),
  });
}

console.log('Built dist/edge.js, dist/supervisor.js, dist/log-worker.js and workspace workers');

copyFileSync(
  resolve(root, 'server/legacy-snapshot.mjs'),
  resolve(root, 'dist/legacy-snapshot.mjs'),
);

copyFileSync(resolve(root, 'server/wander-data.mjs'), resolve(root, 'dist/wander-data.mjs'));

copyFileSync(
  resolve(root, 'server/packages/body-worker.mjs'),
  resolve(root, 'dist/package-body-worker.mjs'),
);

await build({
  ...common,
  entryPoints: [resolve(root, 'server/packages/lock-worker.ts')],
  outfile: resolve(root, 'dist/package-lock-worker.js'),
});

await build({
  ...common,
  entryPoints: [resolve(root, 'server/packages/recovery-worker.ts')],
  outfile: resolve(root, 'dist/package-recovery-worker.js'),
});

copyFileSync(
  resolve(root, 'server/packages/document-worker.mjs'),
  resolve(root, 'dist/package-document-worker.mjs'),
);

copyFileSync(
  resolve(root, 'server/packages/index-worker.mjs'),
  resolve(root, 'dist/package-index-worker.mjs'),
);
