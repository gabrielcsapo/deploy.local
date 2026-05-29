#!/usr/bin/env node

/**
 * Build standalone CLI binaries for all supported platforms using Node.js SEA.
 *
 * Usage:  node scripts/build-cli.mjs
 *
 * Produces: dist/cli/deploy-{darwin,linux}-{arm64,x64}
 */

import { execSync } from 'node:child_process';
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
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';

// esbuild is a transitive dep (via vite). Resolve through vite so we don't
// rely on pnpm's `.bin/esbuild` shim, which invokes `node bin/esbuild` —
// broken because esbuild's postinstall replaces that file with a native binary.
const esbuild = createRequire(import.meta.resolve('vite'))('esbuild');

const ROOT = process.cwd();
const CLI_DIR = resolve(ROOT, 'dist/cli');
const CACHE_DIR = resolve(ROOT, '.deploy-data/node-cache');
const SEA_CONFIG = resolve(ROOT, 'sea-config.json');

// Node.js 22 LTS — battle-tested SEA support
const NODE_VERSION = 'v22.22.1';

const TARGETS = [
  { os: 'darwin', arch: 'arm64' },
  { os: 'darwin', arch: 'x64' },
  { os: 'linux', arch: 'arm64' },
  { os: 'linux', arch: 'x64' },
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

function nodeArchiveName(os, arch) {
  return `node-${NODE_VERSION}-${os}-${arch}.tar.gz`;
}

function nodeDownloadUrl(os, arch) {
  return `https://nodejs.org/dist/${NODE_VERSION}/${nodeArchiveName(os, arch)}`;
}

function nodeBinaryPathInArchive(os, arch) {
  return `node-${NODE_VERSION}-${os}-${arch}/bin/node`;
}

// ── Steps ────────────────────────────────────────────────────────────────────

async function step1_bundle() {
  console.log('\n[1/4] Bundling CLI for SEA...');
  mkdirSync(CLI_DIR, { recursive: true });

  // The CLI is ESM with top-level await and import.meta.dirname.
  // Node.js 22 SEA requires CJS, so we:
  //  1. Bundle with esbuild as ESM (resolves all imports to a single file)
  //  2. Post-process: convert ESM imports to CJS requires, replace import.meta,
  //     and wrap top-level code in an async IIFE

  // Use the JS API directly — pnpm's bin shim invokes `node bin/esbuild`,
  // but esbuild's postinstall replaces that path with a native binary, which
  // Node then tries to parse as JS and fails.
  await esbuild.build({
    entryPoints: [resolve(ROOT, 'bin/deploy.js')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: resolve(CLI_DIR, 'deploy.mjs'),
  });
  console.log('  Bundled bin/deploy.js → dist/cli/deploy.mjs');

  // Step 2: convert to CJS-compatible script for Node.js 22 SEA
  let code = readFileSync(resolve(CLI_DIR, 'deploy.mjs'), 'utf-8');

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

  // Wrap entire code in async IIFE to support top-level await
  code = `;(async () => {
${code}
})().catch((err) => { console.error(err.message || err); process.exit(1); });
`;

  writeFileSync(resolve(CLI_DIR, 'deploy.cjs'), code);
  console.log('  Converted ESM bundle to CJS wrapper');
}

function step2_generateBlob() {
  console.log('\n[2/4] Generating SEA blob...');
  // Must use the same-version Node that will be embedded — SEA blobs aren't
  // compatible across Node major versions, and the system node may be 23+.
  const hostNode = join(CACHE_DIR, `node-${process.platform}-${process.arch}`);
  if (!existsSync(hostNode)) {
    throw new Error(
      `Host node ${process.platform}-${process.arch} (${NODE_VERSION}) not cached — step3 must run first`,
    );
  }
  run(`${hostNode} --experimental-sea-config ${SEA_CONFIG}`);

  if (!existsSync(resolve(CLI_DIR, 'sea-prep.blob'))) {
    throw new Error('SEA blob was not generated');
  }
}

async function step3_downloadNodeBinaries() {
  console.log('\n[3/4] Downloading Node.js binaries...');
  mkdirSync(CACHE_DIR, { recursive: true });

  for (const { os, arch } of TARGETS) {
    const archiveName = nodeArchiveName(os, arch);
    const archivePath = join(CACHE_DIR, archiveName);
    const extractedBinaryPath = join(CACHE_DIR, `node-${os}-${arch}`);

    // Skip if already cached
    if (existsSync(extractedBinaryPath)) {
      console.log(`  Cached: node-${os}-${arch}`);
      continue;
    }

    // Download archive if not cached
    if (!existsSync(archivePath)) {
      await download(nodeDownloadUrl(os, arch), archivePath);
    }

    // Extract just the node binary from the tarball
    console.log(`  Extracting node binary for ${os}-${arch}...`);
    const binaryInArchive = nodeBinaryPathInArchive(os, arch);
    run(`tar -xzf ${archivePath} -C ${CACHE_DIR} ${binaryInArchive}`);

    // Move to a flat name
    copyFileSync(join(CACHE_DIR, binaryInArchive), extractedBinaryPath);
    chmodSync(extractedBinaryPath, 0o755);

    // Clean up extracted directory
    rmSync(join(CACHE_DIR, `node-${NODE_VERSION}-${os}-${arch}`), {
      recursive: true,
      force: true,
    });
  }
}

function step4_injectAndSign() {
  console.log('\n[4/4] Injecting SEA blob into binaries...');
  const blobPath = resolve(CLI_DIR, 'sea-prep.blob');
  const canCodesign = hasCommand('codesign');

  for (const { os, arch } of TARGETS) {
    const label = `${os}-${arch}`;
    const outputPath = join(CLI_DIR, `deploy-${label}`);
    const cachedNode = join(CACHE_DIR, `node-${os}-${arch}`);

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
      } else {
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
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Building deploy.local CLI binaries (Node.js SEA)');
  console.log(`  Embedded runtime: Node.js ${NODE_VERSION}`);
  console.log(`  Targets: ${TARGETS.map((t) => `${t.os}-${t.arch}`).join(', ')}`);

  await step1_bundle();
  // step3 must run before step2 — blob generation needs the matching-version
  // host node binary from the cache.
  await step3_downloadNodeBinaries();
  step2_generateBlob();
  step4_injectAndSign();

  console.log('\nDone! Binaries:');
  for (const { os, arch } of TARGETS) {
    const p = join(CLI_DIR, `deploy-${os}-${arch}`);
    if (existsSync(p)) {
      const size = statSync(p).size;
      const mb = (size / 1024 / 1024).toFixed(1);
      console.log(`  ${p} (${mb} MB)`);
    }
  }
}

main().catch((err) => {
  console.error('\nBuild failed:', err.message);
  process.exit(1);
});
