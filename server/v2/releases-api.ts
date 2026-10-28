import type { IncomingMessage, ServerResponse } from 'node:http';
import { CoordinatorReleaseRuntime } from './releases-runtime.ts';
import {
  approvalRules,
  projectReleases,
  projectRollbacks,
  ProjectReleaseService,
  putApprovalRules,
  releaseById,
} from './releases.ts';
import { projectsForOwner, resolveProject } from './projects.ts';
import { fail } from './inbox.ts';

const watchMs = process.env.DEPLOY_RELEASE_WATCH_MS
  ? Number(process.env.DEPLOY_RELEASE_WATCH_MS)
  : undefined;
export const projectReleaseService = new ProjectReleaseService(new CoordinatorReleaseRuntime(), {
  watchMs,
});
projectReleaseService.registerInbox();

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65_536) {
      req.resume();
      fail('Request body too large', 413);
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    fail('Invalid JSON');
  }
}

export async function releasesApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
): Promise<boolean> {
  const url = new URL(req.url!, 'http://localhost');
  const path = url.pathname.slice('/api/v2'.length);
  const projectRoute = path.match(/^\/projects\/([^/]+)\/(releases|rollback|rollbacks)$/);
  const releaseRoute = path.match(/^\/releases\/([^/]+)$/);
  if (path !== '/projects' && path !== '/approvals' && !projectRoute && !releaseRoute) return false;
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
    return true;
  };
  try {
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      return send({ error: 'Only a signed-in person can start releases or change approvals' }, 403);
    if (path === '/projects' && req.method === 'GET')
      return send({ projects: await projectsForOwner(owner) });
    if (path === '/approvals') {
      if (req.method === 'GET') return send({ rules: approvalRules(owner) });
      if (req.method === 'PUT')
        return send({ rules: putApprovalRules(owner, (await readBody(req)).rules) });
    }
    if (releaseRoute && req.method === 'GET') {
      const project = url.searchParams.get('project');
      const projectId = project ? (await resolveProject(owner, project)).id : undefined;
      return send({ release: releaseById(owner, decodeURIComponent(releaseRoute[1]), projectId) });
    }
    if (projectRoute) {
      const project = await resolveProject(owner, decodeURIComponent(projectRoute[1]));
      if (req.method === 'GET' && projectRoute[2] === 'releases')
        return send({ releases: projectReleases(owner, project.id) });
      if (req.method === 'GET' && projectRoute[2] === 'rollbacks')
        return send({ rollbacks: projectRollbacks(owner, project.id) });
      if (req.method === 'POST' && projectRoute[2] === 'releases')
        return send(
          { release: projectReleaseService.ship(owner, project, await readBody(req)) },
          202,
        );
      if (req.method === 'POST' && projectRoute[2] === 'rollback')
        return send(projectReleaseService.rollback(owner, project, await readBody(req)), 202);
    }
    return send({ error: 'Method not allowed' }, 405);
  } catch (error: any) {
    return send(
      { error: error.message, ...(error.dataLoss ? { dataLoss: error.dataLoss } : {}) },
      error.status || 400,
    );
  }
}
