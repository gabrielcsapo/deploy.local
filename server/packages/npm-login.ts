import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import { preferences } from '../v2/auth-store.ts';
import { audit, createKey, type Identity } from './keys.ts';
import { fail } from './store.ts';

const lifetime = 10 * 60_000;
const maximumPending = 1024;
type Login = {
  id: string;
  secret: string;
  client: 'npm' | 'pnpm';
  computer: string;
  platform: string;
  address: string;
  expiresAt: number;
  state: 'pending' | 'approved' | 'cancelled';
  username?: string;
  name?: string;
  token?: string;
  timer: ReturnType<typeof setTimeout>;
};
const logins = new Map<string, Login>();
const polls = new Map<string, Login>();
const secret = () => randomBytes(32).toString('base64url');

function clientAddress(req: IncomingMessage) {
  const peer = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  // Split-process control only listens on loopback. The edge overwrites this header with
  // the original POST socket address. Single-process requests never trust that header.
  const forwarded = req.headers['x-forwarded-for'];
  return process.env.DEPLOY_ROLE === 'control' &&
    (peer === '127.0.0.1' || peer === '::1') &&
    typeof forwarded === 'string' &&
    isIP(forwarded)
    ? forwarded.replace(/^::ffff:/, '')
    : peer;
}

/** Keep the address used by the client, including its port (as with LFS URLs). */
export function npmRegistryUrl(req: IncomingMessage, fallback = 'https://deploy.local/npm/') {
  const host = req.headers.host || req.headers[':authority'];
  if (!host) return fallback;
  if (typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) fail('Invalid host');
  const protocol =
    (req.socket as { encrypted?: boolean }).encrypted ||
    req.headers['x-forwarded-proto'] === 'https'
      ? 'https'
      : 'http';
  return new URL('/npm/', `${protocol}://${host}`).href;
}

function forget(login: Login) {
  clearTimeout(login.timer);
  delete login.token;
  logins.delete(login.id);
  polls.delete(login.secret);
}
function current(login: Login | undefined) {
  if (login && login.expiresAt <= Date.now()) {
    forget(login);
    return undefined;
  }
  return login;
}
const expired = () => fail('This sign-in has expired. Run npm login again.', 410);

export function startNpmLogin(req: IncomingMessage, registry: string) {
  for (const login of logins.values()) current(login);
  if (logins.size >= maximumPending) fail('Too many pending sign-ins. Try again shortly.', 429);
  const agent = req.headers['user-agent'] || '';
  const client = /(?:^|\s)pnpm\//i.test(agent) ? 'pnpm' : 'npm';
  const os = agent.match(/(?:^|\s)(darwin|linux|win32)(?:\s|$)/i)?.[1].toLowerCase();
  const [platform, computer] =
    os === 'darwin'
      ? ['Mac', 'a Mac']
      : os === 'linux'
        ? ['Linux', 'a Linux computer']
        : os === 'win32'
          ? ['Windows', 'a Windows computer']
          : ['computer', 'a computer'];
  const id = secret();
  const login: Login = {
    id,
    secret: secret(),
    client,
    platform,
    computer,
    address: clientAddress(req),
    expiresAt: Date.now() + lifetime,
    state: 'pending',
    timer: setTimeout(() => forget(login), lifetime).unref(),
  };
  logins.set(id, login);
  polls.set(login.secret, login);
  return {
    loginUrl: new URL(`/packages/npm-login/${id}`, registry).href,
    doneUrl: new URL(`-/v1/login/done/${login.secret}`, registry).href,
  };
}

/** The browser only sees request details; it never sees the poll secret or publishing key. */
export function readNpmLogin(id: string, username: string) {
  const login = current(logins.get(id));
  if (!login) return expired();
  if (login.username && login.username !== username) fail('This sign-in is already finished.', 409);
  return {
    client: login.client,
    computer: login.computer,
    address: login.address,
    name: login.name ?? preferences(username).name,
    state: login.state,
  };
}

export function finishNpmLogin(
  id: string,
  action: unknown,
  identity: Identity,
  req: IncomingMessage,
) {
  if (action !== 'approve' && action !== 'cancel') fail('Choose approve or cancel.');
  const login = current(logins.get(id));
  if (!login) return expired();
  if (login.state !== 'pending') fail('This sign-in is already finished.', 409);
  if (action === 'approve') {
    const key = createKey(
      identity.username,
      `${login.client} · ${login.platform} · ${login.address}`,
      'publish',
    );
    login.token = key.key;
    login.state = 'approved';
    login.username = identity.username;
    login.name = preferences(identity.username).name;
    audit(identity, 'key-created', key.id, req);
  } else {
    login.state = 'cancelled';
    polls.delete(login.secret);
  }
  return readNpmLogin(id, identity.username);
}

export function pollNpmLogin(secret: string) {
  const login = current(polls.get(secret));
  if (!login) return expired();
  if (login.state === 'pending') return null;
  const token = login.token;
  delete login.token;
  polls.delete(secret);
  return { token };
}

export function requireNpmLoginOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (
    !origin ||
    origin !== new URL(npmRegistryUrl(req)).origin ||
    (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin')
  )
    fail('Use this page on deploy.local to sign in.', 403);
}
