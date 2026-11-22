import { v2Api } from '../v2/api.ts';
import { requireAuth, error } from './shared.ts';
import { RequestBodyTooLargeError } from '../kernel/http.ts';
import { type ApiRouteContext } from './context.ts';

export async function v2Routes(
  ctx: ApiRouteContext,
  feature?: string,
  template?: string,
): Promise<boolean> {
  const { req, res, path } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      if (path.startsWith('/api/')) return v2Api(req, res, requireAuth, feature, template);
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
