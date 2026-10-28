import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { registrationVector } from './auth-vectors.ts';
import { returnPath } from '../../app/routes/v2-public/return-path.ts';
const { browserLogin } = await import(new URL('../../bin/cli-v2.mjs', import.meta.url).href);
const root = mkdtempSync(join(tmpdir(), 'deploy-signin-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_PUBLIC_ORIGIN = 'https://dev.dontneeda.pw';
const { authDb, grant, digest, session } = await import('./auth-store.ts');
const { issueSetupCode, setupAccount, appsAtHome } = await import('./setup.ts');
const { registrationOptions, registrationVerify, loginOptions, loginVerify } =
  await import('./auth-passkey.ts');
const { pairDevice, exchangeDevice, removeDevice, devices } = await import('./devices.ts');
const { cliLoginStart, cliPoll, cliApprove } = await import('./auth-cli.ts');
const { authApi } = await import('./auth.ts');
const { authenticate, _resetDb } = await import('../store.ts');
const { db: workspaceDb } = await import('../workspace/store.ts');
const db = authDb();
after(() => {
  _resetDb();
  workspaceDb.close();
  rmSync(root, { recursive: true, force: true });
});

test('setup code expires, is single use, and is refused after ownership exists', () => {
  const first = issueSetupCode();
  db.prepare('UPDATE v2_auth_grants SET expires=0 WHERE hash=?').run(digest(first.code));
  assert.throws(
    () => setupAccount({ code: first.code, username: 'gabriel', password: 'long-password-123' }),
    /expired/,
  );
  const next = issueSetupCode();
  assert.throws(
    () => setupAccount({ code: next.code, username: 'bad:name', password: 'long-password-123' }),
    /username/,
  );
  assert.throws(
    () => setupAccount({ code: next.code, username: 'gabriel', password: 'short' }),
    /12 characters/,
  );
  const result = setupAccount({
    code: next.code,
    username: 'gabriel',
    password: 'long-password-123',
    name: 'Gabriel',
  });
  assert.equal(authenticate(result.username, result.token), true);
  assert.equal(
    (db.prepare("SELECT role FROM users WHERE username='gabriel'").get() as { role: string }).role,
    'admin',
  );
  assert.throws(
    () => setupAccount({ code: next.code, username: 'other', password: 'long-password-123' }),
    /already exists/,
  );
  assert.throws(issueSetupCode, /already exists/);
  assert.equal(
    (
      db.prepare("SELECT count(*) AS n FROM v2_auth_grants WHERE kind='setup'").get() as {
        n: number;
      }
    ).n,
    0,
  );
});

test('WebAuthn options require verification and register an upstream library vector once', async () => {
  const generated = await registrationOptions('gabriel');
  assert.equal(generated.options.rp.id, 'dev.dontneeda.pw');
  assert.equal(generated.options.authenticatorSelection?.userVerification, 'required');
  assert.equal(generated.options.authenticatorSelection?.residentKey, 'required');
  const client = JSON.parse(
    Buffer.from(registrationVector.response.clientDataJSON, 'base64url').toString(),
  );
  const challengeId = grant(
    'register',
    'gabriel',
    { challenge: client.challenge, origin: client.origin, rpID: 'dev.dontneeda.pw' },
    60_000,
  );
  assert.deepEqual(await registrationVerify('gabriel', challengeId, registrationVector), {
    verified: true,
  });
  await assert.rejects(registrationVerify('gabriel', challengeId, registrationVector), /expired/);
  const wrong = grant(
    'register',
    'gabriel',
    { challenge: 'wrong', origin: client.origin, rpID: 'dev.dontneeda.pw' },
    60_000,
  );
  await assert.rejects(registrationVerify('gabriel', wrong, registrationVector), /challenge/);
  const foreign = grant(
    'register',
    'gabriel',
    { challenge: client.challenge, origin: client.origin, rpID: 'dev.dontneeda.pw' },
    60_000,
  );
  await assert.rejects(
    registrationVerify('someone-else', foreign, registrationVector),
    /another account/,
  );
});

test('WebAuthn verifies a real signature, RP, origin, user verification, counter and replay', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const cose = Buffer.concat([
    Buffer.from([0xa5, 1, 2, 3, 0x26, 0x20, 1, 0x21, 0x58, 0x20]),
    Buffer.from(jwk.x!, 'base64url'),
    Buffer.from([0x22, 0x58, 0x20]),
    Buffer.from(jwk.y!, 'base64url'),
  ]);
  const id = Buffer.from(randomUUID()).toString('base64url');
  db.prepare('INSERT INTO v2_passkeys VALUES(?,?,?,?,?,?)').run(
    id,
    'gabriel',
    cose.toString('base64url'),
    0,
    '[]',
    new Date().toISOString(),
  );
  async function assertion(
    origin = 'https://dev.dontneeda.pw',
    flags = 5,
    rp = 'dev.dontneeda.pw',
    counter = 1,
  ) {
    const options = await loginOptions();
    assert.equal(options.options.userVerification, 'required');
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.options.challenge, origin }),
    );
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(rp).digest(),
      Buffer.from([flags]),
      count,
    ]);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
      keys.privateKey,
    );
    return {
      challengeId: options.challengeId,
      response: {
        id,
        rawId: id,
        type: 'public-key' as const,
        clientExtensionResults: {},
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url'),
        },
      },
    };
  }
  for (const bad of [
    await assertion('https://evil.example'),
    await assertion(undefined, 1),
    await assertion(undefined, 5, 'evil.example'),
  ])
    await assert.rejects(loginVerify(bad.challengeId, bad.response));
  const good = await assertion();
  const result = await loginVerify(good.challengeId, good.response);
  assert.equal(authenticate(result.username, result.token), true);
  await assert.rejects(loginVerify(good.challengeId, good.response), /expired/);
  const clone = await assertion();
  await assert.rejects(loginVerify(clone.challengeId, clone.response), /counter/i);
});

