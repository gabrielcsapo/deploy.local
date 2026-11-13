import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cliBinaryFilename } from './cli-download.ts';

describe('standalone CLI artifact names', () => {
  it('matches Node platform identifiers and keeps the Windows executable suffix', () => {
    assert.equal(cliBinaryFilename('darwin', 'arm64'), 'deploy-darwin-arm64');
    assert.equal(cliBinaryFilename('linux', 'x64'), 'deploy-linux-x64');
    assert.equal(cliBinaryFilename('win32', 'x64'), 'deploy-win32-x64.exe');
  });
});

import { generateInstallScript, type CliBuildManifest } from './cli-download.ts';
import { spawnSync } from 'node:child_process';

it('POSIX installer pins each supported worker checksum before signing or installing', () => {
  const digest = 'a'.repeat(64);
  const manifest = {
    version: 'build-2',
    packageVersion: '1.0.0',
    commit: 'build-2',
    commitShort: 'build-2',
    dirty: false,
    buildTime: '',
    runtime: 'node26',
    targets: {
      'darwin-arm64': { sha256: digest, size: 12 },
      'linux-x64': { sha256: digest, size: 12 },
    },
  } as CliBuildManifest;
  const script = generateInstallScript('http://deploy.local', 'https://deploy.local', manifest);
  assert.match(script, /darwin-arm64\) EXPECTED="a{64}"/);
  assert.match(script, /linux-x64\) EXPECTED="a{64}"/);
  assert(script.indexOf('Worker checksum mismatch') < script.indexOf('codesign --sign'));
  assert(script.indexOf('Worker checksum mismatch') < script.indexOf('mv "$STAGED" "$CLI_PATH"'));
  assert.match(script, /Windows computers use the desktop app/);
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0);
  assert.match(
    generateInstallScript('http://deploy.local', 'https://deploy.local', null),
    /No matching worker build/,
  );
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { serveCliBinary } from './cli-download.ts';

it('coordinator serves only bytes matching the requested build and manifest checksum', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'served-worker-'));
  const bytes = Buffer.from('fake second worker build');
  const manifest = {
    version: 'second',
    targets: {
      'linux-x64': { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    },
  };
  const response = async (version: string) => {
    let status = 0;
    let body: any;
    await serveCliBinary(
      {
        url: `/cli?os=linux&arch=x64&version=${version}`,
        headers: { host: 'deploy.local' },
      } as any,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: unknown) {
          body = value;
        },
      } as any,
      directory,
    );
    return { status, body };
  };
  try {
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'deploy-linux-x64'), bytes);
    assert.equal((await response('first')).status, 409);
    assert.equal((await response('second')).status, 200);
    assert.deepEqual((await response('second')).body, bytes);
    writeFileSync(join(directory, 'deploy-linux-x64'), 'corrupt');
    assert.equal((await response('second')).status, 409);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import { mkdirSync } from 'node:fs';
import { cliDirectory } from './cli-download.ts';

it('serves the newer CLI build, so a release shipped without one keeps the last', () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-directory-'));
  const release = join(root, 'release/dist/cli');
  const data = join(root, 'data/cli');
  const build = (directory: string, buildTime: string) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({ buildTime, targets: {} }));
  };
  try {
    assert.equal(cliDirectory([release, data]), release, 'nothing built: the release folder');
    build(data, '2026-10-30T15:04:39Z');
    assert.equal(cliDirectory([release, data]), data, 'release without builds: the kept ones');
    build(release, '2026-10-30T16:00:00Z');
    assert.equal(cliDirectory([release, data]), release, 'release with newer builds: its own');
    build(data, '2026-10-30T17:00:00Z');
    assert.equal(cliDirectory([release, data]), data, 'newer kept builds win');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('installer --join checks the code, then joins with it from the environment', () => {
  const script = generateInstallScript('http://deploy.local', 'https://deploy.local', {
    version: '1.0.0+abc',
    targets: { 'linux-x64': { sha256: 'a'.repeat(64), size: 1 } },
  } as unknown as CliBuildManifest);
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0);
  const run = (...args: string[]) =>
    spawnSync('sh', ['-s', '--', ...args], { input: script, encoding: 'utf8' });
  const bad = run('--join', '7KQ2;rm -rf ~');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /join code doesn't look right/);
  assert.equal(run('--join').status, 1);
  // Join codes are base64url, so they can contain _ and -.
  const offline = generateInstallScript('http://127.0.0.1:9', 'https://127.0.0.1:9', null);
  const good = spawnSync('sh', ['-s', '--', '--join', 'JOIN-AB_C-D9'], {
    input: offline,
    encoding: 'utf8',
  });
  assert.doesNotMatch(good.stdout, /join code doesn't look right/);
  assert.equal(run('--other').status, 1);
  // The code travels in DEPLOY_JOIN_CODE, never as an argument; Linux joins with sudo.
  assert.match(
    script,
    /sudo env DEPLOY_JOIN_CODE="\$JOIN" "\$CLI_PATH" computer join "https:\/\/deploy\.local"/,
  );
  assert.match(script, /grep -qF '"1\.0\.0\+abc"'/);
  assert(script.indexOf('# ── Join') > script.indexOf('mv "$STAGED" "$CLI_PATH"'));
});

it('code downloads use the same selected directory and reject mixed-release or corrupt bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'served-code-'));
  const bytes = Buffer.from('module.exports = async () => {};');
  const manifest = {
    version: 'new',
    targets: {},
    bundle: {
      file: 'deploy.cjs',
      version: 'new',
      launcherProtocol: 1,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  };
  const response = async (version: string) => {
    let status = 0,
      body: any;
    await serveCliBinary(
      { url: `/cli/code?version=${version}`, headers: { host: 'deploy.local' } } as any,
      {
        writeHead(code: number) {
          status = code;
        },
        end(value: unknown) {
          body = value;
        },
      } as any,
      directory,
    );
    return { status, body };
  };
  try {
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify(manifest));
    writeFileSync(join(directory, 'deploy.cjs'), bytes);
    assert.deepEqual(await response('new'), { status: 200, body: bytes });
    assert.equal((await response('old')).status, 409);
    writeFileSync(join(directory, 'deploy.cjs'), 'corrupt');
    assert.equal((await response('new')).status, 409);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
