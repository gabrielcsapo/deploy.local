import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { routeFetch } from '../v2/test-request.ts';
import { controlRequestHeaders } from '../edge/control-forward.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'npm-login-test-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
await import('../test-backups.ts');
const { registerUser, _resetDb } = await import('../store.ts');
const { db: workspaceDb } = await import('../workspace/store.ts');
const { updatePreferences } = await import('../v2/auth-store.ts');
const { createNpmRegistry } = await import('./npm.ts');
const { listKeys } = await import('./keys.ts');
const { apiRoutes } = await import('../api/registry.ts');
const { startNpmLogin } = await import('./npm-login.ts');
const alice = registerUser('alice', 'long-test-password');
updatePreferences('alice', { name: 'Gabriel' });
const registry = createNpmRegistry();
const fetch = routeFetch(async (req, res) => {
  if (await registry.handle(req, res)) return;
  const url = new URL(req.url!, 'http://' + req.headers.host);
  await apiRoutes({
    req,
    res,
    url,
    path: url.pathname,
    workspacePath: url.pathname,
    method: req.method,
  });
});
const origin = 'http://127.0.0.1:4873';
const cookie = 'deploy-sh-auth=' + encodeURIComponent(`alice:${alice.token}`);
after(async () => {
  registry.copy.close();
  _resetDb();
  workspaceDb.close();
  await rm(root, { recursive: true, force: true });
});

/** A failed poll answers 200 without a token: a 4xx would send npm and pnpm to a username prompt. */
async function failedPoll(url: string) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.token, undefined);
  assert.match(body.error, /Run npm login again/);
}

async function start(agent = 'npm/12.0.2 node/v26 darwin arm64') {
  const response = await fetch(origin + '/npm/-/v1/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': agent, 'npm-auth-type': 'web' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(new URL(body.loginUrl).origin, origin);
  assert.equal(new URL(body.doneUrl).origin, origin);
  const id = new URL(body.loginUrl).pathname.split('/').pop()!;
  const pollId = new URL(body.doneUrl).pathname.split('/').pop()!;
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pollId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(id, pollId);
  assert.ok(!body.loginUrl.includes(pollId));
  return { ...body, id, api: origin + '/api/packages/npm-login/' + id };
}
const finish = (login: { api: string }, action: string, headers = {}) =>
  fetch(login.api, {
    method: 'POST',
    headers: { cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ action }),
  });

test('npm and pnpm browser login hands out a publishing key exactly once', async () => {
  for (const client of ['npm', 'pnpm']) {
    const login = await start(
      client === 'npm'
        ? 'npm/12.0.2 node/v26 darwin arm64'
        : 'pnpm/11.1.3 npm/? node/v26 darwin arm64',
    );
    const waiting = await fetch(login.doneUrl);
    assert.equal(waiting.status, 202);
    assert.equal(waiting.headers.get('Retry-After'), '1');
    assert.deepEqual(await waiting.json(), { pending: true });
    await failedPoll(origin + '/npm/-/v1/login/done/' + login.id);
    const details = await (await fetch(login.api, { headers: { cookie } })).json();
    assert.deepEqual(details, {
      client,
      computer: 'a Mac',
      address: '127.0.0.1',
      name: 'Gabriel',
      state: 'pending',
    });
    const approved = await finish(login, 'approve');
    assert.equal(approved.status, 200);
    const browser = await approved.json();
    assert.deepEqual(browser, { ...details, state: 'approved' });
    assert.equal((await finish(login, 'approve')).status, 409);
    assert.equal((await finish(login, 'cancel')).status, 409);
    const responses = await Promise.all([fetch(login.doneUrl), fetch(login.doneUrl)]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200],
    );
    assert.equal(bodies.filter((body) => body.token).length, 1);
    const winner = bodies.findIndex((body) => body.token);
    const { token } = bodies[winner];
    assert.match(token, /^dlp_[A-Za-z0-9_-]{43}$/);
    assert.equal(
      (await fetch(login.api, { headers: { Authorization: 'Bearer ' + token } })).status,
      401,
    );
    assert.equal(responses[winner].headers.get('Cache-Control'), 'no-store');
    await failedPoll(login.doneUrl);
    const keys = listKeys('alice') as { label: string; scope: string }[];
    assert.ok(
      keys.some((key) => key.label === `${client} · Mac · 127.0.0.1` && key.scope === 'publish'),
    );
    const name = `@deploy.local/${client}-browser-login`;
    const published = await fetch(origin + '/npm/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name, version: '1.0.0' } },
        _attachments: {
          'package.tgz': { data: Buffer.from('tarball').toString('base64'), length: 7 },
        },
      }),
    });
    assert.equal(published.status, 201, await published.text());
    // Reloading the browser keeps the success state but never returns the token.
    assert.deepEqual(await (await fetch(login.api, { headers: { cookie } })).json(), browser);
  }
});

test('cancel and expiry fail polls without creating keys', async (t) => {
  const before = listKeys('alice').length;
  const cancelled = await start();
  assert.equal((await finish(cancelled, 'cancel')).status, 200);
  await failedPoll(cancelled.doneUrl);
  assert.equal((await finish(cancelled, 'approve')).status, 409);
  const pending = await start();
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(10 * 60_000);
  assert.equal((await finish(pending, 'approve')).status, 410);
  await failedPoll(pending.doneUrl);
  assert.equal((await fetch(pending.api, { headers: { cookie } })).status, 410);
  assert.equal(listKeys('alice').length, before);
});

