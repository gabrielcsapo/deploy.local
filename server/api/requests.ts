import { requireAuth, error, json } from './shared.ts';
import { getDeployment, getRequestLogs, getRequestSummary } from '../store.ts';
import { RequestBodyTooLargeError } from '../http.ts';
import { type ApiRouteContext } from './context.ts';

export async function requestsRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      // ── Request logs API ───────────────────────────────────────────────

      const requestLogsMatch = path.match(/^\/api\/deployments\/([^/]+)\/requests$/);

      if (requestLogsMatch && method === 'GET') {
        const auth = requireAuth(req, res);
        if (!auth) return;
        const name = requestLogsMatch[1];
        const d = getDeployment(name);
        if (!d || d.username !== auth.username) return error(res, 'Not found', 404);
        return json(res, {
          logs: getRequestLogs(name),
          summary: getRequestSummary(name),
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
