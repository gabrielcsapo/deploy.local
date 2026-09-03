#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../..');
const PLATFORMS = 'linux/amd64,linux/arm64';

export function suitcaseBuildArguments({ dockerfile, tag, push = false, output }) {
  const args = [
    'buildx',
    'build',
    '--platform',
    PLATFORMS,
    '--file',
    dockerfile,
    '--tag',
    tag,
    '--provenance=mode=max',
    '--sbom=true',
  ];
  if (push) args.push('--push');
  else args.push('--output', `type=oci,dest=${output}`);
  args.push(REPOSITORY_ROOT);
  return args;
}

export function buildSuitcaseImages({
  version = 'dev',
  registry = 'ghcr.io/deploy-local',
  push = false,
  sign = false,
} = {}) {
  if (sign && !push) throw new Error('--sign requires --push');
  const outputDirectory = resolve(REPOSITORY_ROOT, 'dist/suitcase');
  mkdirSync(outputDirectory, { recursive: true });
  const images = [
    {
      dockerfile: resolve(SCRIPT_DIRECTORY, 'core.Dockerfile'),
      tag: `${registry}/deploy.local-suitcase-core:${version}`,
      output: resolve(outputDirectory, `suitcase-core-${version}.oci.tar`),
    },
    {
      dockerfile: resolve(SCRIPT_DIRECTORY, 'helper.Dockerfile'),
      tag: `${registry}/deploy.local-suitcase-helper:${version}`,
      output: resolve(outputDirectory, `suitcase-helper-${version}.oci.tar`),
    },
  ];
  for (const image of images) {
    execFileSync('docker', suitcaseBuildArguments({ ...image, push }), {
      cwd: REPOSITORY_ROOT,
      stdio: 'inherit',
    });
    if (sign) {
      execFileSync('cosign', ['sign', '--yes', image.tag], {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
      });
    }
  }
  return images;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const push = process.argv.includes('--push');
  const sign = process.argv.includes('--sign');
  const versionFlag = process.argv.indexOf('--version');
  const registryFlag = process.argv.indexOf('--registry');
  const version =
    versionFlag === -1 ? process.env.SUITCASE_VERSION || 'dev' : process.argv[versionFlag + 1];
  const registry =
    registryFlag === -1
      ? process.env.SUITCASE_REGISTRY || 'ghcr.io/deploy-local'
      : process.argv[registryFlag + 1];
  if (!version || !registry) throw new Error('--version and --registry require values');
  buildSuitcaseImages({ version, registry, push, sign });
}
