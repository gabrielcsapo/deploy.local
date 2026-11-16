import test from 'node:test';
import assert from 'node:assert/strict';
import { keyNameFromComment, shortFingerprint } from './ssh-keys.ts';

test('a pasted key is named after the computer in its comment', () => {
  assert.equal(keyNameFromComment('ssh-ed25519 AAAAC3Nz gabriel@MacBook-Pro.local'), 'MacBook Pro');
  assert.equal(keyNameFromComment('ssh-ed25519 AAAAC3Nz bazzite'), 'bazzite');
  assert.equal(keyNameFromComment('ssh-ed25519 AAAAC3Nz'), '');
});

test('fingerprints are shortened to tell keys apart', () => {
  assert.equal(
    shortFingerprint('SHA256:q9TxR2mQ7tW4vB8nL3cY6pF1hD0sZ5aJ2eU8oG4k4kE'),
    'SHA256:q9T…4kE',
  );
  assert.equal(shortFingerprint('SHA256:short'), 'SHA256:short');
});
