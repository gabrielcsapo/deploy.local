#!/usr/bin/env node

/**
 * Build standalone CLI binaries for all supported platforms using Node.js SEA.
 *
 * Usage:  node scripts/build-cli.mjs
 *
 * Produces macOS/Linux arm64+x64 binaries and a Windows x64 executable in dist/cli.
 */

import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { computeBuildInfo } from './build-info.mjs';
import { LAUNCHER_PROTOCOL } from '../bin/launcher-protocol.mjs';
import { readTree } from '../bin/design-local-assets.mjs';
import { buildDesignLocal } from './build-design-local.mjs';

// esbuild is a transitive dep (via vite). Resolve through vite so we don't
// rely on pnpm's `.bin/esbuild` shim, which invokes `node bin/esbuild` —
// broken because esbuild's postinstall replaces that file with a native binary.
const esbuild = createRequire(import.meta.resolve('vite'))('esbuild');

const ROOT = process.cwd();
const CLI_DIR = resolve(ROOT, 'dist/cli');
const CACHE_DIR = resolve(ROOT, '.deploy-data/node-cache');
const SEA_CONFIG = resolve(ROOT, 'sea-config.json');
// Node's own macOS entitlements (allow-jit etc), for signing without Apple's codesign.
const NODE_ENTITLEMENTS = resolve(ROOT, 'scripts/node-entitlements.plist');

// Keep the standalone CLI runtime on the same supported major/minor as the
// server, CI, and package engine contract.
const NODE_VERSION = 'v26.1.0';

const TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
  { os: 'win32', archiveOs: 'win', arch: 'x64', archiveType: 'zip', extension: '.exe' },
];

