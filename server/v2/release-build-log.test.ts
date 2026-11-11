import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'release-build-log-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save } = await import('../workspace/store.ts');
const { releaseBuildLogId } = await import('./release-build-log.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('an uploaded release maps to the build log its upload opened', () => {
  save('v2-upload-release', 'owner', { id: '1333', releaseId: 'release-a' });
  save('v2-upload-release', 'owner', { id: '1334', releaseId: 'release-b' });
  assert.equal(releaseBuildLogId('release-a'), 1333);
  assert.equal(releaseBuildLogId('release-b'), 1334);
  // A release started without an upload has no build log to write to.
  assert.equal(releaseBuildLogId('release-from-a-pull-request'), null);
  assert.equal(releaseBuildLogId(undefined), null);
});
