import { save } from '../workspace/store.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { projectReleaseService } from './releases-api.ts';
import { projectsForOwner } from './projects.ts';
import { releaseById } from './releases.ts';
import { fail } from '../kernel/errors.ts';

/** Upload retains its existing source/CI admission; runtime work belongs to the whole project. */
export async function shipUploadedProject(
  owner: string,
  application: string,
  source: { kind: 'cli' | 'ship' | 'pipeline'; ref: string },
  buildLogId?: number,
  releaseAdmission?: () => unknown,
) {
  const project = (await projectsForOwner(owner)).find((entry) =>
    entry.apps.some((app) => app.name === application),
  );
  if (!project) fail('Project for the uploaded app was not found', 409);
  releaseAdmission?.();
  const accepted = projectReleaseService.ship(owner, project, { source });
  if (buildLogId !== undefined)
    save('v2-upload-release', owner, { id: String(buildLogId), releaseId: accepted.id });
  for (;;) {
    const release = releaseById(owner, accepted.id, project.id);
    if (release.state !== 'running') {
      if (release.state !== 'live')
        throw Object.assign(
          new Error(
            release.steps.find((step) => step.state === 'failed')?.detail ||
              'Project release failed',
          ),
          {
            status: 422,
            runtimeUnchanged:
              release.steps.find((step) => step.name === 'activate')?.state === 'skipped',
          },
        );
      return release;
    }
    await delay(100);
  }
}
