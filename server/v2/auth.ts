import { sendJson } from '../http.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authDb, preferences, updatePreferences } from './auth-store.ts';
import {
  appsAtHome,
  hasOwner,
  homeComputers,
  serverIdentity,
  setupAccount,
  recoveryProgress,
} from './setup.ts';
import {
  registrationOptions,
  registrationVerify,
  loginOptions,
  loginVerify,
  passkeys,
} from './auth-passkey.ts';
import { cliLoginStart, cliApprove, cliPoll } from './auth-cli.ts';
import { devices, pairDevice, exchangeDevice, removeDevice } from './devices.ts';
import { fail } from '../errors.ts';

type RequireAuth = (req: IncomingMessage, res: ServerResponse) => { username: string } | null;
function cookie(username: string, token: string) {
  return `deploy-sh-auth=${encodeURIComponent(`${username}:${token}`)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000`;
}
const attempts = new Map<string, { count: number; until: number }>();
export function limitAuth(req: IncomingMessage) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  for (const [ip, row] of attempts) if (row.until <= now) attempts.delete(ip);
  const row = attempts.get(key) || { count: 0, until: now + 60_000 };
  if (++row.count > 60) fail('Too many attempts. Try again in a minute.', 429);
  attempts.set(key, row);
}
export async function authApi(req: IncomingMessage, res: ServerResponse, requireAuth: RequireAuth) {
  const url = new URL(req.url!, 'http://localhost');
  const path = url.pathname.slice('/api/v2'.length);
  if (!/^\/(setup|auth|devices|apps-home)(\/|$)/.test(path)) return false;
  const send = (data: unknown, status = 200) => sendJson(res, data, status);
  if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
    fail('Sign in as a person to manage accounts.', 403);
  if (req.method === 'GET' && path === '/auth/trust') return send({ trusted: true });
  if (req.method === 'GET' && path === '/setup')
    return send({ ...serverIdentity(), needsSetup: !hasOwner() });
  if (req.method === 'GET' && path === '/apps-home')
    return send({
      apps: appsAtHome(),
      server: serverIdentity().name,
      computers: homeComputers(),
    });
  if (req.method === 'GET' && path === '/auth/methods')
    return send({
      passkey: !!authDb().prepare('SELECT 1 FROM v2_passkeys LIMIT 1').get(),
      server: serverIdentity().name,
    });
  let body: any = {};
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE') {
    limitAuth(req);
    const origin = req.headers.origin;
    // Only the canonical origin may exercise browser mutations. CLI/native omit Origin.
    if (origin && origin !== new URL(serverIdentity().origin).origin)
      fail('Use SER’s own address to sign in.', 403);
    if (!req.headers['content-type']?.startsWith('application/json'))
      fail('Send application/json.', 415);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      bytes += chunk.length;
      if (bytes > 65536) {
        req.resume();
        fail('Request too large.', 413);
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail('Invalid JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail('Send a JSON object.');
  }
  if (req.method === 'POST') {
    if (path === '/setup') {
      const result = setupAccount(body);
      res.setHeader('Set-Cookie', cookie(result.username, result.token));
      return send(result, 201);
    }
    if (path === '/auth/passkey/login/options') return send(await loginOptions());
    if (path === '/auth/passkey/login/verify') {
      const result = await loginVerify(body.challengeId, body.response);
      res.setHeader('Set-Cookie', cookie(result.username, result.token));
      return send({ username: result.username, token: result.token });
    }
    if (path === '/auth/cli/start') return send(cliLoginStart());
    if (path === '/auth/cli/poll') return send(cliPoll(body.deviceCode));
    if (path === '/devices/exchange') return send(exchangeDevice(body.token, body.name), 201);
  }
  const auth = requireAuth(req, res);
  if (!auth) return true;
  const owner = auth.username;
  if (req.method === 'GET' && path === '/setup/recovery') return send(await recoveryProgress());
  if (req.method === 'GET' && path === '/auth/account')
    return send({ username: owner, ...preferences(owner), hasPasskey: passkeys(owner).length > 0 });
  if (req.method === 'POST' && path === '/auth/account') {
    const update: Partial<ReturnType<typeof preferences>> = {};
    for (const key of ['passkeyOffered', 'firstTaskSeen', 'welcomed'] as const)
      if (body[key] === true) update[key] = true;
    return send(updatePreferences(owner, update));
  }
  if (req.method === 'POST' && path === '/auth/passkey/register/options')
    return send(await registrationOptions(owner));
  if (req.method === 'POST' && path === '/auth/passkey/register/verify')
    return send(await registrationVerify(owner, body.challengeId, body.response));
  if (req.method === 'POST' && path === '/auth/cli/approve') {
    if (typeof body.approved !== 'boolean') fail('Choose Approve or Deny.');
    return send(cliApprove(owner, body.code, body.approved));
  }
  if (req.method === 'GET' && path === '/devices') return send({ devices: devices(owner) });
  if (req.method === 'POST' && path === '/devices/pair') return send(pairDevice(owner));
  if (req.method === 'DELETE' && /^\/devices\/[^/]+$/.test(path)) {
    removeDevice(owner, decodeURIComponent(path.split('/')[2]));
    return send({ removed: true });
  }
  return send({ error: 'Not found' }, 404);
}
