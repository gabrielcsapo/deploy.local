// List web source files that no route can reach, using the type checker's own file list (tsrs).
// Usage: node scripts/perf/reachable.mjs [--list]
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

const config = '.reachable.tmp.json';
writeFileSync(
  config,
  JSON.stringify({
    extends: './tsconfig.json',
    include: [],
    files: ['app/routes.ts', 'app/root.tsx', 'global.d.ts'],
    compilerOptions: { noEmit: true },
  }),
);
let listed;
try {
  listed = spawnSync('node_modules/.bin/tsrs', ['-p', config, '--listFilesOnly'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  }).stdout;
} finally {
  rmSync(config, { force: true });
}
const root = `${process.cwd()}/`;
const reached = new Set(listed.split('\n').map((file) => file.trim().replace(root, '')));
const source = execFileSync('git', ['ls-files', 'app'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file));
const lines = (files) =>
  files.reduce((total, file) => total + readFileSync(file, 'utf8').split('\n').length - 1, 0);
const unreached = source.filter((file) => !reached.has(file));
console.log(`app: ${source.length} files, ${lines(source)} lines`);
console.log(`unreached: ${unreached.length} files, ${lines(unreached)} lines`);
if (process.argv.includes('--list')) console.log(unreached.join('\n'));
