import { dispatch, routes } from '../kernel/routes.ts';
import { requireAuth, error, json } from './shared.ts';
import { getDeployment, getRequestLogs, getRequestSummary } from '../store.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

const route = routes<ApiRouteContext>();
const table = [
  route({
    method: 'GET',
    path: '/api/deployments/:part1/requests',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, {
          logs: getRequestLogs(name),
          summary: getRequestSummary(name),
        });
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

export async function requestsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.path, method: () => ctx.method })(ctx.req, ctx.res, ctx);
}
