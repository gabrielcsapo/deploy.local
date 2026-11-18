import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { deployDataPath } from '../../kernel/files/data-directory.ts';
import { decryptSecret, encryptSecret, loadOrCreateSecretKey } from '../../secrets.ts';

/** Runtime journals contain configuration; use the same at-rest protection as agent jobs. */
export function readReleaseJournal<T>(id: string): T | undefined {
  const path = journalPath(id);
  try {
    return JSON.parse(
      decryptSecret(readFileSync(path, 'utf8'), loadOrCreateSecretKey(), `release:${id}`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
export function writeReleaseJournal(id: string, value: unknown) {
  const path = journalPath(id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    `${path}.tmp`,
    encryptSecret(JSON.stringify(value), loadOrCreateSecretKey(), `release:${id}`),
    { mode: 0o600, flush: true },
  );
  renameSync(`${path}.tmp`, path);
}
function journalPath(id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid release journal id');
  return deployDataPath('project-releases', 'journals', `${id}.json`);
}
