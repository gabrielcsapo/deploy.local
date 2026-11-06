import { legacyUpdateProtected } from '../legacy-docker-update.ts';
import { getDeployment } from '../store.ts';
import { requireAuth, error } from './shared.ts';
import { RequestBodyTooLargeError } from '../http.ts';
import { type ApiRouteContext } from './context.ts';

export async function groffeeGuardRoutes(ctx: ApiRouteContext): Promise<boolean> {
  const { req, res, path, method } = ctx;
  // Keep the original return boundary: returned promises bypass the catch,
  // while thrown errors and rejected awaits use the existing API error response.
  const result = await (async () => {
    try {
      if (
        method !== 'GET' &&
        /^\/api\/deployments\/groffee(?:\/|$)/.test(path.toLowerCase()) &&
        !/^\/api\/deployments\/groffee\/legacy-update(?:\/(?:recover|rollback))?$/.test(path) &&
        (legacyUpdateProtected('groffee') ||
          (path.toLowerCase() === '/api/deployments/groffee/application-apply' &&
            getDeployment('groffee')?.containerName === 'deploy-sh-groffee' &&
            !getDeployment('groffee')?.activeSpecDigest))
      ) {
        const auth = requireAuth(req, res);
        if (!auth) return;
        if (getDeployment('groffee')?.username !== auth.username)
          return error(res, 'Not found', 404);
        return error(
          res,
          'Groffee legacy state is protected; use explicit legacy update/recover/rollback',
          409,
        );
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
