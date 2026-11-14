import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import ssh2 from 'ssh2';

const root = mkdtempSync(join(tmpdir(), 'auth-remaining-'));
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
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sql = store.getSqlite()!;
users.registerUser('owner', 'password');
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('legacy password upgrades exactly once; malformed stored passwords and session owner/scope fail closed', () => {
  sql.prepare('UPDATE users SET password=? WHERE username=?').run(hash('legacy'), 'owner');
  sql.exec(`CREATE TABLE password_updates(n INTEGER); INSERT INTO password_updates VALUES(0);
    CREATE TRIGGER count_password_updates AFTER UPDATE OF password ON users BEGIN UPDATE password_updates SET n=n+1; END;`);
  const login = users.loginUser('owner', 'legacy');
  assert.ok(login.token);
  const stored = sql.prepare('SELECT password FROM users WHERE username=?').get('owner') as any;
  assert.match(stored.password, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.ok(users.loginUser('owner', 'legacy').token);
  assert.deepEqual(sql.prepare('SELECT n FROM password_updates').get(), { n: 1 });
  assert.deepEqual(users.loginUser('owner', 'wrong'), {
    error: 'Invalid credentials',
    status: 401,
  });
  assert.equal(users.authenticate('other', login.token), false);
  assert.equal(nodes.authenticateNode('owner', login.token), false);
  assert.equal(users.isAdmin('owner'), true);
  assert.equal(users.isAdmin('missing'), false);
  sql.prepare('UPDATE users SET password=? WHERE username=?').run('scrypt:broken:bad', 'owner');
  assert.deepEqual(users.loginUser('owner', 'legacy'), {
    error: 'Invalid credentials',
    status: 401,
  });
});

test('enrollment role validation precedes lookup; used enrollment and disabled roles retain decisions', () => {
  assert.throws(() => nodes.redeemNodeEnrollment({ code: 'bad', roles: { invalid: true } as any }));
  const enrollment = nodes.createNodeEnrollment('ordered-node', 'owner');
  const node = nodes.redeemNodeEnrollment({ code: enrollment.code, roles: { deploy: false } });
  assert.ok(node.secret && node.nodeId);
  assert.equal(nodes.authenticateNode(node.nodeId, node.secret), true);
  assert.equal(nodes.deployRoleEnabled(node.nodeId), false);
  assert.equal(nodes.authenticateNode(node.nodeId, 'wrong'), false);
  assert.equal(users.authenticate('owner', node.secret), false);
  assert.deepEqual(nodes.redeemNodeEnrollment({ code: enrollment.code, name: 'wrong' }), {
    error: 'Enrollment code is invalid or expired',
  });
});

test('expired run credential still reads a missing run before refusing; task scope comes from credential', () => {
  const scope = { owner: 'owner', taskId: 'bound-task', runId: 'missing-run' };
  const token = runs.issueAgentToken(scope);
  const credential = workspace.get('agent-credential', scope.owner, hash(token));
  workspace.save('agent-credential', scope.owner, { ...credential, expiresAt: 0 });
  assert.throws(() => runs.authenticateAgent(token), { message: 'Not found', status: 404 });
  workspace.save('run', 'other', { id: scope.runId, status: 'running' });
  assert.throws(() => runs.authenticateAgent(token), { status: 404 });
  workspace.save('run', scope.owner, { id: scope.runId, status: 'running' });
  assert.equal(runs.authenticateAgent(token), null);
  workspace.save('agent-credential', scope.owner, credential);
  assert.deepEqual(runs.authenticateAgent(token), scope);
  assert.equal(runs.authenticateAgent('malformed'), null);
});

test('CI scope and ownership refusals remain distinct from credential checks', () => {
  sql.prepare('INSERT INTO deployments(name,username) VALUES(?,?)').run('remaining-app', 'owner');
  const credential = ci.issueOwnedCiCredential('owner', 'remaining-app', 60);
  const identity = ci.authenticateCi(credential.token);
  assert.equal(identity.id, credential.id);
  assert.throws(() => ci.ciRelease('missing', identity), {
    message: 'Release not found',
    status: 404,
  });
  assert.throws(() => ci.authenticateCi('ci_' + 'g'.repeat(64)), {
    message: 'Unauthorized',
    status: 401,
  });
  sql.prepare('UPDATE deployments SET username=? WHERE name=?').run('other', 'remaining-app');
  assert.throws(() => ci.authenticateCi(credential.token), {
    message: 'Unauthorized',
    status: 401,
  });
});

test('package publish owner/admin policy and pipeline fallback retain precedence', () => {
  users.registerUser('member', 'password');
  const key = keys.createKey('member', 'Publish', 'publish');
  const req = { headers: { authorization: 'Bearer ' + key.key } } as IncomingMessage;
  const identity = keys.registryIdentity(req)!;
  assert.throws(() => keys.canPublish(identity, 'other'), {
    message: 'Only the publisher or an admin can publish this package.',
    status: 403,
  });
  assert.equal(keys.canPublish(identity, 'member'), undefined);
  // An expired pipeline row does not shadow a personal key with the same digest.
  workspace.save('pipeline-package-token', '', { id: hash(key.key), expiresAt: 0 });
  assert.deepEqual(keys.registryIdentity(req), identity);
  assert.equal(pipeline.pipelinePackageIdentity(key.key), null);
  assert.equal(
    keys.registryIdentity({
      headers: { ...req.headers, 'x-deploy-agent-token': 'present' },
    } as any),
    null,
  );
});

test('SSH lookup is global, deletion is owner scoped and deleted keys no longer identify a person', () => {
  const pair = ssh2.utils.generateKeyPairSync('ed25519');
  const key = ssh.addSshKey('owner', { publicKey: pair.public });
  assert.equal(ssh.findSshKey(key.fingerprint)?.owner, 'owner');
  assert.equal(ssh.findSshKey('malformed'), null);
  assert.throws(() => ssh.deleteSshKey('other', key.id), { message: 'Not found', status: 404 });
  assert.throws(() => ssh.addSshKey('other', { publicKey: pair.public }), { status: 409 });
  ssh.deleteSshKey('owner', key.id);
  assert.equal(ssh.findSshKey(key.fingerprint), null);
});

test('upload transport refusal does not consume the capability; explicit revocation refuses', () => {
  const scope = { owner: 'owner', application: 'remaining-app', deploymentRecordId: 'deployment' };
  const capability = uploads.issueAgentUpload(scope);
  const req = {
    headers: { 'x-deploy-internal-upload': capability.token },
    socket: { remoteAddress: '127.0.0.1' },
    url: '/api/upload',
    method: 'POST',
  } as unknown as IncomingMessage;
  assert.throws(() => uploads.consumeAgentUpload({ ...req, method: 'GET' } as IncomingMessage), {
    message: 'Invalid internal upload capability',
    status: 403,
  });
  assert.deepEqual(uploads.consumeAgentUpload(req), scope);
  const revoked = uploads.issueAgentUpload(scope);
  revoked.close();
  assert.throws(
    () =>
      uploads.consumeAgentUpload({
        ...req,
        headers: { 'x-deploy-internal-upload': revoked.token },
      } as any),
    { message: 'Invalid internal upload capability', status: 403 },
  );
  assert.equal(uploads.consumeAgentUpload({ headers: {} } as IncomingMessage), undefined);
});
