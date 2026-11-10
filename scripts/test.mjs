import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.name === 'node_modules') return [];
      if (entry.isDirectory()) return collectTests(path);
      const test = entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs');
      return entry.isFile() && test ? [path] : [];
    })
    .sort();
}

const tests = [
  ...collectTests('server'),
  ...collectTests('shared'),
  ...collectTests('bin'),
  ...collectTests('scripts'),
  ...collectTests('packages/node-app/src'),
  ...collectTests('packages/mdns'),
  // Plain Node: these fake Electron and the Mac commands, so no Electron binary or Xcode is needed.
  ...collectTests('desktop/test'),
  ...collectTests('examples'),
];
// Web unit tests import .tsx components and their stylesheets, so they need a loader.
const webTests = collectTests('app');
if (tests.length === 0) {
  console.error('No test files were found.');
  process.exit(1);
}

console.log(`Running ${tests.length} server and ${webTests.length} web test files.`);
const spawn = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  return result.status ?? 1;
};
// Several suites boot isolated HTTP servers. Keep file-level parallelism bounded
// so their startup health checks are not starved on development machines.
const run = (args) => spawn(process.execPath, ['--test', '--test-concurrency=4', ...args]);

// DeployKit holds the iPhone app's logic and needs Apple's frameworks. A Mac without a Swift
// toolchain fails here rather than skipping; a sandbox that can't build says so explicitly.
function swift() {
  if (process.platform !== 'darwin') {
    console.log('Skipping Swift tests: they only run on a Mac.');
    return 0;
  }
  if (process.env.DEPLOY_SKIP_SWIFT_TESTS === '1') {
    console.log('Skipping Swift tests: DEPLOY_SKIP_SWIFT_TESTS is set.');
    return 0;
  }
  return spawn('swift', ['test', '--package-path', 'native/Apple/Packages/DeployKit']);
}

const suites = {
  // Vitest owns the router's TS/TSX suites; e2e specs and benchmarks are separate.
  router: spawn('pnpm', ['--filter', 'react-flight-router', 'exec', 'vitest', 'run']),
  worker: run([
    'packages/react-flight-router/dist/server/worker-pool.test.js',
    'packages/react-flight-router/dist/server/action-transport.test.js',
  ]),
  web: run(['--import', 'tsx', '--import', './scripts/test-css-stub.mjs', ...webTests]),
  server: run(tests),
  swift: swift(),
};
const failed = Object.keys(suites).filter((name) => suites[name] !== 0);
// The last suite's output can bury an earlier failure, so name them all at the end.
if (failed.length) console.error(`Failed test suites: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);
