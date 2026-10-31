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
