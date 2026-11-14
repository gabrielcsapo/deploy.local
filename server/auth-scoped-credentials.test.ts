import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'auth-scopes-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const workspace = await import('./workspace/store.ts');
const nodes = await import('./store/nodes.ts');
const runs = await import('./workspace/coordination.ts');
const ci = await import('./ci-releases.ts');
const keys = await import('./packages/keys.ts');
const pipeline = await import('./packages/pipeline-auth.ts');
const uploads = await import('./agent-upload.ts');
const telemetry = await import('./telemetry.ts');
const { verifyTelemetry } = await import('./kernel/auth/index.ts');
const { openRequestsDb } = await import('./requests-db.ts');
const telemetryDb = openRequestsDb(join(root, 'test-requests.db'));
store.registerUser('owner', 'password');
const sql = store.getSqlite()!;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const request = (token: string) =>
  ({ headers: { authorization: 'Bearer ' + token } }) as IncomingMessage;
after(() => {
  telemetryDb.close();
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('node enrollment preserves expiry, name restriction and single use; node secret preserves revocation', () => {
  const expired = nodes.createNodeEnrollment('expired', 'owner');
  sql.prepare('UPDATE node_enrollments SET expires_at=0 WHERE id=?').run(expired.id);
  assert.equal(
    nodes.redeemNodeEnrollment({ code: expired.code }).error,
    'Enrollment code is invalid or expired',
  );
  assert.equal(
    nodes.redeemNodeEnrollment({ code: 'malformed' }).error,
    'Enrollment code is invalid or expired',
  );
  const enrollment = nodes.createNodeEnrollment('matrix-node', 'owner');
  assert.equal(
    nodes.redeemNodeEnrollment({ code: enrollment.code, name: 'wrong' }).error,
    'This enrollment is reserved for "matrix-node"',
  );
  const node = nodes.redeemNodeEnrollment({ code: enrollment.code });
  assert.ok(node.nodeId && node.secret);
  assert.equal(nodes.authenticateNode(node.nodeId, node.secret), true);
  assert.equal(nodes.authenticateNode('wrong', node.secret), false);
  assert.equal(nodes.authenticateNode(node.nodeId, 'malformed'), false);
  assert.equal(
    nodes.redeemNodeEnrollment({ code: enrollment.code }).error,
    'Enrollment code is invalid or expired',
  );
  sql
    .prepare('UPDATE nodes SET revoked_at=? WHERE id=?')
    .run(new Date().toISOString(), node.nodeId);
  assert.equal(nodes.authenticateNode(node.nodeId, node.secret), false);
});

test('run token preserves owner/task binding, expiry and live-run fencing', () => {
  const scope = { owner: 'owner', taskId: 'task', runId: 'run' };
  workspace.save('run', scope.owner, { id: scope.runId, status: 'running' });
  const token = runs.issueAgentToken(scope);
  assert.deepEqual(runs.authenticateAgent(token), scope);
  assert.equal(runs.authenticateAgent('malformed'), null);
  assert.equal(runs.authenticateAgent('a'.repeat(201)), null);
  const saved = workspace.get('agent-credential', scope.owner, hash(token));
  workspace.save('agent-credential', scope.owner, { ...saved, expiresAt: 0 });
  assert.equal(runs.authenticateAgent(token), null);
  workspace.save('agent-credential', scope.owner, saved);
  workspace.save('run', scope.owner, { id: scope.runId, status: 'running', stopRequested: true });
  assert.equal(runs.authenticateAgent(token), null);
  workspace.save('run', scope.owner, { id: scope.runId, status: 'succeeded' });
  assert.equal(runs.authenticateAgent(token), null);
  workspace.remove('agent-credential', scope.owner, hash(token));
  assert.equal(runs.authenticateAgent(token), null);
});

test('CI credential preserves expiry, revocation, syntax and current application ownership', () => {
  sql.prepare('INSERT INTO deployments(name,username) VALUES(?,?)').run('matrix-app', 'owner');
  const issued = ci.issueOwnedCiCredential('owner', 'matrix-app', 60);
  assert.equal(ci.authenticateCi(issued.token).username, 'owner');
  assert.equal(ci.authenticateCi(issued.token).application, 'matrix-app');
  const refused = () =>
    assert.throws(() => ci.authenticateCi(issued.token), { message: 'Unauthorized', status: 401 });
  assert.throws(() => ci.authenticateCi('malformed'), { message: 'Unauthorized', status: 401 });
  sql.prepare('UPDATE ci_credentials SET expires_at=0 WHERE id=?').run(issued.id);
  refused();
  sql.prepare('UPDATE ci_credentials SET expires_at=? WHERE id=?').run(issued.expiresAt, issued.id);
  sql.prepare('UPDATE deployments SET username=? WHERE name=?').run('other', 'matrix-app');
  refused();
  sql.prepare('UPDATE deployments SET username=? WHERE name=?').run('owner', 'matrix-app');
  ci.revokeCiCredential(issued.id, 'owner');
  refused();
});

test('personal and computer package keys preserve install/publish limits and revocation', () => {
  const install = keys.createKey('owner', 'Install', 'install');
  const identity = keys.registryIdentity(request(install.key))!;
  assert.equal(identity.username, 'owner');
  assert.equal(identity.publish, false);
  assert.throws(() => keys.canPublish(identity), {
    message: 'This package key can only install.',
    status: 403,
  });
  assert.equal(keys.registryIdentity(request('malformed')), null);
  assert.equal(
    keys.registryIdentity({
      headers: { authorization: 'Bearer ' + install.key, 'x-deploy-agent-token': 'present' },
    } as unknown as IncomingMessage),
    null,
  );
  sql.prepare('DELETE FROM package_keys WHERE id=?').run(install.id);
  assert.equal(keys.registryIdentity(request(install.key)), null);
  const computer = keys.computerPackageKey('owner', 'computer');
  const machine = keys.registryIdentity(request(computer))!;
  assert.equal(machine.computer, true);
  assert.equal(machine.admin, false);
  assert.throws(() => keys.canPublish(machine), { status: 403 });
  keys.revokeComputerPackageKey('owner', 'computer');
  assert.equal(keys.registryIdentity(request(computer)), null);
});

test('pipeline package credential preserves job generation, expiry, run and publish authority', () => {
  const job = {
    id: 'job',
    pipelineId: 'pipeline',
    generation: 1,
    packagePublish: true,
    status: 'running',
  };
  const run = {
    id: 'pipeline',
    projectId: 'project',
    status: 'succeeded',
    commit: 'commit',
    packages: {
      status: 'running',
      items: [{ jobId: job.id, name: 'package', version: '1.0.0', status: 'running' }],
    },
  };
  workspace.save('project', 'owner', { id: 'project', owner: 'owner' });
  workspace.save('pipeline-run', 'owner', run);
  workspace.save('job', 'owner', job);
  const token = pipeline.issuePipelinePackageToken('owner', job);
  const identity = pipeline.pipelinePackageIdentity(token)!;
  assert.equal(identity.username, 'owner');
  assert.equal(identity.pipeline.jobId, job.id);
  assert.equal(pipeline.pipelinePackageIdentity('malformed'), null);
  const credential = workspace.get('pipeline-package-token', '', hash(token));
  workspace.save('pipeline-package-token', '', { ...credential, expiresAt: 0 });
  assert.equal(pipeline.pipelinePackageIdentity(token), null);
  workspace.save('pipeline-package-token', '', credential);
  workspace.save('job', 'owner', { ...job, generation: 2 });
  assert.equal(pipeline.pipelinePackageIdentity(token), null);
  workspace.save('job', 'owner', job);
  workspace.save('project', 'owner', { id: 'project', owner: 'other' });
  assert.equal(pipeline.pipelinePackageIdentity(token), null);
  workspace.remove('pipeline-package-token', '', hash(token));
  assert.equal(pipeline.pipelinePackageIdentity(token), null);
});

test('internal upload capability preserves loopback/path/method/expiry and single-use scope', () => {
  const scope = {
    owner: 'owner',
    application: 'matrix-app',
    taskId: 'task',
    deploymentRecordId: 'deployment',
  };
  const capability = uploads.issueAgentUpload(scope);
  const req = {
    headers: { 'x-deploy-internal-upload': capability.token },
    socket: { remoteAddress: '127.0.0.1' },
    url: '/api/upload',
    method: 'POST',
  } as unknown as IncomingMessage;
  for (const change of [
    { url: '/api/other' },
    { method: 'GET' },
    { socket: { remoteAddress: '192.0.2.1' } },
    { headers: { 'x-deploy-internal-upload': 'malformed' } },
  ]) {
    assert.throws(
      () => uploads.consumeAgentUpload({ ...req, ...change } as unknown as IncomingMessage),
      {
        message: 'Invalid internal upload capability',
        status: 403,
      },
    );
  }
  assert.deepEqual(uploads.consumeAgentUpload(req), scope);
  assert.throws(() => uploads.consumeAgentUpload(req), {
    message: 'Invalid internal upload capability',
    status: 403,
  });
  const expired = uploads.issueAgentUpload(scope);
  const saved = workspace.get('upload-capability', '', hash(expired.token));
  workspace.save('upload-capability', '', { ...saved, expires: 0 });
  assert.throws(
    () =>
      uploads.consumeAgentUpload({
        ...req,
        headers: { 'x-deploy-internal-upload': expired.token },
      } as unknown as IncomingMessage),
    { status: 403 },
  );
  expired.close();
});

test('telemetry token preserves format, application attribution and deletion revocation', () => {
  const token = telemetry.issueTelemetryToken(telemetryDb, 'matrix-app');
  assert.equal(telemetry.deploymentForToken(telemetryDb, token), 'matrix-app');
  assert.deepEqual(verifyTelemetry(telemetryDb, token), {
    kind: 'telemetry',
    application: 'matrix-app',
  });
  assert.equal(telemetry.deploymentForToken(telemetryDb, 'malformed'), null);
  assert.equal(telemetry.deploymentForToken(telemetryDb, 'a'.repeat(43)), null);
  telemetryDb.prepare('DELETE FROM telemetry_tokens').run();
  assert.equal(telemetry.deploymentForToken(telemetryDb, token), null);
  assert.equal(verifyTelemetry(telemetryDb, token), null);
});
