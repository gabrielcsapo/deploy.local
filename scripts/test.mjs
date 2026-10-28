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
const server = run(tests);
const web = run(['--import', 'tsx', '--import', './scripts/test-css-stub.mjs', ...webTests]);
process.exit(server || web);
