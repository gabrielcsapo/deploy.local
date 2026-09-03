/**
 * Build stamping — the identity of a deploy.local build.
 *
 * A build is identified by the commit it was built from plus the moment it was
 * built: rebuilding the same commit produces a new version, which is what makes
 * `deploy upgrade` able to answer "am I running the binary this server serves?"
 * for a project that ships from a working tree rather than tagged releases.
 *
 *   1.0.0+c4d1a04.20260724T173839Z
 *   └pkg┘ └commit┘ └─ build time ─┘
 *
 * Set SOURCE_DATE_EPOCH (seconds) to pin the timestamp for reproducible builds.
 * Set DEPLOY_BUILD_COMMIT to stamp a build made outside a git checkout.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(args, cwd) {
  try {
    return execSync(`git ${args}`, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

/** ISO-8601 at second precision — build times don't need milliseconds. */
function buildTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  const date = epoch ? new Date(Number(epoch) * 1000) : new Date();
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 2026-07-24T17:38:39Z → 20260724T173839Z (safe inside a semver build tag) */
function compactTimestamp(iso) {
  return iso.replace(/[-:]/g, '');
}

export function computeBuildInfo(root = DEFAULT_ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
  const commit = process.env.DEPLOY_BUILD_COMMIT || git('rev-parse HEAD', root) || 'unknown';
  const commitShort = commit === 'unknown' ? 'unknown' : commit.slice(0, 7);
  const dirty = commit !== 'unknown' && git('status --porcelain', root) !== '';
  const buildTime = buildTimestamp();

  return {
    version: `${pkg.version}+${commitShort}${dirty ? '.dirty' : ''}.${compactTimestamp(buildTime)}`,
    packageVersion: pkg.version,
    commit,
    commitShort,
    dirty,
    buildTime,
  };
}
