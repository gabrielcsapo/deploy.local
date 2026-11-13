import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFetch } from '../v2/test-request.ts';
import { randomUUID } from 'node:crypto';
const directory = mkdtempSync(join(tmpdir(), 'repository-settings-'));
process.env.DEPLOY_DATA_DIR = directory;
const { workspaceApi } = await import('./api.ts');
const { save, get, db, events } = await import('./store.ts');
const fetch = routeFetch((req, res) =>
  workspaceApi(
    req,
    res,
    req.headers['x-test-owner'] === 'bob' ? 'bob' : 'alice',
    req.headers['x-test-worker'] ? 'worker' : undefined,
  ),
);
const origin = 'http://127.0.0.1:5180';
after(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
test('repository settings are owner-scoped, revision checked and idempotent without changing Git or operation state', async () => {
  const original = {
    id: 'settings',
    name: 'Before',
    repositoryPath: '/owned/repository.git',
    repositoryStatus: 'preparing',
    repositoryOperationId: 'operation',
    sourcePath: '/import/source',
    defaultBranch: 'main',
  };
  save('project', 'alice', original);
  const post = async (body: any, owner = 'alice', worker = false) => {
    const response = await fetch(origin + '/api/workspace/projects/settings/settings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-owner': owner,
        ...(worker ? { 'x-test-worker': '1' } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  const update = {
    operationId: randomUUID(),
    settingsRevision: 0,
    name: ' After ',
    description: ' A real repository ',
    repositoryPath: '/untrusted',
    owner: 'bob',
    defaultBranch: 'other',
  };
  const first = await post(update);
  assert.equal(first.status, 200);
  assert.equal(first.body.name, 'After');
  assert.equal(first.body.description, 'A real repository');
  assert.equal(first.body.settingsRevision, 1);
  const persisted = await fetch(origin + '/api/workspace/projects/settings/settings');
  assert.deepEqual(await persisted.json(), {
    id: 'settings',
    name: 'After',
    description: 'A real repository',
    settingsRevision: 1,
  });
  assert.equal(
    (
      await fetch(origin + '/api/workspace/projects/settings/settings', {
        headers: { 'x-test-owner': 'bob' },
      })
    ).status,
    404,
  );
  for (const key of [
    'repositoryPath',
    'repositoryStatus',
    'repositoryOperationId',
    'sourcePath',
    'defaultBranch',
  ] as const)
    assert.equal(first.body[key], original[key]);
  assert.deepEqual(
    (await post(update)).body,
    first.body,
    'transport retry replays the original save',
  );
  assert.equal(
    events('alice').filter((event) => event.type === 'project.updated').length,
    1,
    'other clients are notified once without replaying the update',
  );
  assert.equal(
    (await post({ ...update, operationId: randomUUID() })).status,
    409,
    'stale edits cannot overwrite newer settings',
  );
  assert.equal(
    (
      await post({
        ...update,
        operationId: randomUUID(),
        settingsRevision: 1,
        name: 'invalid\nname',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        ...update,
        operationId: randomUUID(),
        settingsRevision: 1,
        description: 'x'.repeat(241),
      })
    ).status,
    400,
  );
  assert.equal(
    get('project', 'alice', 'settings').settingsRevision,
    1,
    'rejections leave saved metadata intact',
  );
  assert.equal((await post({ ...update, operationId: randomUUID() }, 'bob')).status, 404);
  assert.equal((await post({ ...update, operationId: randomUUID() }, 'alice', true)).status, 403);
});
