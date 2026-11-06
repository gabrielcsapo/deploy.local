import { requireAuth, error, json } from './shared.ts';
import { getDeployment, getBuildLogs, getActiveBuildLog } from '../store.ts';
import { RequestBodyTooLargeError } from '../http.ts';
import { type ApiRouteContext } from './context.ts';

export async function buildLogsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Build Logs ─────────────────────────────────────────────────────

      const buildLogsMatch = path.match(/^\/api\/deployments\/([^/]+)\/build-logs$/);

      if (buildLogsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = buildLogsMatch[1];
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
