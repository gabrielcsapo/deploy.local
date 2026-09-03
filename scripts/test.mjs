import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectTests(path);
      return entry.isFile() && entry.name.endsWith('.test.ts') ? [path] : [];
    })
    .sort();
}

const tests = collectTests('server');
if (tests.length === 0) {
  console.error('No server test files were found.');
  process.exit(1);
}

console.log(`Running ${tests.length} server test files.`);
// Several suites boot isolated HTTP servers. Keep file-level parallelism bounded
// so their startup health checks are not starved on development machines.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...tests], {
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
