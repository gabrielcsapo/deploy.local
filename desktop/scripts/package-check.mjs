import { build, Platform } from 'electron-builder';
import { createRequire } from 'node:module';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { verifyPreloads } from './preload-check.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const asar = appBuilderRequire('@electron/asar');
if (!process.env.ELECTRON_BUILDER_CACHE) {
  const cache = join(root, 'build/builder-cache');
  await mkdir(cache, { recursive: true });
  // electron-builder's downloaded icon tool is CommonJS, even in this ESM package.
  await writeFile(join(cache, 'package.json'), '{"type":"commonjs"}\n');
  process.env.ELECTRON_BUILDER_CACHE = cache;
}
await build({
  projectDir: root,
  targets: Platform.current().createTarget('dir'),
  publish: 'never',
  config: {
    directories: { output: 'dist/package-check' },
    electronDist: join(dirname(require.resolve('electron')), 'dist'),
    mac: { identity: null, notarize: false },
    win: { signAndEditExecutable: false },
  },
});
async function archives(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await archives(path)));
    else if (entry.name === 'app.asar') result.push(path);
  }
  return result;
}
const packages = await archives(join(root, 'dist/package-check'));
assert.ok(packages.length > 0, 'No unpacked application archive produced');
for (const archive of packages) {
  const extract = (name) => asar.extractFile(archive, name).toString('utf8');
  const main = extract('src/main.mjs');
  assert.deepEqual(
    JSON.parse(extract('build/build-info.json')),
    JSON.parse(await readFile(join(root, 'build/build-info.json'), 'utf8')),
  );
  assert.ok(extract('src/update-helper.sh').startsWith('#!/bin/sh'));
  assert.match(extract('build/app-worker.mjs'), /ensureWorkerBuild/);
  assert.doesNotMatch(extract('build/app-worker.mjs'), /from ["']\.\.\/\.\.\/bin\//);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /sandbox: true/);
  console.log(
    `${archive}: ${await verifyPreloads(extract('src/preload.cjs'), extract('build/shell-preload.cjs'))}`,
  );
  assert.equal(
    extract('assets/design-tokens.css'),
    await readFile(join(root, '../app/design-tokens.css'), 'utf8'),
  );
  await readFile(join(dirname(archive), 'worker/worker.mjs'));
  assert.ok(!asar.listPackage(archive).some((path) => path.includes('fixture-runtime')));
}
console.log('Unpacked application, bundled worker, copied tokens and preload surface verified.');
