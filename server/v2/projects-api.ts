import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../http.ts';
import { readProjectBody } from './settings.ts';
import { addProjectRepository, createRepositoryProject, unlinkedProjectApps } from './projects.ts';
import { dispatch, routes } from '../routes.ts';

const route = routes<string>();

export const projectsRoutes = [
  route({
    method: 'GET',
    path: '/api/v2/projects/unlinked-apps',
    handler: async ({ res, context: owner }) =>
      sendJson(res, { apps: await unlinkedProjectApps(owner, true) }),
  }),
  route({
    method: 'POST',
    path: '/api/v2/projects/:project/repository',
    input: readProjectBody,
    handler: async ({ res, params, input: body, context: owner }) =>
      sendJson(
        res,
        await addProjectRepository(owner, decodeURIComponent(params.project), body),
        202,
      ),
  }),
  route({
    method: 'POST',
    path: '/api/v2/projects',
    input: readProjectBody,
    handler: async ({ res, input: body, context: owner }) =>
      sendJson(res, await createRepositoryProject(owner, body, JSON.stringify(body)), 202),
  }),
];

const projectsDispatch = dispatch(projectsRoutes);

export async function projectsApi(req: IncomingMessage, res: ServerResponse, owner: string) {
  return projectsDispatch(req, res, owner);
}
