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

/** The TLS socket or the control server's HTTPS proxy identifies the transport. */
function attributes(req?: Pick<IncomingMessage, 'headers' | 'socket'>) {
  const secure =
    !req ||
    ('encrypted' in req.socket && req.socket.encrypted) ||
    req.headers['x-forwarded-proto'] === 'https';
  return `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
export function buildAuthCookie(username: string, token: string, req?: IncomingMessage) {
  return `${AUTH_COOKIE}=${encodeURIComponent(`${username}:${token}`)}; ${attributes(req)}; Max-Age=2592000`;
}
export function clearAuthCookie(req?: IncomingMessage) {
  return `${AUTH_COOKIE}=; ${attributes(req)}; Max-Age=0`;
}
