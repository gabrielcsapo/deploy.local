import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import ssh2 from 'ssh2';
const auth = await import('./kernel/auth/index.ts');

// No feature import has registered a reader yet. Importing the kernel opens nothing.
await test('each unregistered credential source refuses, without trying another credential kind', () => {
  assert.throws(
    () => auth.verifyPersonPassword('owner', 'password'),
    /Person credentials are not configured/,
  );
  assert.throws(
    () => auth.verifyPersonSession('owner', 'token'),
    /Person credentials are not configured/,
  );
  assert.throws(() => auth.verifyNode('node', 'secret'), /Node credentials are not configured/);
  assert.throws(
    () => auth.verifyNodeEnrollment('JOIN-missing'),
    /Node credentials are not configured/,
  );
  assert.throws(() => auth.verifyCi('ci_' + 'a'.repeat(64)), /Auth database is not configured/);
  assert.throws(
    () => auth.verifyPackageKey('dlp_' + 'a'.repeat(43)),
    /Auth database is not configured/,
  );
  assert.throws(
    () => auth.verifyComputerPackageKey('dlp_' + 'a'.repeat(43)),
    /Auth database is not configured/,
  );
  assert.throws(() => auth.readRunCredential('token'), /Database not registered: workspace/);
  assert.throws(
    () => auth.readPipelinePackageCredential('token'),
    /Database not registered: workspace/,
  );
  assert.throws(() => auth.findSshKey('fingerprint'), /Database not registered: workspace/);
  assert.throws(
    () =>
      auth.verifyAgentUpload({
        headers: { 'x-deploy-internal-upload': 'token' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as IncomingMessage),
    /Database not registered: workspace/,
  );
});

const root = mkdtempSync(join(tmpdir(), 'auth-kernel-remaining-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const users = await import('./store/users.ts');
const nodes = await import('./store/nodes.ts');
const workspace = await import('./workspace/store.ts');
const runs = await import('./workspace/coordination.ts');
const ci = await import('./ci-releases.ts');
const keys = await import('./packages/keys.ts');
const pipeline = await import('./packages/pipeline-auth.ts');
const ssh = await import('./workspace/ssh-keys.ts');
const uploads = await import('./agent-upload.ts');
// Keep digests in the test store, never in output.
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

const account = users.registerUser('owner', 'password');
const sql = store.getSqlite()!;
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('compatibility exports are the same kernel function instances', async () => {
  for (const [oldPath, newPath, names] of [
    [
      './store/users.ts',
      './kernel/auth/person.ts',
      ['authenticate', 'verifyPersonPassword', 'verifyPersonSession'],
    ],
    [
      './store/nodes.ts',
      './kernel/auth/nodes.ts',
      ['authenticateNode', 'verifyNode', 'verifyNodeEnrollment'],
    ],
    [
      './workspace/coordination.ts',
      './kernel/auth/run.ts',
      ['readRunCredential', 'verifyRunCredential'],
    ],
    ['./ci-releases.ts', './kernel/auth/ci.ts', ['verifyCi']],
    [
      './packages/keys.ts',
      './kernel/auth/packages.ts',
      ['verifyPackageKey', 'verifyComputerPackageKey'],
    ],
    [
      './packages/pipeline-auth.ts',
      './kernel/auth/packages.ts',
      ['readPipelinePackageCredential', 'verifyPipelinePackageCredential'],
    ],
    [
      './workspace/ssh-keys.ts',
      './kernel/auth/ssh.ts',
      ['findSshKey', 'sshFingerprint', 'verifySshSignature'],
    ],
    [
      './agent-upload.ts',
      './kernel/auth/upload.ts',
      ['issueAgentUpload', 'consumeAgentUpload', 'verifyAgentUpload'],
    ],
  ] as const) {
    const previous = await import(oldPath),
      current = await import(newPath);
    for (const name of names) assert.equal(previous[name], current[name], `${oldPath}: ${name}`);
  }
});

test('password and session verifiers yield person principals with unchanged refusal boundaries', () => {
  assert.deepEqual(auth.verifyPersonPassword('owner', 'password'), {
    kind: 'person',
    username: 'owner',
  });
  assert.equal(auth.verifyPersonPassword('other', 'password'), null);
  assert.equal(auth.verifyPersonPassword('owner', 'wrong'), null);
  assert.deepEqual(auth.verifyPersonSession('owner', account.token), {
    kind: 'person',
    username: 'owner',
  });
  assert.equal(auth.verifyPersonSession('other', account.token), null);
  assert.equal(auth.verifyPersonSession('owner', 'malformed'), null);
  sql.prepare('UPDATE sessions SET expires_at=0 WHERE token=?').run(account.token!);
  assert.equal(auth.verifyPersonSession('owner', account.token), null);
  sql.prepare('UPDATE sessions SET expires_at=NULL WHERE token=?').run(account.token!);
  assert.ok(auth.verifyPersonSession('owner', account.token));
  users.logoutUser('owner', account.token!);
  assert.equal(auth.verifyPersonSession('owner', account.token), null);
});

test('node enrollment and node verifiers yield their own principals, independent of deploy role', () => {
  const enrollment = nodes.createNodeEnrollment('principal-node', 'owner');
  assert.deepEqual(auth.verifyNodeEnrollment(enrollment.code), {
    kind: 'node-enrollment',
    enrollmentId: enrollment.id,
    name: enrollment.name,
    createdBy: 'owner',
  });
  assert.equal(auth.verifyNodeEnrollment('malformed'), null);
  sql.prepare('UPDATE node_enrollments SET expires_at=0 WHERE id=?').run(enrollment.id);
  assert.equal(auth.verifyNodeEnrollment(enrollment.code), null);
  sql
    .prepare('UPDATE node_enrollments SET expires_at=? WHERE id=?')
    .run(enrollment.expiresAt, enrollment.id);
  const node = nodes.redeemNodeEnrollment({ code: enrollment.code, roles: { deploy: false } });
  assert.deepEqual(auth.verifyNode(node.nodeId, node.secret), {
    kind: 'node',
    nodeId: node.nodeId,
  });
  assert.equal(auth.verifyNodeEnrollment(enrollment.code), null);
  assert.equal(auth.verifyNode('wrong', node.secret), null);
  assert.equal(auth.verifyNode(node.nodeId, 'malformed'), null);
  nodes.revokeNode(node.nodeId!);
  assert.equal(auth.verifyNode(node.nodeId, node.secret), null);
});

test('run verification yields only credential scope; live-run refusal remains in the adapter', () => {
  const scope = { owner: 'owner', taskId: 'task', runId: 'run' };
  workspace.save('run', 'owner', { id: 'run', status: 'running' });
  const token = runs.issueAgentToken(scope),
    record = auth.readRunCredential(token)!;
  assert.deepEqual(auth.verifyRunCredential(record), { kind: 'run', ...scope });
  assert.deepEqual(runs.authenticateAgent(token), scope);
  assert.equal(auth.readRunCredential('malformed'), null);
  assert.equal(auth.readRunCredential('a'.repeat(201)), null);
  assert.equal(
    auth.verifyRunCredential({ ...record, credential: { ...record.credential, expiresAt: 0 } }),
    null,
  );
  workspace.save('run', 'owner', { id: 'run', status: 'succeeded' });
  assert.equal(runs.authenticateAgent(token), null);
  workspace.remove('agent-credential', 'owner', digest(token));
  assert.equal(auth.readRunCredential(token), null);
});

test('CI verifier yields its bound application; current ownership is still adapter policy', () => {
  sql.prepare('INSERT INTO deployments(name,username) VALUES(?,?)').run('principal-app', 'owner');
  const credential = ci.issueOwnedCiCredential('owner', 'principal-app', 60);
  assert.deepEqual(auth.verifyCi(credential.token), {
    kind: 'ci',
    username: 'owner',
    application: 'principal-app',
    credentialId: credential.id,
    expiresAt: credential.expiresAt,
  });
  sql.prepare('UPDATE deployments SET username=? WHERE name=?').run('other', 'principal-app');
  assert.ok(auth.verifyCi(credential.token));
  assert.throws(() => ci.authenticateCi(credential.token), {
    message: 'Unauthorized',
    status: 401,
  });
  sql.prepare('UPDATE ci_credentials SET expires_at=0 WHERE id=?').run(credential.id);
  assert.throws(() => auth.verifyCi(credential.token), { message: 'Unauthorized', status: 401 });
  sql
    .prepare('UPDATE ci_credentials SET expires_at=? WHERE id=?')
    .run(credential.expiresAt, credential.id);
  ci.revokeCiCredential(credential.id, 'owner');
  assert.throws(() => auth.verifyCi(credential.token), { message: 'Unauthorized', status: 401 });
  assert.throws(() => auth.verifyCi('malformed'), { message: 'Unauthorized', status: 401 });
});

test('package verifiers yield key, computer and pipeline principals; publish policy stays outside', () => {
  const personal = keys.createKey('owner', 'Install', 'install');
  const identity = auth.verifyPackageKey(personal.key)!;
  assert.equal(identity.kind, 'package-key');
  assert.equal(identity.username, 'owner');
  assert.equal(identity.scope, 'install');
  assert.equal(identity.credential, 'package-key:' + personal.id);
  assert.equal(auth.verifyComputerPackageKey(personal.key), null);
  assert.equal(auth.verifyPackageKey('malformed'), null);
  sql.prepare('DELETE FROM package_keys WHERE id=?').run(personal.id);
  assert.equal(auth.verifyPackageKey(personal.key), null);
  const computer = keys.computerPackageKey('owner', 'computer');
  assert.deepEqual(auth.verifyComputerPackageKey(computer), {
    kind: 'package-computer',
    username: 'owner',
    computerId: 'computer',
    lastUsedAt: null,
  });
  keys.revokeComputerPackageKey('owner', 'computer');
  assert.equal(auth.verifyComputerPackageKey(computer), null);
  const job = {
    id: 'job',
    pipelineId: 'pipeline',
    generation: 1,
    packagePublish: true,
    status: 'running',
  };
  workspace.save('project', 'owner', { id: 'project', owner: 'owner' });
  workspace.save('pipeline-run', 'owner', {
    id: 'pipeline',
    projectId: 'project',
    status: 'succeeded',
    commit: 'commit',
    packages: {
      status: 'running',
      items: [{ jobId: 'job', name: 'package', version: '1.0.0', status: 'running' }],
    },
  });
  workspace.save('job', 'owner', job);
  const token = pipeline.issuePipelinePackageToken('owner', job);
  const scope = auth.readPipelinePackageCredential(token)!;
  assert.deepEqual(auth.verifyPipelinePackageCredential(scope), {
    kind: 'package-pipeline',
    owner: 'owner',
    projectId: 'project',
    pipelineId: 'pipeline',
    jobId: 'job',
    name: 'package',
    version: '1.0.0',
    commit: 'commit',
  });
  assert.equal(auth.verifyPipelinePackageCredential({ ...scope, expiresAt: 0 }), null);
  workspace.save('project', 'owner', { id: 'project', owner: 'other' });
  assert.equal(pipeline.pipelinePackageIdentity(token), null);
  workspace.remove('pipeline-package-token', '', digest(token));
  assert.equal(auth.readPipelinePackageCredential(token), null);
});

test('SSH signed keys yield a principal; missing or incorrect signatures never do', () => {
  const pair = ssh2.utils.generateKeyPairSync('ed25519');
  const saved = ssh.addSshKey('owner', { publicKey: pair.public });
  const key = ssh2.utils.parseKey(pair.private);
  assert.ok(!(key instanceof Error) && !Array.isArray(key));
  const found = auth.findSshKey(saved.fingerprint)!;
  const blob = Buffer.from('ssh authentication challenge');
  const signature = key.sign(blob);
  assert.ok(Buffer.isBuffer(signature));
  assert.deepEqual(auth.verifySshSignature(found, key, blob, signature), {
    kind: 'ssh',
    owner: 'owner',
    keyId: saved.id,
  });
  assert.equal(auth.verifySshSignature(found, key, undefined, signature), null);
  assert.equal(auth.verifySshSignature(found, key, Buffer.from('other'), signature), null);
  assert.equal(auth.verifySshSignature(found, key, blob, Buffer.alloc(signature.length)), null);
  ssh.deleteSshKey('owner', saved.id);
  assert.equal(auth.findSshKey(saved.fingerprint), null);
});

test('upload verifier yields a scoped principal and consumes exactly once', () => {
  const scope = {
    owner: 'owner',
    application: 'principal-app',
    deploymentRecordId: 'deployment',
    taskId: 'task',
  };
  const capability = uploads.issueAgentUpload(scope);
  const req = {
    headers: { 'x-deploy-internal-upload': capability.token },
    socket: { remoteAddress: '127.0.0.1' },
    url: '/api/upload',
    method: 'POST',
  } as unknown as IncomingMessage;
  const principal = auth.verifyAgentUpload(req)!;
  assert.equal(principal.kind, 'upload');
  assert.equal(principal.owner, scope.owner);
  assert.deepEqual(principal.scope, scope);
  assert.throws(() => auth.verifyAgentUpload(req), {
    message: 'Invalid internal upload capability',
    status: 403,
  });
});