const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function hasCommand(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  console.log(`  Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await pipeline(res.body, createWriteStream(dest));
}

function nodeArchiveName(target) {
  const os = target.archiveOs || target.os;
  const extension = target.archiveType === 'zip' ? 'zip' : 'tar.gz';
  return `node-${NODE_VERSION}-${os}-${target.arch}.${extension}`;
}

function nodeDownloadUrl(target) {
  return `https://nodejs.org/dist/${NODE_VERSION}/${nodeArchiveName(target)}`;
}

function nodeBinaryPathInArchive(target) {
  const os = target.archiveOs || target.os;
  return target.archiveType === 'zip'
    ? `node-${NODE_VERSION}-${os}-${target.arch}/node.exe`
    : `node-${NODE_VERSION}-${os}-${target.arch}/bin/node`;
}

// The version is part of the name, so changing NODE_VERSION never reuses an older runtime.
function cachedNodePath(target) {
  return join(
    CACHE_DIR,
    `node-${target.os}-${target.arch}-${NODE_VERSION}${target.extension || ''}`,
  );
}

function outputBinaryPath(target) {
  return join(CLI_DIR, `deploy-${target.os}-${target.arch}${target.extension || ''}`);
}

// ── Steps ────────────────────────────────────────────────────────────────────

export async function bundleCli(buildInfo, output = CLI_DIR) {
  console.log('\n[1/5] Bundling CLI for SEA...');
  mkdirSync(output, { recursive: true });

  // The CLI is ESM with top-level await and import.meta.dirname.
  // SEA consumes a CommonJS bootstrap, so we:
  //  1. Bundle with esbuild as ESM (resolves all imports to a single file)
  //  2. Post-process: convert ESM imports to CJS requires, replace import.meta,
  //     and wrap top-level code in an async IIFE

  // Use the JS API directly — pnpm's bin shim invokes `node bin/esbuild`,
  // but esbuild's postinstall replaces that path with a native binary, which
  // Node then tries to parse as JS and fails.
  // deploy design dev serves the Design page and deploy.local's design system from the binary.
  const embedded = (files) =>
    JSON.stringify(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(files).map(([path, bytes]) => [path, bytes.toString('base64')]),
        ),
      ),
    );
  const designPage = readTree(buildDesignLocal());
  const designSystem = Object.fromEntries(
    Object.entries(readTree(resolve(ROOT, 'design/ds/deploy-local'))).map(([path, bytes]) => [
      `ds/deploy-local/${path}`,
      bytes,
    ]),
  );
  // deploy design init copies the starter design system from the binary.
  const designStarter = readTree(resolve(ROOT, 'bin/design-starter'));
  await esbuild.build({
    // Static imports include the internal `agent relay` entry in the same SEA as the worker.
    // The supervisor launches itself with that subcommand; no sidecar download is required.
    entryPoints: [resolve(ROOT, 'bin/deploy.js')],
    bundle: true,
    platform: 'node',
    // Browser control is optional and uses a locally installed Playwright runtime.
    external: ['playwright'],
    format: 'esm',
    outfile: resolve(output, 'deploy.mjs'),
    // Bake the build stamp in as a JSON string (not an object literal) so the
    // ESM→CJS post-processing below has nothing structural to trip over. Run
    // from source, the identifier is undefined and the CLI falls back to git.
    define: {
      __APP_VERSION__: JSON.stringify(buildInfo.packageVersion),
      __WORKER_BUILD_COMMIT__: JSON.stringify(
        buildInfo.commit === 'unknown' ? '' : buildInfo.commit,
      ),
      __DEPLOY_LINUX_DESKTOP_HELPER__: JSON.stringify(
        readFileSync(resolve(ROOT, 'native/Linux/desktop-helper.py'), 'utf8'),
      ),
      __DESIGN_LOCAL_ASSETS__: embedded(designPage),
      __DESIGN_SYSTEM_FILES__: embedded(designSystem),
      __DESIGN_STARTER_FILES__: embedded(designStarter),
      __DEPLOY_BUILD_INFO__: JSON.stringify(
        JSON.stringify({ ...buildInfo, runtime: NODE_VERSION }),
      ),
    },
  });
  console.log('  Bundled bin/deploy.js → dist/cli/deploy.mjs');

  const code = convertCliToCommonJS(readFileSync(resolve(output, 'deploy.mjs'), 'utf-8'));
  writeFileSync(resolve(output, 'deploy.cjs'), code);
  const bootstrap = await esbuild.build({
    entryPoints: [resolve(ROOT, 'bin/launcher.mjs')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  });
  // Both the fallback and downloaded artifact use the exact same conversion.
  writeFileSync(
    resolve(output, 'launcher.cjs'),
    `
const bootstrapModule = { exports: {} };
((module) => { ${bootstrap.outputFiles[0].text} })(bootstrapModule);
const bakedModule = { exports: {} };
((module) => { ${code} })(bakedModule);
bootstrapModule.exports.runLauncher({ build: ${JSON.stringify({ ...buildInfo, runtime: NODE_VERSION })}, baked: bakedModule.exports })
  .catch((err) => { console.error(err.message || err); process.exit(1); });
`,
  );
  console.log('  Converted ESM bundle and stable launcher to CJS');
}

export function convertCliToCommonJS(code) {
  // Strip shebang (SEA doesn't need it)
  code = code.replace(/^#!.*\n/, '');

  // Convert: import { a, b } from "node:Y" → var { a, b } = require("node:Y")
  // Also convert "as" to ":" for CJS destructuring (e.g., { request as httpRequest } → { request: httpRequest })
  code = code.replace(/^import\s+(\{[^}]+\})\s+from\s+"(node:[^"]+)";?$/gm, (_, bindings, mod) => {
    const cjsBindings = bindings.replace(/\b(\w+)\s+as\s+(\w+)\b/g, '$1: $2');
    return `var ${cjsBindings} = require("${mod}");`;
  });
  // Convert: import X from "node:Y" → var X = require("node:Y").default || require("node:Y")
  code = code.replace(/^import\s+(\w+)\s+from\s+"(node:[^"]+)";?$/gm, 'var $1 = require("$2");');

  // Replace import.meta.dirname → __dirname (in SEA, __dirname = dir of the binary)
  code = code.replace(/import\.meta\.dirname/g, '__dirname');

  // Replace import.meta.url → __filename as file URL
  code = code.replace(/import\.meta\.url/g, '"file://" + __filename');

  // Remove any export statements from esbuild ESM output
  code = code.replace(/^export\s+\{[^}]*\};?$/gm, '');

  return `module.exports = async function(__filename = process.execPath, __dirname = require('node:path').dirname(__filename)) {
${code}
};
`;
}

