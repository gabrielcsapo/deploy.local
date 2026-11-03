import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DesktopUpdater,
  updateAvailable,
  updateTarget,
  downloadProgress,
  verifyDownload,
} from '../src/updater.mjs';
const bytes = Buffer.from('a disposable archive');
const target = {
  file: 'app.zip',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const current = { commit: 'old', buildTime: '2026-01-01T00:00:00Z' };
const manifest = {
  version: '2',
  commit: 'new',
  buildTime: '2026-02-01T00:00:00Z',
  targets: { 'darwin-arm64': target },
};

test('availability requires a different known commit and a strictly newer valid time', () => {
  assert.equal(updateAvailable(current, manifest), true);
  for (const next of [
    current,
    { ...manifest, commit: 'old' },
    { ...manifest, buildTime: current.buildTime },
    { ...manifest, buildTime: 'invalid' },
    { ...manifest, buildTime: '2025-01-01' },
    { ...manifest, commit: 'unknown' },
    null,
  ])
    assert.equal(updateAvailable(current, next), false);
  assert.equal(updateAvailable({ ...current, buildTime: null }, manifest), false);
  assert.throws(() => updateTarget(manifest, 'x64'));
  assert.throws(() =>
    updateTarget(
      { ...manifest, targets: { 'darwin-arm64': { ...target, file: '../app.zip' } } },
      'arm64',
    ),
  );
});
test('progress is rounded from actual bytes and clamped', () => {
  assert.deepEqual(downloadProgress(54e6, 130e6), { bytes: 54e6, total: 130e6, percent: 42 });
  assert.equal(downloadProgress(200, 100).percent, 100);
  assert.equal(downloadProgress(0, 0).percent, 0);
});
test('verification checks both size and digest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'update-verify-'));
  try {
    const path = join(directory, 'archive');
    await writeFile(path, bytes);
    await verifyDownload(path, target);
    await assert.rejects(verifyDownload(path, { ...target, size: 1 }), /size/);
    await assert.rejects(verifyDownload(path, { ...target, sha256: '0'.repeat(64) }), /SHA-256/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-update-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const changes = [],
    installs = [];
  const client = {
    request: async () => manifest,
    download: async (_url, file, { onProgress }) => {
      await writeFile(file, bytes);
      onProgress(bytes.length);
    },
  };
  const updater = new DesktopUpdater({
    build: current,
    client: () => client,
    directory,
    arch: 'arm64',
    onChange: (status) => changes.push(status.phase),
    stage: async () => '/staged.app',
    install: async (...args) => installs.push(args),
    log: () => {},
    ...overrides,
  });
  return { updater, client, changes, installs, directory };
}
test('state machine checks, downloads, verifies, stages, then allows one restart', async (t) => {
  const { updater, changes, installs } = await fixture(t);
  await updater.restart('/dashboard');
  assert.equal(installs.length, 0);
  await updater.check();
  const first = updater.start();
  assert.equal(updater.start(), first);
  await first;
  assert.deepEqual(changes, ['available', 'downloading', 'downloading', 'checking', 'ready']);
  await updater.restart('/dashboard/projects');
  await updater.restart('/dashboard/projects');
  assert.equal(installs.length, 1);
  assert.equal(installs[0][1], '/dashboard/projects');
  assert.equal(updater.status().phase, 'installing');
});
test('cancel aborts and deletes partial data before making retry available', async (t) => {
  const { updater, client, directory } = await fixture(t);
  let downloading;
  const began = new Promise((resolve) => {
    downloading = resolve;
  });
  client.download = async (_url, file, { signal }) => {
    await writeFile(file, bytes.subarray(0, 3));
    downloading();
    await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  await updater.check();
  void updater.start();
  await began;
  await updater.cancel();
  assert.equal(updater.status().phase, 'available');
  assert.deepEqual(await readdir(directory), []);
});
test('hash failure never stages or installs; retry and network failure preserve installed app', async (t) => {
  let staged = 0;
  const { updater, client, installs } = await fixture(t, {
    stage: async () => {
      staged++;
    },
  });
  await updater.check();
  client.download = async (_url, file) => writeFile(file, Buffer.alloc(bytes.length));
  await updater.start();
  assert.equal(updater.status().error, 'verification');
  assert.equal(staged, 0);
  await updater.restart('/dashboard');
  assert.equal(installs.length, 0);
  client.download = async () => {
    throw new Error('offline');
  };
  await updater.start();
  assert.equal(updater.status().phase, 'failed');
  assert.equal(updater.status().error, 'network');
});
test('failed background checks preserve known availability; signature failure cannot become ready', async (t) => {
  const { updater, client } = await fixture(t, {
    stage: async () => {
      throw new Error('codesign');
    },
  });
  await updater.check();
  client.request = async () => {
    throw new Error('offline');
  };
  await updater.check();
  assert.equal(updater.status().phase, 'available');
  await updater.start();
  assert.equal(updater.status().phase, 'failed');
  assert.equal(updater.status().error, 'verification');
});

test('retry reads the new manifest and malformed checks cannot erase availability', async (t) => {
  const { updater, client } = await fixture(t);
  await updater.check();
  client.request = async () => ({});
  await updater.check();
  assert.equal(updater.status().phase, 'available');
  client.download = async () => {
    throw new Error('offline');
  };
  await updater.start();
  client.request = async () => ({ ...manifest, commit: 'newer' });
  client.download = async (_url, file) => writeFile(file, bytes);
  await updater.start();
  assert.equal(updater.status().phase, 'ready');
  assert.equal(updater.status().commit, 'newer');
});
