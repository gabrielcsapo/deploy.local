import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const library = join(root, 'packages/react-flight-router');
const dist = join(library, 'dist');
const stamp = join(dist, '.build-inputs.json');

function files(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    })
    .sort();
}

// Include the file list to catch removals, and configuration/lockfile changes
// because a dependency or compiler update can change emitted JS and declarations.
const sources = files(join(library, 'src'));
const inputs = [
  ...sources,
  join(library, 'tsconfig.json'),
  join(library, 'package.json'),
  join(root, 'package.json'),
  join(root, 'pnpm-lock.yaml'),
];
const inputStats = inputs.map((path) => {
  const stat = statSync(path);
  return [path.slice(root.length + 1), stat.mtimeMs, stat.size];
});
const signature = JSON.stringify(inputStats);
const newestInput = Math.max(...inputStats.map(([, mtime]) => mtime));
const outputs = sources
  .filter((path) => /(?<!\.d)\.tsx?$/.test(path))
  .flatMap((path) => {
    const relative = path.slice(join(library, 'src').length + 1).replace(/\.tsx?$/, '');
    return [join(dist, relative + '.js'), join(dist, relative + '.d.ts')];
  });
const current =
  existsSync(stamp) &&
  readFileSync(stamp, 'utf8') === signature &&
  outputs.every((path) => existsSync(path) && statSync(path).mtimeMs >= newestInput);
if (!current) {
  console.log('Building workspace react-flight-router…');
  // Never retain emitted files for deleted sources or a stamp from a failed build.
  rmSync(dist, { recursive: true, force: true });
  execFileSync('pnpm', ['--filter', 'react-flight-router', 'build'], {
    cwd: root,
    stdio: 'inherit',
  });
  writeFileSync(stamp, signature);
}
