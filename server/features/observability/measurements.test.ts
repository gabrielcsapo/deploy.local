import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'measurements-'));
process.env.DEPLOY_DATA_DIR = root;
const { saveDeployment, getDeployment, _resetDb } = await import('../../store.ts');
const { getRequestsSqlite } = await import('../../requests-db.ts');
const { appMeasurements } = await import('./measurements.ts');
after(() => {
  _resetDb();
  rmSync(root, { recursive: true, force: true });
});
test('HTTP edge recording distinguishes a quiet hour, recent traffic and an app without a published HTTP route', () => {
  saveDeployment({ name: 'quiet', username: 'owner', type: 'web', port: 19000 });
  saveDeployment({ name: 'private', username: 'owner', type: 'web' });
  assert.deepEqual(appMeasurements(getDeployment('quiet')!).traffic, {
    state: 'measured',
    requests: 0,
    reqPerMin: 0,
    p95ms: null,
  });
  assert.deepEqual(appMeasurements(getDeployment('private')!).traffic, {
    state: 'not-measured',
    reason: 'Traffic is not recorded for this app',
  });
  getRequestsSqlite()
    .prepare(
      'INSERT INTO request_logs(deployment_name,method,path,status,duration,timestamp) VALUES(?,?,?,?,?,?)',
    )
    .run('quiet', 'GET', '/', 200, 42, Date.now());
  assert.deepEqual(appMeasurements(getDeployment('quiet')!).traffic, {
    state: 'measured',
    requests: 1,
    reqPerMin: 1,
    p95ms: 42,
  });
});
