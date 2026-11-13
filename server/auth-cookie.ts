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
 * Secure unless this server was started for plain local HTTP (DEPLOY_PUBLIC_ORIGIN=http://…).
 * Request headers cannot decide it: the edge forwards HTTP/2 requests to a loopback backend
 * without the name or scheme people used, so a served request looks the same as a local one.
 */
function attributes() {
  const local = /^http:\/\//.test(process.env.DEPLOY_PUBLIC_ORIGIN ?? '');
  return `Path=/; HttpOnly; SameSite=Lax${local ? '' : '; Secure'}`;
}
export function buildAuthCookie(username: string, token: string, _req?: IncomingMessage) {
  return `${AUTH_COOKIE}=${encodeURIComponent(`${username}:${token}`)}; ${attributes()}; Max-Age=2592000`;
}
export function clearAuthCookie(_req?: IncomingMessage) {
  return `${AUTH_COOKIE}=; ${attributes()}; Max-Age=0`;
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
