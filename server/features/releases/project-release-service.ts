import type { AppHealth } from '../../../shared/v2/contracts.ts';
import { SelfReleaseRuntime } from '../updates/self-release-runtime.ts';
import { currentProjectReleases, ProjectReleaseService } from '../../v2/releases.ts';
import { resolveProject } from '../repositories/projects.ts';

const watchMs = process.env.DEPLOY_RELEASE_WATCH_MS
  ? Number(process.env.DEPLOY_RELEASE_WATCH_MS)
  : undefined;
export const projectReleaseService = new ProjectReleaseService(new SelfReleaseRuntime(), {
  watchMs,
});
projectReleaseService.registerInbox();
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
