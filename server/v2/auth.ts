import { dispatch, routes } from '../routes.ts';
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
import { buildAuthCookie, clearAuthCookie, parseAuthCookie } from '../auth-cookie.ts';
import { authenticate } from '../store.ts';
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
  // This feature stays before sign-in; each stage owns its credential boundary.
  const route = routes<undefined>();
  const options = { path: () => path };
  if (
    await dispatch(
      [
        route({ method: 'GET', path: '/auth/trust', handler: () => send({ trusted: true }) }),
        route({
          method: 'GET',
          path: '/setup',
          handler: () => send({ ...serverIdentity(), needsSetup: !hasOwner() }),
        }),
        route({
          method: 'GET',
          path: '/apps-home',
          handler: () =>
            send({ apps: appsAtHome(), server: serverIdentity().name, computers: homeComputers() }),
        }),
        route({
          method: 'GET',
          path: '/auth/methods',
          handler: () =>
            send({
              passkey: !!authDb().prepare('SELECT 1 FROM v2_passkeys LIMIT 1').get(),
              server: serverIdentity().name,
            }),
        }),
      ],
      options,
    )(req, res, undefined)
  )
    return true;
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
  if (
    await dispatch(
      [
        route({
          method: 'POST',
          path: '/setup',
          handler: () => {
            const result = setupAccount(body);
            res.setHeader('Set-Cookie', buildAuthCookie(result.username, result.token, req));
            return send(result, 201);
          },
        }),
        route({
          method: 'POST',
          path: '/auth/passkey/login/options',
          handler: async () => send(await loginOptions()),
        }),
        route({
          method: 'POST',
          path: '/auth/passkey/login/verify',
          handler: async () => {
            const result = await loginVerify(body.challengeId, body.response);
            res.setHeader('Set-Cookie', buildAuthCookie(result.username, result.token, req));
            return send({ username: result.username, token: result.token });
          },
        }),
        route({
          method: 'POST',
          path: '/auth/session',
          handler: () => {
            // Adoption must validate the explicit token, never fall back to a different cookie.
            const username = req.headers['x-deploy-username'];
            const token = req.headers['x-deploy-token'];
            if (
              typeof username !== 'string' ||
              typeof token !== 'string' ||
              !authenticate(username, token)
            ) {
              res.setHeader('Set-Cookie', clearAuthCookie(req));
              fail('Unauthorized', 401);
            }
            res.setHeader('Set-Cookie', buildAuthCookie(username, token, req));
            return send({ adopted: true });
          },
        }),
        route({
          method: 'DELETE',
          path: '/auth/session',
          handler: () => {
            res.setHeader('Set-Cookie', clearAuthCookie(req));
            return send({ cleared: true });
          },
        }),
        route({ method: 'POST', path: '/auth/cli/start', handler: () => send(cliLoginStart()) }),
        route({
          method: 'POST',
          path: '/auth/cli/poll',
          handler: () => {
            const result = cliPoll(body.deviceCode);
            if (result.username && result.token)
              res.setHeader('Set-Cookie', buildAuthCookie(result.username, result.token, req));
            return send(result);
          },
        }),
        route({
          method: 'POST',
          path: '/devices/exchange',
          handler: () => {
            const result = exchangeDevice(body.token, body.name);
            res.setHeader('Set-Cookie', buildAuthCookie(result.username, result.token, req));
            return send(result, 201);
          },
        }),
      ],
      options,
    )(req, res, undefined)
  )
    return true;
  const auth = requireAuth(req, res);
  if (!auth) return true;
  const owner = auth.username;
  return dispatch(
    [
      route({
        method: 'GET',
        path: '/setup/recovery',
        handler: async () => send(await recoveryProgress()),
      }),
      route({
        method: 'GET',
        path: '/auth/account',
        handler: () =>
          send({ username: owner, ...preferences(owner), hasPasskey: passkeys(owner).length > 0 }),
      }),
      route({
        method: 'POST',
        path: '/auth/account',
        handler: () => {
          const update: Partial<ReturnType<typeof preferences>> = {};
          for (const key of ['passkeyOffered', 'firstTaskSeen', 'welcomed'] as const)
            if (body[key] === true) update[key] = true;
          return send(updatePreferences(owner, update));
        },
      }),
      route({
        method: 'POST',
        path: '/auth/passkey/register/options',
        handler: async () => send(await registrationOptions(owner)),
      }),
      route({
        method: 'POST',
        path: '/auth/passkey/register/verify',
        handler: async () => send(await registrationVerify(owner, body.challengeId, body.response)),
      }),
      route({
        method: 'POST',
        path: '/auth/cli/approve',
        handler: () => {
          if (typeof body.approved !== 'boolean') fail('Choose Approve or Deny.');
          return send(cliApprove(owner, body.code, body.approved));
        },
      }),
      route({ method: 'GET', path: '/devices', handler: () => send({ devices: devices(owner) }) }),
      route({ method: 'POST', path: '/devices/pair', handler: () => send(pairDevice(owner)) }),
      route({
        method: 'DELETE',
        path: '/devices/:id',
        handler: ({ params }) => {
          removeDevice(owner, decodeURIComponent(params.id));
          const cookie = parseAuthCookie(req);
          if (cookie.token && !authenticate(cookie.username, cookie.token))
            res.setHeader('Set-Cookie', clearAuthCookie(req));
          return send({ removed: true });
        },
      }),
    ],
    { ...options, notFound: () => send({ error: 'Not found' }, 404) },
  )(req, res, undefined);
}
