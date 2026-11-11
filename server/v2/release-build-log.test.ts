import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'release-build-log-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save } = await import('../workspace/store.ts');
const { releaseBuildLogId, releaseBuildOutput } = await import('./release-build-log.ts');
const { buildLogFilePath } = await import('../store.ts');
const { releasesApi } = await import('./releases-api.ts');
const { routeFetch } = await import('./test-request.ts');
const request = (owner: string) => routeFetch((req, res) => releasesApi(req, res, owner));

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

test('output is owner scoped, empty before output exists, and refreshed from the append-only log', async () => {
  save('v2-release', 'owner', { id: 'tail', release: { id: 'tail', projectId: 'gym' } });
  const url = 'http://localhost/api/v2/releases/tail/output';
  assert.equal((await request('other')(url)).status, 404);
  assert.equal(
    (await request('owner')('http://localhost/api/v2/releases/missing/output')).status,
    404,
  );
  assert.deepEqual(await (await request('owner')(url)).json(), { output: '' });
  save('v2-upload-release', 'owner', { id: '1335', releaseId: 'tail' });
  assert.equal(await releaseBuildOutput('owner', 'tail'), '');
  writeFileSync(buildLogFilePath(1335), 'Preparing\n');
  assert.deepEqual(await (await request('owner')(url)).json(), { output: 'Preparing' });
  appendFileSync(buildLogFilePath(1335), 'Verifying\n');
  assert.deepEqual(await (await request('owner')(url)).json(), { output: 'Preparing\nVerifying' });
  save('v2-upload-release', 'other', { id: '9999', releaseId: 'tail' });
  writeFileSync(buildLogFilePath(9999), 'private');
  assert.equal(releaseBuildLogId('tail', 'owner'), 1335);
  assert.equal(await releaseBuildOutput('owner', 'tail'), 'Preparing\nVerifying');
  assert.equal(
    (await request('owner')(url, { headers: { 'x-deploy-agent-token': 'agent' } })).status,
    403,
  );
});

test('tail is capped at 200 lines and 64 KiB and handles UTF-8 and unfinished lines', async () => {
  save('v2-upload-release', 'owner', { id: '1336', releaseId: 'large' });
  const path = buildLogFilePath(1336);
  writeFileSync(path, Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n');
  const output = await releaseBuildOutput('owner', 'large');
  assert.equal(output.split('\n').length, 200);
  assert.equal(output.split('\n')[0], 'line 100');
  assert.equal(output.split('\n').at(-1), 'line 299');
  writeFileSync(path, 'é'.repeat(100000) + 'last');
  const bounded = await releaseBuildOutput('owner', 'large');
  assert(Buffer.byteLength(bounded) <= 65536);
  assert(!bounded.includes('�'));
  assert(bounded.endsWith('last'));
});
