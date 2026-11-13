import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeFetch } from './test-request.ts';
const root = mkdtempSync(join(tmpdir(), 'auth-cookie-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_PUBLIC_ORIGIN = 'https://example.test';
const store = await import('../store.ts');
const { db } = await import('../workspace/store.ts');
const { v2Api } = await import('./api.ts');
const { requireAuth } = await import('../api/shared.ts');
const { cliLoginStart, cliApprove } = await import('./auth-cli.ts');
const { grant } = await import('./auth-store.ts');
const account = store.registerUser('owner', 'test-password');
const fetch = routeFetch((req, res) => v2Api(req, res, requireAuth));
const headers = {
  'Content-Type': 'application/json',
  'x-deploy-username': 'owner',
  'x-deploy-token': account.token!,
};
const post = (
  path: string,
  body = {},
  extra: Record<string, string> = headers,
  origin = 'https://example.test',
) =>
  fetch(`${origin}/api/v2${path}`, { method: 'POST', headers: extra, body: JSON.stringify(body) });
after(() => {
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
function cookie(response: Response) {
  const value = response.headers.get('set-cookie')!;
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  return value;
}
test('token adoption validates explicit credentials, sets secure HTTPS cookies and works over local HTTP', async () => {
  const response = await post('/auth/session');
  assert.equal(response.status, 200);
  assert.match(cookie(response), /; Secure;/);
  // The edge forwards HTTP/2 requests to a loopback backend with no trace of HTTPS.
  const fronted = await post('/auth/session', {}, headers, 'http://127.0.0.1:7843');
  assert.match(cookie(fronted), /; Secure;/);
  process.env.DEPLOY_PUBLIC_ORIGIN = 'http://127.0.0.1:5188';
  try {
    const http = await post('/auth/session', {}, headers, 'http://127.0.0.1:5188');
    assert.doesNotMatch(cookie(http), /; Secure;/);
  } finally {
    delete process.env.DEPLOY_PUBLIC_ORIGIN;
  }
  const bad = await post('/auth/session', {}, { ...headers, 'x-deploy-token': 'wrong' });
  assert.equal(bad.status, 401);
  assert.match(cookie(bad), /Max-Age=0/);
  const foreign = await post('/auth/session', {}, { ...headers, origin: 'https://evil.test' });
  assert.equal(foreign.status, 403);
});
test('CLI approval and pairing exchange set the same cookie without changing their JSON', async () => {
  const login = cliLoginStart();
  cliApprove('owner', login.userCode, true);
  const approved = await post('/auth/cli/poll', { deviceCode: login.deviceCode });
  const body = await approved.json();
  assert.equal(body.state, 'approved');
  assert.ok(cookie(approved).includes(encodeURIComponent(`owner:${body.token}`)));
  const pairing = await post('/devices/exchange', {
    token: grant('pair', 'owner', {}, 60000),
    name: 'Desktop',
  });
  const paired = await pairing.json();
  assert.ok(cookie(pairing).includes(encodeURIComponent(`owner:${paired.token}`)));
  const revoked = await fetch(`https://example.test/api/v2/devices/${paired.id}`, {
    method: 'DELETE',
    headers: { ...headers, cookie: cookie(pairing).split(';')[0] },
    body: '{}',
  });
  assert.equal(revoked.status, 200);
  assert.match(cookie(revoked), /Max-Age=0/);
  assert.equal(store.authenticate('owner', paired.token), false);
});
test('sign-out clears the cookie even when the token has already been revoked', async () => {
  const response = await fetch('https://example.test/api/v2/auth/session', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.match(cookie(response), /Max-Age=0/);
});