function step2_generateBlob() {
  console.log('\n[3/5] Generating SEA blob...');
  // Must use the same-version Node that will be embedded — SEA blobs aren't
  // compatible across Node major versions, and the system node may be 23+.
  const hostTarget = TARGETS.find(
    (target) => target.os === process.platform && target.arch === process.arch,
  );
  if (!hostTarget) {
    throw new Error(`No standalone CLI build target for ${process.platform}-${process.arch}`);
  }
  const hostNode = cachedNodePath(hostTarget);
  if (!existsSync(hostNode)) {
    throw new Error(
      `Host node ${process.platform}-${process.arch} (${NODE_VERSION}) not cached — step3 must run first`,
    );
  }
  const config = resolve(CLI_DIR, 'sea-config.json');
  writeFileSync(
    config,
    JSON.stringify({
      ...JSON.parse(readFileSync(SEA_CONFIG, 'utf8')),
      main: resolve(CLI_DIR, 'launcher.cjs'),
    }),
  );
  run(`${hostNode} --experimental-sea-config ${config}`);

  if (!existsSync(resolve(CLI_DIR, 'sea-prep.blob'))) {
    throw new Error('SEA blob was not generated');
  }
}

async function step3_downloadNodeBinaries() {
  console.log('\n[2/5] Downloading Node.js binaries...');
  mkdirSync(CACHE_DIR, { recursive: true });

  for (const target of TARGETS) {
    const { os, arch } = target;
    const archiveName = nodeArchiveName(target);
    const archivePath = join(CACHE_DIR, archiveName);
    const extractedBinaryPath = cachedNodePath(target);

    // Skip if already cached
    if (existsSync(extractedBinaryPath)) {
      console.log(`  Cached: node-${os}-${arch}`);
      continue;
    }

    // Download archive if not cached
    if (!existsSync(archivePath)) {
      await download(nodeDownloadUrl(target), archivePath);
    }

    // Extract just the node binary from the tarball
    console.log(`  Extracting node binary for ${os}-${arch}...`);
    const binaryInArchive = nodeBinaryPathInArchive(target);
    if (target.archiveType === 'zip') {
      const bytes = execFileSync('unzip', ['-p', archivePath, binaryInArchive], {
        cwd: ROOT,
        maxBuffer: 256 * 1024 * 1024,
      });
      writeFileSync(extractedBinaryPath, bytes);
    } else {
      run(`tar -xzf ${archivePath} -C ${CACHE_DIR} ${binaryInArchive}`);
      copyFileSync(join(CACHE_DIR, binaryInArchive), extractedBinaryPath);
    }
    chmodSync(extractedBinaryPath, 0o755);

    // Clean up extracted directory
    if (target.archiveType !== 'zip') {
      rmSync(join(CACHE_DIR, `node-${NODE_VERSION}-${target.archiveOs || os}-${arch}`), {
        recursive: true,
        force: true,
      });
    }
  }
}

