import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';

const root = mkdtempSync(join(tmpdir(), 'auth-matrix-'));
process.env.DEPLOY_DATA_DIR = root;
const users = await import('./store/users.ts');
const store = await import('./store.ts');
const grants = await import('./v2/auth-store.ts');
const devices = await import('./v2/devices.ts');
const workers = await import('./workspace/credentials.ts');
const workspace = await import('./workspace/store.ts');
const owner = 'matrix-owner';
const account = users.registerUser(owner, 'matrix-password');
const request = (headers: IncomingMessage['headers']) => ({ headers }) as IncomingMessage;
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('password and both session formats preserve malformed, owner, expiry and revocation decisions', () => {
  assert.ok(account.token);
  assert.equal(users.loginUser(owner, 'wrong').error, 'Invalid credentials');
  assert.equal(users.loginUser('missing', 'matrix-password').status, 401);
  const login = users.loginUser(owner, 'matrix-password');
  assert.ok(login.token);
  assert.match(login.token, /^[a-f0-9]{64}$/);
  const modern = grants.session(owner, 'Matrix');
  assert.match(modern.token, /^[A-Za-z0-9_-]{43}$/);
  for (const token of [login.token, modern.token]) {
    assert.equal(users.authenticate(owner, token), true);
    assert.equal(users.authenticate('another-owner', token), false);
    assert.equal(users.authenticate(owner, token + '!'), false);
    grants.authDb().prepare('UPDATE sessions SET expires_at=0 WHERE token=?').run(token);
    assert.equal(users.authenticate(owner, token), false);
    grants.authDb().prepare('UPDATE sessions SET expires_at=NULL WHERE token=?').run(token);
    assert.equal(users.authenticate(owner, token), true, 'pre-TTL rows remain accepted');
    users.logoutUser(owner, token);
    assert.equal(users.authenticate(owner, token), false);
  }
});

for (const kind of ['setup', 'register', 'passkey-login', 'cli', 'cli-approve', 'pair']) {
  test(`${kind} grant preserves kind, expiry and one-use boundaries`, () => {
    const rejected = (action: () => unknown) =>
      assert.throws(action, {
        message: 'This code expired or has already been used. Start again.',
        status: 410,
      });
    const token = grants.grant(kind, owner, { fixture: true }, 60000);
    assert.equal(grants.readGrant(kind, token).owner, owner);
    rejected(() => grants.readGrant(kind + '-wrong', token));
    rejected(() => grants.readGrant(kind, 'malformed'));
    grants.consume(kind, token);
    rejected(() => grants.readGrant(kind, token));
    const expired = grants.grant(kind, owner, {}, -1);
    rejected(() => grants.readGrant(kind, expired));
  });
}

test('device session revocation and request-token precedence remain owner scoped', () => {
  const device = devices.exchangeDevice(grants.grant('pair', owner, {}, 60000), 'Matrix device');
  assert.equal(devices.pairedDeviceActive(owner, device.id), true);
  assert.equal(devices.pairedDeviceActive('another-owner', device.id), false);
  assert.throws(() => devices.removeDevice('another-owner', device.id), {
    message: 'Device not found.',
    status: 404,
  });
  const cookie = 'deploy-sh-auth=' + encodeURIComponent(`${owner}:${device.token}`);
  assert.equal(devices.pairedDeviceForRequest(owner, request({ cookie })), device.id);
  assert.throws(
    () => devices.pairedDeviceForRequest(owner, request({ cookie, 'x-deploy-token': 'wrong' })),
    {
      message: 'This session was revoked. Sign in again.',
      status: 401,
    },
  );
  devices.removeDevice(owner, device.id);
  assert.equal(users.authenticate(owner, device.token), false);
  assert.equal(devices.pairedDeviceActive(owner, device.id), false);
});

test('worker hash verification, Basic precedence, owner binding and rotation are unchanged', () => {
  const first = workers.enrollWorker(owner, { workerId: 'matrix-worker' });
  const headers = {
    'x-deploy-worker-id': first.workerId,
    'x-deploy-worker-token': first.workerToken,
  };
  assert.deepEqual(workers.workerAuthentication(request(headers)), {
    owner,
    workerId: first.workerId,
  });
  assert.equal(
    workers.workerAuthentication(request({ ...headers, 'x-deploy-worker-id': 'wrong' })),
    null,
  );
  assert.equal(
    workers.workerAuthentication(request({ ...headers, 'x-deploy-worker-token': 'wrong' })),
    null,
  );
  const basic =
    'Basic ' + Buffer.from(`workspace-worker.${first.workerId}:wrong`).toString('base64');
  assert.equal(workers.workerAuthentication(request({ ...headers, authorization: basic })), null);
  workers.enrollWorker(owner, { workerId: first.workerId });
  assert.equal(workers.workerAuthentication(request(headers)), null);
  workspace.remove('worker-credential', owner, first.workerId);
  assert.equal(workers.workerAuthentication(request(headers)), null);
});
