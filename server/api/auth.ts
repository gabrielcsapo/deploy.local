import { dispatch, routes } from '../kernel/routes.ts';
import { requireAdmin, error, json, requireAuth } from './shared.ts';
import { readBody, RequestBodyTooLargeError } from '../kernel/http.ts';
import { registerUser, loginUser, logoutUser, getUser, changePassword } from '../store.ts';

import { handleOperationsRequest } from '../operations-handler.ts';
import { type ApiRouteContext } from './context.ts';

import { buildAuthCookie, clearAuthCookie } from '../auth-cookie.ts';
export { buildAuthCookie } from '../auth-cookie.ts';

const route = routes<ApiRouteContext>();
const table = [
  route({
    method: 'POST',
    path: '/api/register',
    handler: async ({ context: ctx }) => {
      const { req, res } = ctx;
      try {
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
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token, req));
        return json(res, { token: result.token }, 201);
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
    },
  }),
  route({
    method: 'POST',
    path: '/api/login',
    handler: async ({ context: ctx }) => {
      const { req, res } = ctx;
      try {
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.username || !body.password) {
          return error(res, 'Username and password required');
        }
        const result = loginUser(body.username as string, body.password as string);
        if ('error' in result) return error(res, result.error!, result.status!);
        res.setHeader('Set-Cookie', buildAuthCookie(body.username as string, result.token, req));
        return json(res, { token: result.token });
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
    },
  }),
  route({
    method: 'GET',
    path: '/api/logout',
    handler: async ({ context: ctx }) => {
      const { req, res } = ctx;
      try {
        res.setHeader('Set-Cookie', clearAuthCookie(req));
        const auth = requireAuth(req, res);
        if (!auth) return;
        logoutUser(auth.username, auth.token);
        res.setHeader('Set-Cookie', clearAuthCookie(req));
        return json(res, { message: 'Logged out' });
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
    },
  }),
  route({
    method: 'GET',
    path: '/api/user',
    handler: async ({ context: ctx }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const user = getUser(auth.username);
        return json(res, user);
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
    },
  }),
  route({
    method: 'POST',
    path: '/api/user/password',
    handler: async ({ context: ctx }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const body = JSON.parse((await readBody(req)).toString());
        if (!body.currentPassword || !body.newPassword) {
          return error(res, 'Current password and new password required');
        }
        const result = changePassword(auth.username, body.currentPassword, body.newPassword);
        if ('error' in result) return error(res, result.error!, result.status!);
        return json(res, { message: 'Password changed' });
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
    },
  }),
  route({
    method: ['GET', 'POST'],
    path: '/api/operations/:rest(.*)',
    handler: async ({ context: ctx }) => {
      const { req, res, path, method, url } = ctx;
      try {
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
          method: method as 'GET' | 'POST',
          pathname: path.slice('/api'.length) + url.search,
          body,
          actor: { username: auth.username, role: 'admin' },
        });
        return json(res, result.body, result.status);
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
    },
  }),
];

export async function authRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.path, method: () => ctx.method })(ctx.req, ctx.res, ctx);
}
