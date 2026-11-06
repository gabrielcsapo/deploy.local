import { computeBuildInfo } from '../../scripts/build-info.mjs';
import { build } from 'esbuild';
import { buildIcons } from './icons.mjs';
import { mkdir, copyFile, access, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('..', import.meta.url));
process.chdir(directory);
const buildInfo = process.env.DEPLOY_DESKTOP_BUILD_INFO
  ? JSON.parse(process.env.DEPLOY_DESKTOP_BUILD_INFO)
  : computeBuildInfo(directory);
await mkdir('build', { recursive: true });
await writeFile('build/build-info.json', JSON.stringify(buildInfo, null, 2) + '\n');
await mkdir('build/worker', { recursive: true });
await mkdir('build/helpers', { recursive: true });
await copyFile('../app/design-tokens.css', 'assets/design-tokens.css');
await build({
  absWorkingDir: directory,
  entryPoints: ['src/worker-entry.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'build/worker/worker.mjs',
  external: ['playwright'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await build({
  absWorkingDir: directory,
  entryPoints: ['src/shell-preload.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'build/shell-preload.cjs',
  external: ['electron'],
});
await copyFile(
  'node_modules/@fontsource/hanken-grotesk/files/hanken-grotesk-latin-400-normal.woff2',
  'assets/hanken-400.woff2',
);
await copyFile(
  'node_modules/@fontsource/hanken-grotesk/files/hanken-grotesk-latin-600-normal.woff2',
  'assets/hanken-600.woff2',
);
const candidates = [
  process.env.DEPLOY_DESKTOP_HELPER,
  '../native/Apple/DerivedData/Build/Products/Debug/deploy-control-helper',
  'build/helpers/deploy-control-helper',
].filter(Boolean);
let helper = false;
for (const path of candidates) {
  try {
    await access(path);
    if (resolve(path) !== resolve('build/helpers/deploy-control-helper'))
      await copyFile(path, 'build/helpers/deploy-control-helper');
    helper = true;
    break;
  } catch {}
}
await writeFile(
  'build/helpers/README.txt',
  helper
    ? 'Built macOS control helper included. OS permissions and per-task approval are required.\n'
    : 'No built macOS helper found. Use the screen is unavailable in this build.\n',
);
await buildIcons('assets');
console.log(
  `Worker bundled from ${resolve('../server/workspace/remote-worker.ts')}; macOS helper ${helper ? 'included' : 'unavailable'}.`,
);
