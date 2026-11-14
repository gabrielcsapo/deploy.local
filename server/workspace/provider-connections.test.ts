import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

const root = mkdtempSync(join(tmpdir(), 'deploy-provider-settings-'));
process.env.DEPLOY_DATA_DIR = root;
const { save, db } = await import('./store.ts');
const { providerConnections, saveProviderConnection, requestProviderLogin, updateProviderLogin } =
  await import('./provider-connections.ts');
const { managedWorkerLaunch, managedWorkerExec } = await import('./managed-worker.ts');
const { workspaceApi } = await import('./api.ts');
save('worker', 'alice', { id: 'ser-a', name: 'SER', heartbeat: new Date().toISOString() });
save('worker', 'alice', { id: 'ser-b', name: 'Other', heartbeat: new Date().toISOString() });
save('worker', 'alice', {
  id: 'old-mac',
  name: 'Old Mac',
  status: 'online',
  heartbeat: new Date().toISOString(),
  revokedAt: new Date().toISOString(),
});
const server = createServer(
  (req, res) =>
    void workspaceApi(
      req,
      res,
      req.headers['x-test-owner'] === 'bob' ? 'bob' : 'alice',
      req.headers['x-test-worker'] as string | undefined,
    ),
);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}/api`;
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});
const setting = {
  workerId: 'ser-a',
  provider: 'compatible',
  enabled: true,
  mode: 'api-key',
  baseUrl: 'https://inference.example/v1',
  model: 'test-model',
  billingMode: 'api',
  apiKey: 'private-test-key',
};

test('connections encrypt keys, retain blank keys, and never expose them in public responses or operation replay', async () => {
  const response = await fetch(origin + '/provider-connections', {
    method: 'POST',
    body: JSON.stringify({ ...setting, operationId: 'save-connection' }),
  });
  assert.equal(response.status, 200);
  assert.doesNotMatch(await response.text(), /private-test-key|apiKey|v1:/);
  const records = JSON.stringify(db.prepare('SELECT * FROM records').all());
  assert.doesNotMatch(records, /private-test-key/);
  assert.match(records, /secret/);
  assert.doesNotMatch(
    JSON.stringify(db.prepare('SELECT * FROM operations').all()),
    /private-test-key/,
  );
  assert.equal(
    providerConnections('alice', 'ser-a', true).find((c) => c.provider === 'compatible')?.apiKey,
    'private-test-key',
  );
  saveProviderConnection('alice', { ...setting, apiKey: '' });
  assert.equal(
    providerConnections('alice', 'ser-a', true).find((c) => c.provider === 'compatible')?.apiKey,
    'private-test-key',
  );
  saveProviderConnection('alice', { ...setting, apiKey: '', clearKey: true });
  assert.equal(
    providerConnections('alice', 'ser-a').find((c) => c.provider === 'compatible')?.hasKey,
    false,
  );
});
test('worker credentials cannot read another worker connection or client settings', async () => {
  for (const path of ['/provider-connections', '/workers/ser-b/provider-config']) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'x-test-worker': 'ser-a' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  }
  const own = await fetch(origin + '/workers/ser-a/provider-config', {
    method: 'POST',
    headers: { 'x-test-worker': 'ser-a' },
    body: '{}',
  });
  assert.equal(own.status, 200);
  const otherOwner = await fetch(origin + '/workers/ser-a/provider-config', {
    method: 'POST',
    headers: { 'x-test-owner': 'bob' },
    body: '{}',
  });
  assert.equal(otherOwner.status, 404);
});
test('connection validation rejects credential-bearing URLs, insecure remote endpoints, control bytes and foreign workers', () => {
  for (const baseUrl of [
    'http://inference.example/v1',
    'https://name:password@inference.example/v1',
    'https://inference.example/v1?key=secret',
  ])
    assert.throws(() => saveProviderConnection('alice', { ...setting, baseUrl }));
  assert.throws(() => saveProviderConnection('alice', { ...setting, apiKey: 'secret\nheader' }));
  assert.throws(() => saveProviderConnection('bob', setting), /Not found/);
  assert.doesNotThrow(() =>
    saveProviderConnection('alice', {
      ...setting,
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      billingMode: 'local',
    }),
  );
});
test('device sign-in reports accept only the provider verification URL, expire and remain owner scoped', () => {
  const login = requestProviderLogin('alice', 'ser-a');
  assert.equal(requestProviderLogin('alice', 'ser-a').requestId, login.requestId);
  const pending = updateProviderLogin('alice', 'ser-a', {
    requestId: login.requestId,
    status: 'pending',
    verificationUrl: 'https://phishing.example/',
    userCode: 'ABCD-EFGHI',
  });
  assert.equal(pending.verificationUrl, undefined);
  assert.throws(
    () => updateProviderLogin('bob', 'ser-a', { requestId: login.requestId, status: 'succeeded' }),
    /Not found/,
  );
  const complete = updateProviderLogin('alice', 'ser-a', {
    requestId: login.requestId,
    status: 'succeeded',
  });
  assert.equal(complete.userCode, undefined);
  save('provider-login', 'alice', { ...login, expiresAt: Date.now() - 1 });
  assert.throws(
    () =>
      updateProviderLogin('alice', 'ser-a', { requestId: login.requestId, status: 'succeeded' }),
    /expired/,
  );
});
test('managed launch drops root identity and inherits neither the database path nor control-plane/provider secrets', () => {
  process.env.OPENAI_API_KEY = 'must-not-be-inherited';
  const terminalSetting = process.env.DEPLOY_TERMINAL;
  process.env.DEPLOY_TERMINAL = '0';
  const identity = {
    username: 'operator',
    uid: 1000,
    gid: 1000,
    homedir: '/home/operator',
    shell: '/bin/bash',
  };
  const launch = managedWorkerLaunch(
    identity,
    'managed-test',
    'worker-only-token',
    'http://127.0.0.1:7843',
  );
  assert.equal(launch.uid, 1000);
  assert.equal(launch.gid, 1000);
  assert.equal((launch.env as any).OPENAI_API_KEY, undefined);
  assert.equal((launch.env as any).DEPLOY_DATA_DIR, undefined);
  assert.equal(launch.env.DEPLOY_WORKER_TOKEN, 'worker-only-token');
  assert.equal(launch.env.DEPLOY_BROWSER_CONTROL, '1');
  assert.equal(launch.env.SHELL, identity.shell);
  assert.equal(launch.env.DEPLOY_TERMINAL, '0');
  if (terminalSetting === undefined) delete process.env.DEPLOY_TERMINAL;
  else process.env.DEPLOY_TERMINAL = terminalSetting;
  assert.match(
    launch.env.CODEX_HOME,
    /^\/home\/operator\/.local\/share\/deploy.local\/task-workers\/managed-test\//,
  );
  assert.throws(
    () => managedWorkerLaunch({ ...identity, uid: 0 }, 'managed-test', '', origin),
    /ordinary/,
  );
  delete process.env.OPENAI_API_KEY;
});
test('runtime applies compatible and Claude settings to their own adapter only and keeps Codex configuration private', async () => {
  const binary = join(root, 'fake-codex');
  writeFileSync(
    binary,
    '#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on("end",()=>process.exit(0));',
    { mode: 0o700 },
  );
  const auth = join(root, 'existing-auth.json');
  writeFileSync(auth, '{"test":"account"}', { mode: 0o600 });
  process.env.DEPLOY_MANAGED_WORKER = '1';
  process.env.DEPLOY_CODEX_AUTH_SOURCE = auth;
  process.env.DEPLOY_CODEX_BIN = binary;
  const { applyProviderConnections, providerEnvironment } = await import('./provider-runtime.ts');
  const values = providerConnections('alice', 'ser-a', true);
  const claude = values.find((c) => c.provider === 'claude')!;
  Object.assign(claude, {
    enabled: true,
    mode: 'api-key',
    apiKey: 'claude-only-key',
    revision: 'test',
  });
  await applyProviderConnections(values, root);
  assert.equal(readFileSync(join(root, 'providers/codex/auth.json'), 'utf8'), '{"test":"account"}');
  assert.equal(statSync(join(root, 'providers/codex/auth.json')).mode & 0o777, 0o600);
  assert.equal(providerEnvironment('claude').ANTHROPIC_API_KEY, 'claude-only-key');
  assert.equal(providerEnvironment('compatible').DEPLOY_MODEL_NAME, 'test-model');
  assert.equal(providerEnvironment('compatible').ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(providerEnvironment('codex'), {});
});

test('revoked computers are not listed with provider connections', async () => {
  const response = await fetch(origin + '/provider-connections');
  const ids = ((await response.json()) as any).workers.map((worker: any) => worker.id);
  assert.ok(ids.includes('ser-a'));
  assert.ok(!ids.includes('old-mac'));
});
test('a managed worker keeps only the docker group, and only if its account has it', () => {
  const identity = {
    username: 'operator',
    uid: 1000,
    gid: 1000,
    homedir: '/home/operator',
    shell: '/bin/sh',
  } as any;
  const system = (group: string, overrides = {}) => ({
    isRoot: () => true,
    dockerGroup: () => group,
    setpriv: () => Buffer.from(''),
    ...overrides,
  });
  const kept = managedWorkerExec(identity, '/w.js', system('docker:x:973:someone,operator\n'));
  assert.equal(kept.command, 'setpriv');
  assert.equal(kept.keepIdentity, false);
  assert.deepEqual(kept.args, [
    '--reuid',
    '1000',
    '--regid',
    '1000',
    '--groups',
    '973',
    process.execPath,
    '/w.js',
  ]);
  for (const plain of [
    system('docker:x:973:someone\n'),
    system('docker:x:973:\n'),
    system('docker:x:973:operator\n', { isRoot: () => false }),
    system('', {
      dockerGroup: () => {
        throw new Error('no docker group');
      },
    }),
    system('docker:x:973:operator\n', {
      setpriv: () => {
        throw new Error('no setpriv');
      },
    }),
  ]) {
    const result = managedWorkerExec(identity, '/w.js', plain as any);
    assert.equal(result.command, process.execPath);
    assert.equal(result.keepIdentity, true);
  }
});
