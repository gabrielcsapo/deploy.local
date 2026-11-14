import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
const root = mkdtempSync(join(tmpdir(), 'kernel-auth-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('./store.ts');
const workspace = await import('./workspace/store.ts');
const old = await import('./v2/auth-store.ts');
const current = await import('./kernel/auth/grants.ts');
const auth = await import('./kernel/auth/index.ts');
const request = (headers: IncomingMessage['headers']) => ({ headers }) as IncomingMessage;
after(() => {
  workspace.db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

test('auth folder is present in the recursive kernel boundary scan; compatibility exports share instances', async () => {
  assert.ok(readdirSync(new URL('./kernel/auth', import.meta.url)).includes('index.ts'));
  const moves = [
    ['./telemetry.ts', './kernel/auth/telemetry.ts'],
    ['./auth-cookie.ts', './kernel/auth/cookie.ts'],
    ['./v2/auth-store.ts', './kernel/auth/grants.ts'],
    ['./workspace/credentials.ts', './kernel/auth/worker.ts'],
    ['./v2/devices.ts', './kernel/auth/devices.ts'],
  ];
  for (const [before, newPath] of moves) {
    const previous = await import(before);
    const next = await import(newPath);
    for (const name of Object.keys(next)) {
      if (name === 'revokeDeviceSession') continue;
      assert.equal(previous[name], next[name], `${before}: ${name}`);
    }
  }
  assert.equal(old.authDb(), current.authDb());
  store._resetDb();
  assert.equal(old.authDb(), current.authDb(), 'both paths reopen the same connection');
});

test('typed entry points preserve verifier results and do not broaden scope', async () => {
  store.registerUser('owner', 'password');
  const token = old.grant('pair', 'owner', {}, 60000);
  assert.deepEqual(auth.verifyGrant('pair', token), {
    kind: 'grant',
    grantKind: 'pair',
    owner: 'owner',
  });
  assert.throws(() => auth.verifyGrant('cli', token), { status: 410 });
  old.consume('pair', token);
  assert.throws(() => auth.verifyGrant('pair', token), { status: 410 });
  const { enrollWorker } = await import('./workspace/credentials.ts');
  const worker = enrollWorker('owner', { workerId: 'worker' });
  const req = request({
    'x-deploy-worker-id': worker.workerId,
    'x-deploy-worker-token': worker.workerToken,
  });
  assert.deepEqual(auth.verifyWorker(req), { kind: 'worker', owner: 'owner', workerId: 'worker' });
  workspace.remove('worker-credential', 'owner', 'worker');
  assert.equal(auth.verifyWorker(req), null);
  const { exchangeDevice } = await import('./v2/devices.ts');
  const device = exchangeDevice(old.grant('pair', 'owner', {}, 60000), 'Device');
  const deviceReq = request({ 'x-deploy-token': device.token });
  assert.deepEqual(auth.verifyPairedDevice('owner', deviceReq), {
    kind: 'device',
    owner: 'owner',
    deviceId: device.id,
  });
  assert.throws(() => auth.verifyPairedDevice('other', deviceReq), { status: 401 });
  auth.revokeDeviceSession('owner', device.id);
  assert.throws(() => auth.verifyPairedDevice('owner', deviceReq), { status: 401 });
});
