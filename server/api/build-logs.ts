import { dispatch, routes } from '../kernel/routes.ts';
import { requireAuth, error, json } from './shared.ts';
import { getDeployment, getBuildLogs, getActiveBuildLog } from '../store.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

const route = routes<ApiRouteContext>();
const table = [
  route({
    method: 'GET',
    path: '/api/deployments/:part1/build-logs',
    handler: async ({ context: ctx, params }) => {
      const { req, res } = ctx;
      try {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = params.part1;
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);

        const url = new URL(req.url!, `http://${req.headers.host}`);
        const page = parseInt(url.searchParams.get('page') || '1', 10);
        const { rows, total, pageSize } = await getBuildLogs(name, page);
        const activeBuild = await getActiveBuildLog(name);
        return json(res, {
          logs: rows,
          total,
          page,
          pageSize,
          activeBuild: activeBuild
            ? {
                output: activeBuild.output,
                timestamp: activeBuild.timestamp,
                phase: d.status || 'building',
              }
            : null,
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

export async function buildLogsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.path, method: () => ctx.method })(ctx.req, ctx.res, ctx);
}
