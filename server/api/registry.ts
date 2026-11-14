import { routes, dispatch } from '../kernel/routes.ts';
import { plainPath, sendJson } from '../kernel/http.ts';
import type { ApiRouteContext } from './context.ts';
import { apiRouteManifest } from './route-manifest.ts';
import { v2Routes } from './v2.ts';
import { workspaceRoutes } from './workspace.ts';
import { catalogRoutes } from './catalog.ts';
import { authRoutes } from './auth.ts';
import { fleetRoutes } from './fleet.ts';
import { uploadRoutes } from './upload.ts';
import { deploymentsRoutes } from './deployments.ts';
import { containersRoutes } from './containers.ts';
import { healthRoutes } from './health.ts';
import { requestsRoutes } from './requests.ts';
import { backupsRoutes } from './backups.ts';
import { buildLogsRoutes } from './build-logs.ts';

const handlers: Record<string, (ctx: ApiRouteContext) => Promise<boolean>> = {
  workspace: workspaceRoutes,
  catalog: catalogRoutes,
  auth: authRoutes,
  fleet: fleetRoutes,
  upload: uploadRoutes,
  deployments: deploymentsRoutes,
  containers: containersRoutes,
  health: healthRoutes,
  requests: requestsRoutes,
  backups: backupsRoutes,
  'build-logs': buildLogsRoutes,
};
const route = routes<ApiRouteContext>();
export const apiLeafRoutes = apiRouteManifest.map(({ method, path, handler }) =>
  route({
    method,
    path,
    handler: ({ context }) =>
      handler.startsWith('v2:') ? v2Routes(context, handler.slice(3)) : handlers[handler](context),
  }),
);
// Concrete methods precede transport fallbacks. A declined leaf never ends dispatch.
const table = [
  ...apiLeafRoutes.filter((r) => r.method !== '*'),
  ...apiLeafRoutes.filter((r) => r.method === '*'),
];
const serve = dispatch(table, { path: (url) => plainPath(url.pathname) });
export async function apiRoutes(ctx: ApiRouteContext): Promise<boolean> {
  if (!ctx.path.startsWith('/api/')) return false;
  if (await serve(ctx.req, ctx.res, ctx)) return true;
  const exists = table.some((route) => route.match(plainPath(ctx.path)));
  sendJson(ctx.res, { error: exists ? 'Method not allowed' : 'Not found' }, exists ? 405 : 404);
  return true;
}
