import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Project } from '../../shared/v2/contracts.ts';
import { resolveProject } from './projects.ts';
import { fail } from './inbox.ts';

export function projectLogSources(project: Project, app: string | null) {
  const selected = app
    ? project.apps.filter((entry) => entry.id === app || entry.name === app)
    : project.apps;
  if (app && !selected.length) fail('App is not in this project', 404);
  return selected.map((entry) => ({
    app: entry.name,
    url: `/api/deployments/${encodeURIComponent(entry.name)}/logs?tail=1000`,
  }));
}
export async function logsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const url = new URL(req.url!, 'http://localhost');
  const match = url.pathname.match(/^\/api\/v2\/projects\/([^/]+)\/logs$/);
  if (!match) return false;
  if (req.method !== 'GET') fail('Method not allowed', 405);
  const project = await resolveProject(owner, decodeURIComponent(match[1]));
  const sources = projectLogSources(project, url.searchParams.get('app'));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ sources }));
  return true;
}
