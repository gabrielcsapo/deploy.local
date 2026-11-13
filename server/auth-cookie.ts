import type { IncomingMessage } from 'node:http';

export const AUTH_COOKIE = 'deploy-sh-auth';

export function parseAuthCookie(req: Pick<IncomingMessage, 'headers'>): {
  username?: string;
  token?: string;
} {
  const raw = req.headers.cookie;
  if (!raw) return {};
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === AUTH_COOKIE) {
      const value = rest.join('=');
      try {
        const decoded = decodeURIComponent(value);
        const sep = decoded.indexOf(':');
        if (sep === -1) return {};
        return { username: decoded.slice(0, sep), token: decoded.slice(sep + 1) };
      } catch {
        return {};
      }
    }
  }
  return {};
}

/**
 * Always Secure, except for plain HTTP on this machine's own loopback address (local runs).
 * The HTTPS front does not always say how the request arrived, so the default must be Secure.
 */
function attributes(req?: Pick<IncomingMessage, 'headers' | 'socket'>) {
  // The edge forwards to a loopback backend and keeps the name people used in x-forwarded-host.
  const host = String(req?.headers['x-forwarded-host'] ?? req?.headers.host ?? '').replace(
    /:\d+$/,
    '',
  );
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  const https =
    !req ||
    (!!req.socket && 'encrypted' in req.socket && req.socket.encrypted) ||
    req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${https || !loopback ? '; Secure' : ''}`;
}
export function buildAuthCookie(username: string, token: string, req?: IncomingMessage) {
  return `${AUTH_COOKIE}=${encodeURIComponent(`${username}:${token}`)}; ${attributes(req)}; Max-Age=2592000`;
}
export function clearAuthCookie(req?: IncomingMessage) {
  return `${AUTH_COOKIE}=; ${attributes(req)}; Max-Age=0`;
}

/** A browser whose sign-in was revoked drops its cookie on the next page or payload request. */
export function clearRevokedCookie(
  req: IncomingMessage,
  res: { setHeader(name: string, value: string): unknown },
  valid: (username?: string, token?: string) => unknown,
) {
  const cookie = parseAuthCookie(req);
  if (cookie.token && !valid(cookie.username, cookie.token))
    res.setHeader('Set-Cookie', clearAuthCookie(req));
}