function step4_injectAndSign() {
  console.log('\n[4/5] Injecting SEA blob into binaries...');
  const blobPath = resolve(CLI_DIR, 'sea-prep.blob');
  const canCodesign = hasCommand('codesign');
  // On Linux (SER) rcodesign makes the same ad hoc signature, so a Mac can run the build.
  const rcodesign = canCodesign
    ? null
    : process.env.RCODESIGN || (hasCommand('rcodesign') ? 'rcodesign' : null);

  for (const target of TARGETS) {
    const { os, arch } = target;
    const label = `${os}-${arch}`;
    const outputPath = outputBinaryPath(target);
    const cachedNode = cachedNodePath(target);

    if (!existsSync(cachedNode)) {
      console.warn(`  SKIP ${label}: node binary not found`);
      continue;
    }

    console.log(`  Building deploy-${label}...`);

    // Copy the node binary
    copyFileSync(cachedNode, outputPath);
    chmodSync(outputPath, 0o755);

    // macOS: extract original entitlements (allow-jit etc) and remove signature
    // before injection. Without these entitlements V8's JIT triggers SIGKILL on
    // Apple Silicon, manifesting as "zsh: killed" on first launch.
    let entitlementsPath = null;
    if (os === 'darwin') {
      if (canCodesign) {
        entitlementsPath = join(CLI_DIR, `entitlements-${label}.plist`);
        execSync(`codesign -d --entitlements :- ${outputPath} > ${entitlementsPath}`, {
          stdio: ['ignore', 'inherit', 'inherit'],
          cwd: ROOT,
        });
        run(`codesign --remove-signature ${outputPath}`);
      } else if (!rcodesign) {
        console.warn(`  WARN: codesign not available, macOS binary may not run correctly`);
      }
    }

    // Inject the SEA blob
    const machoFlag = os === 'darwin' ? ' --macho-segment-name NODE_SEA' : '';
    run(
      `npx postject ${outputPath} NODE_SEA_BLOB ${blobPath} --sentinel-fuse ${SENTINEL_FUSE}${machoFlag}`,
    );

    // macOS: re-sign ad-hoc, restoring the JIT entitlements so V8 can run.
    if (os === 'darwin' && canCodesign) {
      const entFlag =
        entitlementsPath && statSync(entitlementsPath).size > 0
          ? ` --entitlements ${entitlementsPath}`
          : '';
      run(`codesign --sign -${entFlag} --force ${outputPath}`);
      if (entitlementsPath && existsSync(entitlementsPath)) {
        rmSync(entitlementsPath, { force: true });
      }
    }
    if (os === 'darwin' && rcodesign) {
      run(`${rcodesign} sign --entitlements-xml-file ${NODE_ENTITLEMENTS} ${outputPath}`);
    }
  }
}

// Manifest the server serves at /cli/version. `deploy upgrade` compares its
// baked-in version against this one and verifies the download against the
// per-target digest recorded here.
export function buildCliManifest(
  buildInfo,
  directory = CLI_DIR,
  { restartSupervisor = false } = {},
) {
  console.log('\n[5/5] Writing build manifest...');
  const targets = {};

  for (const target of TARGETS) {
    const { os, arch } = target;
    const label = `${os}-${arch}`;
    const binaryPath = join(directory, `deploy-${label}${target.extension || ''}`);
    if (!existsSync(binaryPath)) continue;
    const bytes = readFileSync(binaryPath);
    targets[label] = {
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  const bytes = readFileSync(join(directory, 'deploy.cjs'));
  return {
    ...buildInfo,
    runtime: NODE_VERSION,
    launcherProtocol: LAUNCHER_PROTOCOL,
    targets,
    bundle: {
      file: 'deploy.cjs',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      version: buildInfo.version,
      launcherProtocol: LAUNCHER_PROTOCOL,
      // This drops relays briefly. Opt in only for supervisor fixes, never routine code updates.
      restartSupervisor,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const buildInfo = computeBuildInfo(ROOT);

  console.log('Building deploy.local CLI binaries (Node.js SEA)');
  console.log(`  Version: ${buildInfo.version}`);
  console.log(`  Commit:  ${buildInfo.commit}${buildInfo.dirty ? ' (dirty working tree)' : ''}`);
  console.log(`  Built:   ${buildInfo.buildTime}`);
  console.log(`  Embedded runtime: Node.js ${NODE_VERSION}`);
  console.log(`  Targets: ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ')}`);

  await bundleCli(buildInfo);
  // step3 must run before step2 — blob generation needs the matching-version
  // host node binary from the cache.
  await step3_downloadNodeBinaries();
  step2_generateBlob();
  step4_injectAndSign();
  writeFileSync(
    resolve(CLI_DIR, 'build-info.json'),
    JSON.stringify(buildCliManifest(buildInfo), null, 2) + '\n',
  );

  console.log('\nDone! Binaries:');
  for (const target of TARGETS) {
    const p = outputBinaryPath(target);
    if (existsSync(p)) {
      const size = statSync(p).size;
      const mb = (size / 1024 / 1024).toFixed(1);
      console.log(`  ${p} (${mb} MB)`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((err) => {
    console.error('\nBuild failed:', err.message);
    process.exit(1);
  });
