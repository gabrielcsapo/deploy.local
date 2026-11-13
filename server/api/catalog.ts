import { dispatch, routes, type RouteRequest } from '../routes.ts';
import { requireAdmin, error, json } from './shared.ts';
import { readBody, RequestBodyTooLargeError } from '../http.ts';
import {
  handleCatalogRequest,
  loadValidationCatalog,
  loadSupportedCatalog,
  CatalogService,
  DurableCatalogStore,
  DeployLocalCatalogRuntime,
  DurableCatalogTargetResolver,
} from '../catalog/index.ts';
import { type ApiRouteContext } from './context.ts';

const catalogReleases =
  process.env.DEPLOY_CATALOG_USE_VALIDATION_FIXTURES === '1'
    ? loadValidationCatalog()
    : loadSupportedCatalog();

export const catalogService = new CatalogService(catalogReleases, new DurableCatalogStore());

const catalogRuntime = new DeployLocalCatalogRuntime();

const catalogTargets = new DurableCatalogTargetResolver();

const route = routes<ApiRouteContext>();
const handler = async ({ context: ctx }: RouteRequest<ApiRouteContext>) => {
  const { req, res, path, method, url } = ctx;
  try {
    const auth = requireAdmin(req, res);
    if (!auth) return;
    if (method !== 'GET' && method !== 'POST') {
      return error(res, 'Catalog route not found', 404);
    }
    let body: unknown;
    if (method === 'POST') {
      const source = (await readBody(req)).toString();
      try {
        body = source ? JSON.parse(source) : {};
      } catch {
        return error(res, 'Request body must be valid JSON', 400);
      }
    }
    const response = await handleCatalogRequest(
      catalogService,
      {
        method,
        pathname: `${path.slice('/api'.length)}${url.search}`,
        body,
        actor: { username: auth.username, role: 'admin' },
      },
      catalogRuntime,
      catalogTargets,
    );
    return json(res, response.body, response.status);
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
  route({ method: '*', path: '/api/catalog', handler }),
  route({ method: '*', path: '/api/catalog/', handler }),
  route({ method: '*', path: '/api/catalog/:rest*', handler }),
];
export async function catalogRoutes(ctx: ApiRouteContext): Promise<boolean> {
  return dispatch(table, { path: () => ctx.path, method: () => ctx.method })(ctx.req, ctx.res, ctx);
}
