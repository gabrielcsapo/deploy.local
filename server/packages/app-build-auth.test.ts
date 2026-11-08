import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = await mkdtemp(join(tmpdir(), 'app-build-auth-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const workspace = await import('../workspace/store.ts');
const { setPackageHooks } = await import('../workspace/package-hooks.ts');
const { fleetRoutes } = await import('../api/fleet.ts');
after(async () => {
  store._resetDb();
  workspace.db.close();
  await rm(root, { recursive: true, force: true });
});
test('app build control channel authorizes only a running build on the assigned computer and derives owner/project', async () => {
  const enrollment = store.createNodeEnrollment('iMac', 'alice');
  const node = store.redeemNodeEnrollment({ code: enrollment.code });
  assert.ok(node.nodeId && node.secret);
  store
    .getSqlite()!
    .prepare(
      "INSERT INTO deployments (name, username, status, app_id, created_at, updated_at) VALUES ('forma','alice','building','forma-id','now','now')",
    )
    .run();
  workspace.save('application-origin', 'alice', { id: 'forma', projectId: 'forma-project' });
  const requested: unknown[][] = [];
  setPackageHooks({
    installConfig: async (...args) => {
      requested.push(args);
      return { registry: 'https://deploy.local/npm/', key: 'install-only', ca: 'CA' };
    },
    revokeComputer() {},
    finishJob() {},
  });
  const job = store.enqueueAgentJob({
    nodeId: node.nodeId!,
    type: 'deploy',
    deploymentName: 'forma',
    payload: {},
  });
  async function call(id: string, secret = node.secret, nodeId = node.nodeId) {
    let status = 200;
    let body = '';
    const path = `/api/agent/jobs/${id}/packages`;
    const handled = await fleetRoutes({
      path,
      method: 'POST',
      req: { headers: { 'x-deploy-node-id': nodeId, 'x-deploy-node-secret': secret } },
      res: {
        setHeader() {},
        writeHead(code: number) {
          status = code;
        },
        end(text: string) {
          body = text;
        },
      },
    } as any);
    return { handled, status, body };
  }
  assert.equal((await call(job.id)).status, 403, 'queued jobs cannot request keys');
  store.claimAgentJob(node.nodeId!);
  assert.equal((await call(job.id, 'wrong')).status, 401);
  assert.equal((await call('missing')).status, 403);
  const otherEnrollment = store.createNodeEnrollment('Other computer', 'alice');
  const other = store.redeemNodeEnrollment({ code: otherEnrollment.code });
  assert.equal((await call(job.id, other.secret, other.nodeId)).status, 403);
  const response = await call(job.id);
  assert.equal(response.handled, true);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).key, 'install-only');
  assert.deepEqual(requested, [['alice', node.nodeId, 'forma-project']]);
  store.completeAgentJob(job.id, node.nodeId!, { success: true });
  assert.equal((await call(job.id)).status, 403);
});