test('pairing pins the certificate, exchanges once, isolates owners and revokes the device session', () => {
  mkdirSync(join(root, 'certs'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(root, 'certs/ca.key'),
      '-out',
      join(root, 'certs/ca.crt'),
      '-days',
      '1',
      '-subj',
      '/CN=Test SER',
    ],
    { stdio: 'ignore' },
  );
  const pair = pairDevice('gabriel');
  assert.match(pair.fingerprint, /^[A-F0-9:]+$/);
  assert.equal(pair.address, 'https://dev.dontneeda.pw');
  assert.ok(pair.expiresAt <= Date.now() + 300_000);
  const device = exchangeDevice(pair.token, 'iPhone');
  assert.equal(authenticate(device.username, device.token), true);
  assert.throws(() => exchangeDevice(pair.token, 'second phone'), /expired/);
  assert.throws(() => removeDevice('someone-else', device.id), /not found/);
  assert.equal(devices('gabriel').length, 1);
  removeDevice('gabriel', device.id);
  assert.equal(authenticate(device.username, device.token), false);
  assert.equal(devices('gabriel').length, 0);
  const expired = pairDevice('gabriel');
  db.prepare('UPDATE v2_auth_grants SET expires=0 WHERE hash=?').run(digest(expired.token));
  assert.throws(() => exchangeDevice(expired.token, 'iPhone'), /expired/);
});

test('CLI approval and denial are single use and polling cannot mint a token early', () => {
  const start = cliLoginStart();
  assert.deepEqual(cliPoll(start.deviceCode), { state: 'pending' });
  assert.throws(() => cliPoll(start.userCode), /expired/);
  cliApprove('gabriel', start.userCode, true);
  assert.throws(() => cliApprove('gabriel', start.userCode, true), /expired/);
  const result = cliPoll(start.deviceCode);
  assert.equal(result.state, 'approved');
  assert.equal(authenticate(result.username, result.token), true);
  assert.throws(() => cliPoll(start.deviceCode), /expired/);
  const denied = cliLoginStart();
  cliApprove('gabriel', denied.userCode, false);
  assert.deepEqual(cliPoll(denied.deviceCode), { state: 'denied' });
  const expired = cliLoginStart();
  db.prepare('UPDATE v2_auth_grants SET expires=0 WHERE hash=?').run(digest(expired.deviceCode));
  assert.throws(() => cliPoll(expired.deviceCode), /expired/);
});

