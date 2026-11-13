import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';
import { readProjectBody } from './settings.ts';
import { addProjectRepository, createRepositoryProject, unlinkedProjectApps } from './projects.ts';

export async function projectsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  const path = new URL(req.url!, 'http://localhost').pathname;
  if (path === '/api/v2/projects/unlinked-apps' && req.method === 'GET') {
    sendJson(res, { apps: await unlinkedProjectApps(owner) });
    return true;
  }
  const repository = path.match(/^\/api\/v2\/projects\/([^/]+)\/repository$/);
  if (req.method !== 'POST' || (!repository && path !== '/api/v2/projects')) return false;
  const body = await readProjectBody(req);
  const project = repository
    ? await addProjectRepository(owner, decodeURIComponent(repository[1]), body)
    : await createRepositoryProject(owner, body, JSON.stringify(body));
  sendJson(res, project, 202);
  return true;
}