test('browser API requires a person and same-origin POST, and all other writes still need keys', async () => {
  const login = await start();
  const before = listKeys('alice').length;
  for (const method of ['GET', 'POST']) {
    for (const headers of [
      {},
      { Authorization: 'Bearer invalid' },
      { cookie: 'deploy-sh-auth=alice:wrong' },
    ]) {
      const response = await fetch(login.api, {
        method,
        headers: headers as Record<string, string>,
        ...(method === 'POST' ? { body: '{"action":"approve"}' } : {}),
      });
      assert.equal(response.status, 401);
    }
  }
  for (const headers of [
    { Origin: 'https://elsewhere.test' },
    { Origin: '' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'x-deploy-agent-token': 'agent' },
    { 'x-deploy-worker-token': 'worker' },
  ])
    assert.equal((await finish(login, 'approve', headers)).status, 403);
  assert.equal((await finish(login, 'invalid')).status, 400);
  assert.equal(listKeys('alice').length, before);
  assert.equal((await fetch(login.doneUrl)).status, 202);
  for (const [path, method] of [
    ['-/v1/login/extra', 'POST'],
    ['-/v1/login', 'PUT'],
    ['@deploy.local/unsigned', 'PUT'],
  ]) {
    const response = await fetch(origin + '/npm/' + path, { method, body: '{}' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, `Run npm login --registry ${origin}/npm/`);
  }
  await finish(login, 'cancel');
});

test('client and platform come from user-agent, never a claimed computer name', async () => {
  for (const [agent, client, computer] of [
    ['pnpm/11.1.3 npm/? node/v26 linux arm64', 'pnpm', 'a Linux computer'],
    ['npm/12.0.2 node/v26 win32 x64', 'npm', 'a Windows computer'],
    // pnpm 11 sends undici's user agent and asks for web login with npm-auth-type.
    ['undici', 'pnpm', 'a computer'],
  ]) {
    const login = await start(agent);
    const details = await (await fetch(login.api, { headers: { cookie } })).json();
    assert.equal(details.client, client);
    assert.equal(details.computer, computer);
    await finish(login, 'cancel');
  }
  const response = await fetch(origin + '/npm/-/v1/login', {
    method: 'POST',
    headers: { Host: 'registry.test:8443', 'X-Forwarded-Proto': 'https' },
    body: '{}',
  });
  const urls = await response.json();
  assert.equal(new URL(urls.loginUrl).origin, 'https://registry.test:8443');
  assert.equal(new URL(urls.doneUrl).origin, 'https://registry.test:8443');
});

test('pending sign-ins are bounded and expiry frees capacity', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 });
  // Use the same creation function to fill the bound without opening 1024 connections.
  const req = {
    headers: { 'user-agent': 'npm/12 node/v26 darwin arm64' },
    socket: { remoteAddress: '::ffff:192.168.1.42' },
  };
  let first: ReturnType<typeof startNpmLogin> | undefined;
  for (let index = 0; index < 1024; index++) first = startNpmLogin(req as any, origin + '/npm/');
  const id = new URL(first!.loginUrl).pathname.split('/').pop();
  const details = await (
    await fetch(origin + '/api/packages/npm-login/' + id, { headers: { cookie } })
  ).json();
  assert.equal(details.address, '192.168.1.42');
  const full = await fetch(origin + '/npm/-/v1/login', { method: 'POST', body: '{}' });
  assert.equal(full.status, 429);
  t.mock.timers.tick(10 * 60_000);
  const fresh = await start();
  await finish(fresh, 'cancel');
});

test('split-process HTTPS login uses the original edge socket and remains same-origin', async () => {
  const priorRole = process.env.DEPLOY_ROLE;
  process.env.DEPLOY_ROLE = 'control';
  try {
    const throughEdge = routeFetch(async (req, res) => {
      Object.assign(req.socket, { remoteAddress: '::ffff:192.168.1.42' });
      req.headers = controlRequestHeaders(req) as typeof req.headers;
      Object.assign(req.socket, { remoteAddress: '127.0.0.1', encrypted: false });
      if (await registry.handle(req, res)) return;
      const url = new URL(req.url!, 'https://registry.test');
      await apiRoutes({
        req,
        res,
        url,
        path: url.pathname,
        workspacePath: url.pathname,
        method: req.method,
      });
    });
    const response = await throughEdge('https://registry.test/npm/-/v1/login', {
      method: 'POST',
      headers: { 'User-Agent': 'npm/12.0.2 node/v26 darwin arm64', 'X-Forwarded-For': 'spoofed' },
      body: '{}',
    });
    const login = await response.json();
    assert.equal(new URL(login.loginUrl).origin, 'https://registry.test');
    const api = login.loginUrl.replace('/packages/', '/api/packages/');
    const details = await (await throughEdge(api, { headers: { cookie } })).json();
    assert.equal(details.address, '192.168.1.42');
    const approved = await throughEdge(api, {
      method: 'POST',
      headers: { cookie, Origin: 'https://registry.test' },
      body: '{"action":"approve"}',
    });
    assert.equal(approved.status, 200);
    assert.equal((await throughEdge(login.doneUrl)).status, 200);
  } finally {
    if (priorRole === undefined) delete process.env.DEPLOY_ROLE;
    else process.env.DEPLOY_ROLE = priorRole;
  }
});
