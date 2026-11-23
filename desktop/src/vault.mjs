import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
export class Vault {
  constructor(path, storage) {
    this.path = path;
    this.storage = storage;
  }
  available() {
    return (
      this.storage.isEncryptionAvailable() &&
      this.storage.getSelectedStorageBackend?.() !== 'basic_text'
    );
  }
  read() {
    try {
      const encrypted = readFileSync(this.path);
      if (!this.available()) return null;
      const serialized = this.storage.decryptString(encrypted);
      const value = JSON.parse(serialized);
      this.savedDigest = createHash('sha256').update(serialized).digest('hex');
      return value;
    } catch {
      return null;
    }
  }
  write(value) {
    const serialized = JSON.stringify(value);
    const digest = createHash('sha256').update(serialized).digest('hex');
    if (digest === this.savedDigest) return;
    if (!this.available()) throw new Error('Unlock your system keychain to save sign-in securely.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', this.storage.encryptString(serialized), {
      mode: 0o600,
    });
    renameSync(this.path + '.tmp', this.path);
    this.savedDigest = digest;
  }
}
