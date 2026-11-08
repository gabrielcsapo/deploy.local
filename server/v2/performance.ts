import type { IncomingMessage, ServerResponse } from 'node:http';
import { getDeployment } from '../store.ts';
import { getRequestsSqlite } from '../requests-db.ts';
import { readPerformance } from '../telemetry.ts';
import { sendJson } from '../http.ts';
import { fail } from '../errors.ts';
export async function performanceApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  const match = url.pathname.match(/^\/api\/v2\/apps\/([^/]+)\/performance$/);
  if (!match) return false;
  if (req.method !== 'GET') fail('Method not allowed', 405);
  const name = decodeURIComponent(match[1]);
  const app = getDeployment(name);
  if (!app || app.username !== owner) fail('App not found', 404);
  const range = url.searchParams.get('range') ?? '24h';
  if (!['1h', '24h', '7d'].includes(range)) fail('range must be 1h, 24h or 7d');
  sendJson(res, readPerformance(getRequestsSqlite(), name, range as '1h' | '24h' | '7d'), 200, {
    guard: true,
  });
  return true;
}
