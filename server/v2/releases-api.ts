import { releaseBuildOutput } from './release-build-log.ts';
import { sendJson } from '../http.ts';
import { readJson } from '../http.ts';
import { list } from '../workspace/store.ts';
import type { AppHealth } from '../../shared/v2/contracts.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SelfReleaseRuntime } from './self-release-runtime.ts';
import {
  approvalRules,
  currentProjectReleases,
  projectReleases,
  projectRollbacks,
  ProjectReleaseService,
  putApprovalRules,
  releaseById,
} from './releases.ts';
import { releaseChoices, validateReleaseChoices } from './releases-plan.ts';
import { projectsForOwner, resolveProject } from './projects.ts';

const watchMs = process.env.DEPLOY_RELEASE_WATCH_MS
  ? Number(process.env.DEPLOY_RELEASE_WATCH_MS)
  : undefined;
export const projectReleaseService = new ProjectReleaseService(new SelfReleaseRuntime(), {
  watchMs,
});
projectReleaseService.registerInbox();
let recovery: Promise<void> | undefined;
export function recoverProjectReleases() {
  return (recovery ??= projectReleaseService.recover().finally(() => {
    setInterval(
      () =>
        void projectReleaseService
          .retryCleanup()
          .catch((error) => console.error('[releases] cleanup retry failed:', error)),
      60_000,
    ).unref();
  }));
}

/** Resolve private project context before entering the synchronous inbox answer transaction. */
export async function requestWorkerRollback(owner: string, app: AppHealth, now = Date.now()) {
  if (app.kind !== 'worker' || app.state !== 'failing') return;
  const record = currentProjectReleases(owner).find((record) =>
    record.release.apps.some((entry) => entry.appId === app.appId),
  );
  if (!record?.releasedAt || !record.previousId) return;
  const age = now - Date.parse(record.releasedAt);
  if (!(age >= 0 && age < 3600_000)) return;
  const project = record.project ?? (await resolveProject(owner, record.release.projectId));
  // A lookup may have yielded while another release activated. Never approve stale evidence.
  if (!currentProjectReleases(owner).some((current) => current.id === record.id)) return;
  try {
    return projectReleaseService.requestAutoRollback(owner, project, app.summary);
  } catch (error: any) {
    // A release/rollback in progress will be checked again by the next report or Live refresh.
    if (error.status !== 409) throw error;
  }
}

export async function releasesApi(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
): Promise<boolean> {
  const url = new URL(req.url!, 'http://localhost');
  const path = url.pathname.slice('/api/v2'.length);
  const projectRoute = path.match(
    /^\/projects\/([^/]+)\/(releases(?:\/plan)?|rollback|rollbacks)$/,
  );
  const uploadRoute = path.match(/^\/releases\/uploads\/([0-9]+)$/);
  const releaseRoute = path.match(/^\/releases\/([^/]+)(?:\/(output))?$/);
  if (
    path !== '/projects' &&
    path !== '/approvals' &&
    !projectRoute &&
    !releaseRoute &&
    !uploadRoute
  )
    return false;
  const send = (value: unknown, status = 200) => sendJson(res, value, status);
  try {
    if (req.headers['x-deploy-agent-token'] || req.headers['x-deploy-worker-token'])
      return send({ error: 'Only a signed-in person can start releases or change approvals' }, 403);
    // Recovery can wait on a computer for minutes after a restart. Reads show the saved
    // records as they are; only changes wait, so nothing starts on top of a recovering release.
    if (req.method !== 'GET') await recoverProjectReleases();
    if (path === '/projects' && req.method === 'GET')
      return send({ projects: await projectsForOwner(owner, true) });
    if (path === '/approvals') {
      if (req.method === 'GET') return send({ rules: approvalRules(owner) });
      if (req.method === 'PUT')
        return send({
          rules: putApprovalRules(
            owner,
            (
              await readJson(req, 65536, {
                tooLarge: 'Request body too large',
                preserveReadErrors: true,
              })
            ).rules,
          ),
        });
    }
    if (uploadRoute && req.method === 'GET') {
      const record = list('v2-upload-release', owner).find((entry) => entry.id === uploadRoute[1]);
      return send({ release: record ? releaseById(owner, record.releaseId) : null });
    }
    if (releaseRoute && req.method === 'GET') {
      const project = url.searchParams.get('project');
      const projectId = project
        ? (await resolveProject(owner, project, req.method === 'GET')).id
        : undefined;
      const release = releaseById(owner, decodeURIComponent(releaseRoute[1]), projectId);
      if (releaseRoute[2] === 'output')
        return send({ output: await releaseBuildOutput(owner, release.id) });
      return send({ release });
    }
    if (projectRoute) {
      const project = await resolveProject(
        owner,
        decodeURIComponent(projectRoute[1]),
        req.method === 'GET',
      );
      if (req.method === 'GET' && projectRoute[2] === 'releases')
        return send({ releases: projectReleases(owner, project.id) });
      if (req.method === 'GET' && projectRoute[2] === 'rollbacks')
        return send({ rollbacks: projectRollbacks(owner, project.id) });
      if (req.method === 'POST' && projectRoute[2] === 'releases/plan')
        return send({ plan: releaseChoices(owner, project) });
      if (req.method === 'POST' && projectRoute[2] === 'releases') {
        const body = await readJson(req, 65536, {
          tooLarge: 'Request body too large',
          preserveReadErrors: true,
        });
        if (body.choices !== undefined)
          body.choices = validateReleaseChoices(owner, project, body.choices);
        return send({ release: projectReleaseService.ship(owner, project, body) }, 202);
      }
      if (req.method === 'POST' && projectRoute[2] === 'rollback')
        return send(
          projectReleaseService.rollback(
            owner,
            project,
            await readJson(req, 65536, {
              tooLarge: 'Request body too large',
              preserveReadErrors: true,
            }),
          ),
          202,
        );
    }
    return send({ error: 'Method not allowed' }, 405);
  } catch (error: any) {
    return send(
      { error: error.message, ...(error.dataLoss ? { dataLoss: error.dataLoss } : {}) },
      error.status || 400,
    );
  }
}
