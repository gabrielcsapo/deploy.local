import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installWorkerBuild } from '../bin/worker-update.mjs';

test('worker verifies matching build and rolls back a failed replacement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-update-'));
  const path = join(root, 'worker');
  const bytes = Buffer.from('#!/bin/sh\nprintf \'{"version":"new"}\\n\'\n');
  const options = {
    path,
    bytes,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: 'new',
    platform: 'linux',
  };
  try {
    writeFileSync(path, 'old');
    await assert.rejects(
      () => installWorkerBuild({ ...options, sha256: '0'.repeat(64) }),
      /checksum/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'old');
    await assert.rejects(
      () => installWorkerBuild({ ...options, version: 'wrong' }),
      /does not match/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'old');
    await assert.rejects(
      () =>
        installWorkerBuild({
          ...options,
          probe: (candidate: string) => {
            if (candidate === path) throw new Error('startup failed');
          },
        }),
      /startup failed/,
    );
    assert.equal(readFileSync(path, 'utf8'), 'old');
    assert.equal((await installWorkerBuild(options)).version, 'new');
    assert.equal(readFileSync(`${path}.previous`, 'utf8'), 'old');
    assert.equal(readFileSync(path, 'utf8'), bytes.toString());
    await assert.rejects(
      () => installWorkerBuild({ ...options, platform: 'win32' }),
      /desktop app/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
