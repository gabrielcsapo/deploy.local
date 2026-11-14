import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// Every run gets one temporary folder, and every test's temporary files go inside it through
// TMPDIR. The run removes it when it ends, so a test that forgets to clean up leaves nothing
// behind: each run on SER used to leave about sixty folders in its memory-backed /tmp.
// A Unix socket path is limited to 104 bytes on macOS, and its per-user temporary folder is already
// about 50; several tests open a fake Docker socket inside their temporary folder.
const systemTemporary = process.platform === 'darwin' ? '/tmp' : tmpdir();
const RUN_PREFIX = 'deploy-test-run-';
for (const name of readdirSync(systemTemporary)) {
  if (!name.startsWith(RUN_PREFIX)) continue;
  const folder = join(systemTemporary, name);
  let alive = false;
  try {
    process.kill(Number(readFileSync(join(folder, '.pid'), 'utf8')), 0);
    alive = true;
  } catch (error) {
    alive = error?.code === 'EPERM';
  }
  // A run that was killed never cleaned up; one that is still going keeps its folder.
  if (!alive) rmSync(folder, { recursive: true, force: true, maxRetries: 2 });
}
const runTemporary = mkdtempSync(join(systemTemporary, RUN_PREFIX));
writeFileSync(join(runTemporary, '.pid'), String(process.pid));
const testEnvironment = {
  ...process.env,
  TMPDIR: runTemporary,
  TMP: runTemporary,
  TEMP: runTemporary,
};
const removeRunTemporary = () => {
  try {
    rmSync(runTemporary, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Files a container wrote as root cannot be removed here; the next run tries again.
  }
};
process.on('exit', removeRunTemporary);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    removeRunTemporary();
    process.exit(130);
  });
const spawn = (command, args, env = testEnvironment) => {
  const result = spawnSync(command, args, { stdio: 'inherit', env });
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
  // Swift keeps the system temporary folder: its build and module caches live there.
  return spawn('swift', ['test', '--package-path', 'native/Apple/Packages/DeployKit'], process.env);
}

const suites = {
  web: run(['--import', 'tsx', '--import', './scripts/test-css-stub.mjs', ...webTests]),
  server: run(tests),
  swift: swift(),
};
const failed = Object.keys(suites).filter((name) => suites[name] !== 0);
// The last suite's output can bury an earlier failure, so name them all at the end.
if (failed.length) console.error(`Failed test suites: ${failed.join(', ')}`);
process.exit(failed.length ? 1 : 0);
