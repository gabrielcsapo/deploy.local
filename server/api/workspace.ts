import { dispatch, routes, type RouteRequest } from '../kernel/routes.ts';
import { coordinationApi } from '../workspace/coordination-api.ts';
import { workerAuthentication } from '../workspace/credentials.ts';
import { workspaceApi } from '../workspace/api.ts';
import { requireAuth, error } from './shared.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

const route = routes<ApiRouteContext>();
const handler = async ({ context: ctx }: RouteRequest<ApiRouteContext>) => {
  const { req, res, workspacePath } = ctx;
  try {
    if (req.headers['x-deploy-agent-token']) return coordinationApi(req, res);
    const worker = workerAuthentication(req);
    if (worker) return workspaceApi(req, res, worker.owner, worker.workerId);
    // Git's standard Basic password is the existing deploy session token.
    const basic = req.headers.authorization;
    if (basic?.startsWith('Basic ')) {
      const decoded = Buffer.from(basic.slice(6), 'base64').toString();
      const split = decoded.indexOf(':');
      req.headers['x-deploy-username'] = decoded.slice(0, split);
      req.headers['x-deploy-token'] = decoded.slice(split + 1);
    }
    if (workspacePath.startsWith('/api/workspace/git/'))
      res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local Git"');
    const auth = requireAuth(req, res);
    if (!auth) return;
    return workspaceApi(req, res, auth.username);
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
};
const table = [
  route({ method: '*', path: '/api/workspace/', handler }),
  route({ method: '*', path: '/api/workspace/:rest*', handler }),
];
export async function workspaceRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.workspacePath, method: () => ctx.method })(
    ctx.req,
    ctx.res,
    ctx,
  );
}
