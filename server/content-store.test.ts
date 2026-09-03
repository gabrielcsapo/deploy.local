import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  it('deduplicates, verifies, and pins immutable bytes', async () => {
    const bytes = Buffer.from('portable release artifact');
    const first = content.putArtifactBytes(bytes, { type: 'release', retentionClass: 'release' });
    const second = content.putArtifactBytes(bytes, { type: 'release', retentionClass: 'release' });
    assert.equal(first.digest, second.digest);
    assert.equal(await content.verifyArtifact(first.digest), true);
    assert.deepEqual(readFileSync(first.path), bytes);
    assert.equal(content.pinArtifact(first.digest), 1);
    assert.equal(content.pinArtifact(first.digest, -1), 0);
    assert.equal(content.contentStoreStats().artifacts, 1);
  });

  it('resumes transfers and accepts an identical replay without duplication', async () => {
    const bytes = Buffer.from('a resumable artifact that crosses several chunks');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const transfer = content.beginArtifactTransfer({
      sourceSiteId: 'site-home',
      destinationSiteId: 'site-suitcase',
      digest,
      expectedSize: bytes.length,
    });
    const id = String(transfer.id);
    const first = bytes.subarray(0, 12);
    await content.appendArtifactTransferChunk(id, 0, first, { type: 'checkpoint' });
    await content.appendArtifactTransferChunk(id, 0, first, { type: 'checkpoint' });
    const partial = content.beginArtifactTransfer({
      sourceSiteId: 'site-home',
      destinationSiteId: 'site-suitcase',
      digest,
      expectedSize: bytes.length,
    });
    assert.equal(partial.verified_offset, 12);

    const completed = (await content.appendArtifactTransferChunk(id, 12, bytes.subarray(12), {
      type: 'checkpoint',
      retentionClass: 'checkpoint',
    })) as Record<string, unknown>;
    assert.equal(completed.status, 'complete');
    assert.equal(await content.verifyArtifact(digest), true);
  });

  it('rejects gaps and corrupt resumed data', async () => {
    const bytes = Buffer.from('expected');
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const transfer = content.beginArtifactTransfer({
      sourceSiteId: 'a',
      destinationSiteId: 'b',
      digest,
      expectedSize: bytes.length,
    });
    await assert.rejects(
      content.appendArtifactTransferChunk(String(transfer.id), 1, bytes.subarray(0, 2), {
        type: 'test',
      }),
      /Expected artifact offset 0/,
    );
  });
});
