import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectTests(path);
      // app/**/*.test.mjs drive a browser and run separately; only the docs check is plain Node.
      const mjs =
        entry.name.endsWith('.test.mjs') &&
        (!directory.startsWith('app') || directory === 'app/routes/docs');
      return entry.isFile() && (entry.name.endsWith('.test.ts') || mjs) ? [path] : [];
    })
    .sort();
}

const tests = [
  ...collectTests('server'),
  ...collectTests('packages/node-app/src'),
  ...collectTests('bin'),
  'scripts/linux-release.test.mjs',
];
// Web unit tests import .tsx components and their stylesheets, so they need a loader.
const webTests = collectTests('app');
if (tests.length === 0) {
  console.error('No test files were found.');
  process.exit(1);
}

console.log(`Running ${tests.length} server and ${webTests.length} web test files.`);
// Several suites boot isolated HTTP servers. Keep file-level parallelism bounded
// so their startup health checks are not starved on development machines.
const run = (args) => {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
// Vitest owns the router's TS/TSX suites; e2e specs and benchmarks are separate.
const router = spawnSync('pnpm', ['--filter', 'react-flight-router', 'exec', 'vitest', 'run'], {
  stdio: 'inherit',
  env: process.env,
});
if (router.error) throw router.error;
const worker = run(['packages/react-flight-router/dist/server/worker-pool.test.js']);
const web = run(['--import', 'tsx', '--import', './scripts/test-css-stub.mjs', ...webTests]);
const server = run(tests);
process.exit((router.status ?? 1) || worker || web || server);
