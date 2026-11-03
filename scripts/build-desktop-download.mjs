#!/usr/bin/env node

/**
 * Build the desktop app download the coordinator serves at /desktop.
 *
 * Usage:  pnpm build:desktop-download
 *
 * Packages deploy.local Desktop for this Mac with `pnpm package:mac` in desktop/,
 * zips the .app with ditto (which keeps its code signature), and writes
 * dist/desktop/build-info.json for /desktop/version. Copy dist/desktop to
 * desktop/ in the server's data directory to publish it without a release.
 *
 * Signing: set CSC_LINK/CSC_KEY_PASSWORD or CSC_NAME to sign with a real
 * identity; otherwise the app is signed ad hoc. It is not notarized, so macOS
 * asks people to choose Open Anyway the first time.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeBuildInfo } from './build-info.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DESKTOP = join(ROOT, 'desktop');
const OUTPUT = join(ROOT, 'dist/desktop');
const APP_NAME = 'deploy.local Desktop.app';

function run(command, args, options = {}) {
  console.log(`  $ ${[command, ...args].join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function sha256(path) {
  return new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });
}

/** Same naming as server/desktop-download.ts desktopDownloadFilename(). */
function archiveName(version, platform, arch) {
  return `deploy.local-Desktop-${version.replace(/[^A-Za-z0-9._-]/g, '-')}-${platform}-${arch}.zip`;
}

if (process.platform !== 'darwin') {
  console.error(
    'The desktop download is packaged on macOS. Windows and Linux builds are not published yet.',
  );
  process.exit(1);
}
const arch = process.arch;
if (arch !== 'arm64') {
  console.error(`Only Apple silicon (arm64) builds are published; this Mac is ${arch}.`);
  process.exit(1);
}

const build = computeBuildInfo(DESKTOP);
console.log('Building the deploy.local Desktop download');
console.log(`  Version: ${build.version}`);
console.log(`  Commit:  ${build.commit}${build.dirty ? ' (dirty working tree)' : ''}`);

console.log('\n[1/4] Desktop dependencies');
if (!existsSync(join(DESKTOP, 'node_modules/electron/dist'))) {
  run('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile', '--ignore-scripts'], {
    cwd: DESKTOP,
  });
  run(process.execPath, ['node_modules/electron/install.js'], { cwd: DESKTOP });
} else {
  console.log('  already installed');
}

// Use the screen needs the native control helper inside the app. Build it from
// source unless one is supplied (DEPLOY_DESKTOP_HELPER) or already built.
console.log('\n[2/4] Control helper');
const helper = join(DESKTOP, 'build/helpers/deploy-control-helper');
if (process.env.DEPLOY_DESKTOP_HELPER) {
  console.log(`  using DEPLOY_DESKTOP_HELPER`);
} else {
  mkdirSync(join(DESKTOP, 'build/helpers'), { recursive: true });
  run('xcrun', [
    'swiftc',
    '-O',
    '-parse-as-library',
    join(ROOT, 'native/ControlHelper/main.swift'),
    '-o',
    helper,
  ]);
}

console.log('\n[3/4] Package the app');
const signing = process.env.CSC_LINK || process.env.CSC_NAME;
run('pnpm', ['package:mac'], {
  cwd: DESKTOP,
  env: {
    ...process.env,
    DEPLOY_DESKTOP_BUILD_INFO: JSON.stringify(build),
    ...(signing ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }),
  },
});
const app = join(DESKTOP, `dist/mac-${arch}`, APP_NAME);
if (!existsSync(app)) {
  console.error(`Packaging did not produce ${app}`);
  process.exit(1);
}
// Without an identity electron-builder leaves the bundle with a broken
// signature, which Apple silicon refuses to run. Sign it ad hoc instead.
if (!signing) run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);

console.log('\n[4/4] Zip and write the manifest');
mkdirSync(OUTPUT, { recursive: true });
for (const entry of readdirSync(OUTPUT)) {
  if (entry.endsWith('.zip') || entry === 'build-info.json') rmSync(join(OUTPUT, entry));
}
const file = archiveName(build.version, 'mac', arch);
const archive = join(OUTPUT, file);
// ditto keeps extended attributes and the signature; --keepParent puts the
// .app itself at the top of the zip, so Finder unzips a ready app.
run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]);
const manifest = {
  version: build.version,
  commit: build.commit,
  buildTime: build.buildTime,
  targets: {
    [`darwin-${arch}`]: { file, size: statSync(archive).size, sha256: await sha256(archive) },
  },
};
writeFileSync(join(OUTPUT, 'build-info.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`  ${archive}`);
console.log(`  ${manifest.targets[`darwin-${arch}`].size} bytes`);
console.log(`  sha256 ${manifest.targets[`darwin-${arch}`].sha256}`);