test('browser CLI opens the matching URL, polls, persists only approval, and times out', async () => {
  let saved: any;
  let count = 0;
  let time = 0;
  let opened = '';
  const base = {
    serverUrl: 'https://deploy.local',
    openBrowser: async (url: string) => {
      opened = url;
    },
    save: async (value: any) => {
      saved = value;
    },
    print: () => {},
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
  const start = {
    verificationUri: 'https://deploy.local/signin?cli=ABC',
    userCode: 'ABC',
    deviceCode: 'secret',
    interval: 1,
    expiresIn: 5,
  };
  await browserLogin({
    ...base,
    request: async (url: string) =>
      url.endsWith('/start')
        ? start
        : ++count === 1
          ? { state: 'pending' }
          : { state: 'approved', username: 'gabriel', token: 'token' },
  });
  assert.equal(opened, start.verificationUri);
  assert.equal(saved.token, 'token');
  assert.equal(count, 2);
  saved = undefined;
  await assert.rejects(
    browserLogin({
      ...base,
      request: async (url: string) => (url.endsWith('/start') ? start : { state: 'pending' }),
    }),
    /expired/,
  );
  assert.equal(saved, undefined);
  await assert.rejects(
    browserLogin({
      ...base,
      request: async () => ({ ...start, verificationUri: 'https://evil.example' }),
    }),
    /does not match/,
  );
});

test('Apps at home includes only explicitly discoverable apps', () => {
  for (const [name, visibility] of [
    ['shared', 1],
    ['private', 0],
    ['legacy', null],
  ] as const)
    db.prepare('INSERT INTO deployments(name,username,discoverable) VALUES(?,?,?)').run(
      name,
      'gabriel',
      visibility,
    );
  assert.deepEqual(
    appsAtHome().map((app) => app.name),
    ['shared'],
  );
});

test('session-expired destination keeps task, query and fragment; rejects offsite returns', () => {
  assert.equal(
    returnPath('/dashboard/tasks/abc?tab=checks#last'),
    '/dashboard/tasks/abc?tab=checks#last',
  );
  for (const value of [
    '//evil.test',
    'https://evil.test',
    '/dashboard\\evil',
    '/dashboard-other',
    '/dashboard/../../signin',
    '\n/dashboard',
  ])
    assert.equal(returnPath(value), '/dashboard');
});

test('HTTP routing leaves options public, protects registration/pairing, and rejects cross-origin mutations', async () => {
  const server = createServer((req, res) => {
    void authApi(req, res, (req, res) => {
      const username = req.headers['x-deploy-username'] as string;
      if (authenticate(username, req.headers['x-deploy-token'] as string)) return { username };
      res.writeHead(401);
      res.end('{}');
      return null;
    }).catch((error) => {
      res.writeHead(error.status || 400);
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  let port = 5180;
  for (; port <= 5199; port++) {
    try {
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
      break;
    } catch (error: any) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(port <= 5199);
  try {
    const post = (path: string, body: any = {}, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api/v2${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    assert.equal((await post('/auth/passkey/login/options')).status, 200);
    assert.equal((await post('/auth/passkey/register/options')).status, 401);
    assert.equal((await post('/devices/pair')).status, 401);
    assert.equal((await post('/setup', {}, { Origin: 'https://evil.test' })).status, 403);
    const owner = session('gabriel', 'test');
    assert.equal(
      (
        await post(
          '/auth/passkey/register/options',
          {},
          { 'x-deploy-username': 'gabriel', 'x-deploy-token': owner.token },
        )
      ).status,
      200,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
