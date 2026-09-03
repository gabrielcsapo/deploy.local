import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey, secretAddress } from './secrets.ts';

const directories: string[] = [];

afterEach(() => {
  delete process.env.DEPLOY_SECRET_KEY;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('application secret envelopes', () => {
  it('round-trips without embedding plaintext', () => {
    const key = randomBytes(32);
    const address = secretAddress('notes', 'adminPassword');
    const envelope = encryptSecret('correct horse battery staple', key, address);

    assert.equal(envelope.includes('correct horse'), false);
    assert.equal(decryptSecret(envelope, key, address), 'correct horse battery staple');
  });

  it('binds ciphertext to one configuration address', () => {
    const key = randomBytes(32);
    const envelope = encryptSecret('password', key, secretAddress('notes', 'adminPassword'));

    assert.throws(
      () => decryptSecret(envelope, key, secretAddress('other-app', 'adminPassword')),
      /authenticate|Unsupported state/i,
    );
  });

  it('creates and reuses an owner-only key file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-secret-key-'));
    directories.push(directory);

    const first = loadOrCreateSecretKey(directory);
    const second = loadOrCreateSecretKey(directory);
    const path = join(directory, 'secrets', 'master.key');

    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.deepEqual(readFileSync(path), first);
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
