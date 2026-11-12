import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'v2-releases-api-'));
process.env.DEPLOY_DATA_DIR = root;
const { projectReleaseService, releasesApi } = await import('./releases-api.ts');
const { _resetDb } = await import('../store.ts');
const { db } = await import('../workspace/store.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// Recovery after a restart waits on a computer that never answers.
let finishRecovery!: () => void;
projectReleaseService.recover = () => new Promise<void>((resolve) => (finishRecovery = resolve));

function call(method: string, path: string) {
  const req = Object.assign(Readable.from([Buffer.from(method === 'GET' ? '' : '{}')]), {
    method,
    url: path,
    headers: {},
  }) as unknown as IncomingMessage;
  let status = 0;
  const res = {
    writeHead: (code: number) => (status = code),
    end: () => {},
  } as unknown as ServerResponse;
  return releasesApi(req, res, 'owner').then(() => status);
}

test('reads answer while recovery is still waiting; changes wait for it', async () => {
  assert.equal(await call('GET', '/api/v2/approvals'), 200);
  let changed = false;
  const change = call('PUT', '/api/v2/approvals').then((status) => ((changed = true), status));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(changed, false);
  finishRecovery();
  await change;
  assert.equal(changed, true);
});

test('release detail and project list return parts and still serialize older releases', async () => {
  const { routeFetch } = await import('./test-request.ts');
  const { save } = await import('../workspace/store.ts');
  // A project without a checkout is enough for these read-only routes.
  save('project', 'parts-owner', {
    id: 'parts-project',
    name: 'parts-project',
    repositoryStatus: 'pending',
  });
  const parts = [{ name: 'copy data', app: 'web', startedAt: '2026-11-12T12:00:00.000Z' }];
  for (const [id, extra] of [
    ['new', { parts }],
    ['old', {}],
  ] as const)
    save('v2-release', 'parts-owner', {
      id,
      release: {
        id,
        projectId: 'parts-project',
        state: 'running',
        steps: [{ name: 'verify', state: 'running', ...extra }],
      },
    });
  const fetch = routeFetch((req, res) => releasesApi(req, res, 'parts-owner'));
  const detail = await fetch('http://localhost/api/v2/releases/new');
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).release.steps[0].parts, parts);
  const old = await fetch('http://localhost/api/v2/releases/old');
  assert.equal(old.status, 200);
  assert.equal(Object.hasOwn((await old.json()).release.steps[0], 'parts'), false);
  const list = await fetch('http://localhost/api/v2/projects/parts-project/releases');
  assert.equal(list.status, 200, await list.clone().text());
  const releases = (await list.json()).releases;
  assert.deepEqual(releases.find((row: any) => row.id === 'new').steps[0].parts, parts);
  assert.equal(
    Object.hasOwn(releases.find((row: any) => row.id === 'old').steps[0], 'parts'),
    false,
  );
});
