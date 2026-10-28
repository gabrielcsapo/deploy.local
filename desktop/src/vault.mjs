import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
      if (!this.available()) return null;
      return JSON.parse(this.storage.decryptString(readFileSync(this.path)));
    } catch {
      return null;
    }
  }
  write(value) {
    if (!this.available()) throw new Error('Unlock your system keychain to save sign-in securely.');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path + '.tmp', this.storage.encryptString(JSON.stringify(value)), {
      mode: 0o600,
    });
    renameSync(this.path + '.tmp', this.path);
  }
}
