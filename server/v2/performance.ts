import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeployment } from '../store.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { readPerformance } from '../telemetry.ts';
import { sendJson } from '../kernel/http.ts';
import { fail } from '../kernel/errors.ts';
import { dispatch, routes } from '../kernel/routes.ts';

const route = routes<string>();

export const performanceRoutes = [
  route({
    method: 'GET',
    path: '/api/v2/apps/:app/performance',
    handler: ({ res, url, params, context: owner }) => {
      const name = decodeURIComponent(params.app);
      const app = getDeployment(name);
      if (!app || app.username !== owner) fail('App not found', 404);
      const range = url.searchParams.get('range') ?? '24h';
      if (!['1h', '24h', '7d'].includes(range)) fail('range must be 1h, 24h or 7d');
      sendJson(res, readPerformance(getRequestsSqlite(), name, range as '1h' | '24h' | '7d'), 200, {
        guard: true,
      });
    },
  }),
  route({
    method: '*',
    path: '/api/v2/apps/:app/performance',
    handler: () => fail('Method not allowed', 405),
  }),
];

const performanceDispatch = dispatch(performanceRoutes);

export async function performanceApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  return performanceDispatch(req, res, owner);
}
