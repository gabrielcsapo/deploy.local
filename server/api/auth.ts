import { requireAdmin, error, json, requireAuth, AUTH_COOKIE } from './shared.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import { registerUser, loginUser, logoutUser, getUser, changePassword } from '../store.ts';
import { listTopology } from '../multisite.ts';
import { handleOperationsRequest } from '../operations-handler.ts';
import { type ApiRouteContext } from './context.ts';

function buildAuthCookie(username: string, token: string): string {
  // 30 day TTL; httpOnly so JS can't read it (XSS-resistant); SameSite=Lax so
  // cookie still flows on top-level navigation. Secure flag is set because we
  // only serve over HTTPS (HTTP redirects to HTTPS).
  const value = encodeURIComponent(`${username}:${token}`);
  return `${AUTH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${60 * 60 * 24 * 30}`;
}

function clearAuthCookie(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

export async function authRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Auth routes ───────────────────────────────────────────────────────

      if (path === '/api/register' && method === 'POST') {
        // First ownership is established only by the local installer's setup code.
        const admin = requireAdmin(req, res);
        if (!admin) return;
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = registerUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        // Set cookie so subsequent navigations can pre-render with auth context
        // (server components can read it via getRequest()).
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token));
        return json(res, { token: result.token }, 201);
      }

      if (path === '/api/login' && method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = loginUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token));
        return json(res, { token: result.token });
      }

      if (path === '/api/logout' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        logoutUser(auth.username, auth.token);
        res.setHeader('Set-Cookie', clearAuthCookie());
        return json(res, { message: 'Logged out' });
      }

      if (path === '/api/user' && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const user = getUser(auth.username);
        return json(res, user);
      }

      if (path === '/api/user/password' && method === 'POST') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.currentPassword || !body.newPassword) {
          return error(res, 'Current password and new password required');
        }
        const result = changePassword(auth.username, body.currentPassword, body.newPassword);
        if ('error' in result) return error(res, result.error!, result.status!);
        return json(res, { message: 'Password changed' });
      }

      // The compatibility topology read supports ordinary application placement.
      // Portable-site mutation/transport routes no longer exist.
      if (path === '/api/fleet/topology' && method === 'GET') {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        return json(res, listTopology());
      }

      if (path.startsWith('/api/operations/') && (method === 'GET' || method === 'POST')) {
        const auth = requireAdmin(req, res);
        if (!auth) return;
        let body: unknown;
        if (method === 'POST') {
          const source = (await readBody(req, 1024 * 1024)).toString();
          try {
            body = source ? JSON.parse(source) : {};
          } catch {
            return error(res, 'Request body must be valid JSON', 400);
          }
        }
        const result = await handleOperationsRequest({
          method,
          pathname: path.slice('/api'.length) + url.search,
          body,
          actor: { username: auth.username, role: 'admin' },
        });
        return json(res, result.body, result.status);
      }
      return false;
    } catch (err: unknown) {
      console.error(err);
      error(
        res,
        (err as Error).message || 'Internal server error',
        err instanceof RequestBodyTooLargeError
          ? 413
          : (err as Error & { status?: number }).status || 500,
      );
    }
  })();
  return result !== false;
}
