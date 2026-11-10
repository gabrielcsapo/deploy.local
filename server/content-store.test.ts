import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let dataDirectory: string;
let store: typeof import('./store.ts');
let content: typeof import('./content-store.ts');

before(async () => {
  dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-content-store-'));
  process.env.DEPLOY_DATA_DIR = dataDirectory;
  store = await import(`./store.ts?content=${Date.now()}`);
  content = await import(`./content-store.ts?content=${Date.now()}`);
});

after(() => {
  store._resetDb();
  delete process.env.DEPLOY_DATA_DIR;
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe('content-addressed artifact store', () => {
  it('deduplicates and verifies immutable bytes', async () => {
    const bytes = Buffer.from('application release artifact');
    const first = content.putArtifactBytes(bytes, { type: 'release', retentionClass: 'release' });
    const second = content.putArtifactBytes(bytes, { type: 'release', retentionClass: 'release' });
    assert.equal(first.digest, second.digest);
    assert.equal(await content.verifyArtifact(first.digest), true);
    assert.deepEqual(readFileSync(first.path), bytes);
    assert.equal(
      (
        store.getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get() as {
          count: number;
        }
      ).count,
      1,
    );
  });
});
