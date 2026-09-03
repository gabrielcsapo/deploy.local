import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, it } from 'node:test';

let root: string;
let store: typeof import('./store.ts');

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'deploy-data-directory-'));
  process.env.DEPLOY_DATA_DIR = root;
  store = await import(`./store.ts?data-directory=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(root, { recursive: true, force: true });
});

it('uses DEPLOY_DATA_DIR for the database, volumes, backups, and content state', async () => {
  const volumes = await import(`./volumes.ts?data-directory=${Date.now()}`);
  const dataDirectory = await import(`./data-directory.ts?data-directory=${Date.now()}`);
  store.getSqlite();
  const volume = volumes.getVolumeDir('notes');
  const backup = volumes.getBackupDir('notes');
  assert.equal(volume, join(root, 'volumes', 'notes'));
  assert.equal(backup, join(root, 'backups', 'notes'));
  assert.equal(dataDirectory.deployDataPath('blobs'), join(root, 'blobs'));
  assert.equal(existsSync(join(root, 'deploy.db')), true);
});
