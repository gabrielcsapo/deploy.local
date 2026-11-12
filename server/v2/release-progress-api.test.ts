import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'release-progress-api-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { _resetDb: resetDb } = store;
const { fleetRoutes } = await import('../api/fleet.ts');
const { db } = await import('../workspace/store.ts');
after(() => {
  resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('existing progress endpoint authenticates and accepts only the claiming computer', async () => {
  const enroll = (name: string) => {
    const node = store.redeemNodeEnrollment({
      code: store.createNodeEnrollment(name, 'owner').code,
    });
    assert.ok(node.nodeId);
    assert.ok(node.secret);
    return { nodeId: node.nodeId, secret: node.secret };
  };
  const worker = enroll('worker');
  const other = enroll('other');
  const job = store.enqueueAgentJob({
    nodeId: worker.nodeId,
    deploymentName: 'web',
    type: 'project-release',
    payload: {},
  });
  const fetch = routeFetch((req, res) =>
    fleetRoutes({ req, res, path: req.url, method: req.method } as never),
  );
  const post = (node = worker, secret = node.secret, body: unknown = { parts: [] }) =>
    fetch(`http://localhost/api/agent/jobs/${job.id}/progress`, {
      method: 'POST',
      headers: { 'x-deploy-node-id': node.nodeId, 'x-deploy-node-secret': secret },
      body: JSON.stringify(body),
    });
  assert.equal((await post(worker, 'wrong')).status, 401);
  assert.equal((await post(other)).status, 404);
  assert.equal((await post()).status, 409);
  assert.equal(store.claimAgentJob(worker.nodeId)!.id, job.id);
  // Older release workers sent build output here but have no per-job heartbeat.
  assert.equal((await post(worker, worker.secret, { output: 'building\n' })).status, 200);
  assert.equal(store.getAgentJob(job.id)!.progress, null);
  const parts = [{ name: 'copy data', startedAt: new Date().toISOString() }];
  assert.equal((await post(worker, worker.secret, { parts })).status, 200);
  const progress = JSON.parse(store.getAgentJob(job.id)!.progress!);
  assert.deepEqual(progress.parts, parts);
  assert.ok(progress.receivedAt <= Date.now());
  assert.equal((await post(worker, worker.secret, { parts: [{ name: 'bad' }] })).status, 409);
  assert.deepEqual(JSON.parse(store.getAgentJob(job.id)!.progress!), progress);
  store.completeAgentJob(job.id, worker.nodeId, { success: true });
  assert.equal((await post()).status, 409);
});
