import { dispatch, routes } from '../kernel/routes.ts';
import { releaseBuildOutput } from './release-build-log.ts';
import { sendJson } from '../kernel/http.ts';
import { readJson } from '../kernel/http.ts';
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
    const route = routes<undefined>();
    return await dispatch(
      [
        route({
          method: 'GET',
          path: '/projects',
          handler: async () => send({ projects: await projectsForOwner(owner, true) }),
        }),
        route({
          method: 'GET',
          path: '/approvals',
          handler: () => send({ rules: approvalRules(owner) }),
        }),
        route({
          method: 'PUT',
          path: '/approvals',
          handler: async () =>
            send({
              rules: putApprovalRules(
                owner,
                (
                  await readJson(req, 65536, {
                    tooLarge: 'Request body too large',
                    preserveReadErrors: true,
                  })
                ).rules,
              ),
            }),
        }),
        route({
          method: 'GET',
          path: '/releases/uploads/:id([0-9]+)',
          handler: ({ params }) => {
            const record = list('v2-upload-release', owner).find((entry) => entry.id === params.id);
            return send({ release: record ? releaseById(owner, record.releaseId) : null });
          },
        }),
        route({
          method: 'GET',
          path: '/releases/:rest*',
          handler: async () => {
            if (!releaseRoute) return false;
            const project = url.searchParams.get('project');
            const projectId = project ? (await resolveProject(owner, project, true)).id : undefined;
            const release = releaseById(owner, decodeURIComponent(releaseRoute[1]), projectId);
            if (releaseRoute[2] === 'output')
              return send({ output: await releaseBuildOutput(owner, release.id) });
            return send({ release });
          },
        }),
        route({
          method: '*',
          path: '/projects/:rest*',
          handler: async () => {
            if (!projectRoute) return false;
            // Even unsupported methods resolve the project after the recovery wait.
            const project = await resolveProject(
              owner,
              decodeURIComponent(projectRoute[1]),
              req.method === 'GET',
            );
            return dispatch(
              [
                route({
                  method: 'GET',
                  path: '/projects/:project/releases',
                  handler: () => send({ releases: projectReleases(owner, project.id) }),
                }),
                route({
                  method: 'GET',
                  path: '/projects/:project/rollbacks',
                  handler: () => send({ rollbacks: projectRollbacks(owner, project.id) }),
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/releases/plan',
                  handler: () => send({ plan: releaseChoices(owner, project) }),
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/releases',
                  handler: async () => {
                    const body = await readJson(req, 65536, {
                      tooLarge: 'Request body too large',
                      preserveReadErrors: true,
                    });
                    if (body.choices !== undefined)
                      body.choices = validateReleaseChoices(owner, project, body.choices);
                    return send({ release: projectReleaseService.ship(owner, project, body) }, 202);
                  },
                }),
                route({
                  method: 'POST',
                  path: '/projects/:project/rollback',
                  handler: async () =>
                    send(
                      projectReleaseService.rollback(
                        owner,
                        project,
                        await readJson(req, 65536, {
                          tooLarge: 'Request body too large',
                          preserveReadErrors: true,
                        }),
                      ),
                      202,
                    ),
                }),
              ],
              { path: () => path },
            )(req, res, undefined);
          },
        }),
      ],
      { path: () => path, notFound: () => send({ error: 'Method not allowed' }, 405) },
    )(req, res, undefined);
  } catch (error: any) {
    return send(
      { error: error.message, ...(error.dataLoss ? { dataLoss: error.dataLoss } : {}) },
      error.status || 400,
    );
  }
}
