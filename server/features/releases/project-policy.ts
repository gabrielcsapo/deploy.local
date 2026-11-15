import { db, list, save } from '../../workspace/store.ts';
import { fail } from '../../kernel/errors.ts';
import type { Project } from '../../../shared/v2/contracts.ts';

export type ProjectReleasePolicy = {
  keepReleases: number;
  verifyMigrations: boolean;
  installThroughDeploy: boolean;
};
export function projectReleasePolicy(owner: string, projectId: string): ProjectReleasePolicy {
  const row = list('v2-project-policy', owner).find((row) => row.id === projectId);
  return {
    keepReleases: row?.keepReleases ?? 5,
    verifyMigrations: row?.verifyMigrations ?? true,
    installThroughDeploy: row?.installThroughDeploy ?? true,
  };
}
export function assertProjectWritable(owner: string, project: Project) {
  if (list('v2-project-removal', owner).some((row) => row.id === project.id))
    fail('This project is being removed', 409);
  if (
    list('v2-project-run', owner).some(
      (row) =>
        row.id === project.id ||
        row.apps.some((app: string) => project.apps.some((entry) => entry.id === app)),
    )
  )
    fail('A release or rollback is running; try again after it finishes', 409);
}
export function putProjectReleasePolicy(owner: string, project: Project, body: any) {
  return db
    .transaction(() => {
      assertProjectWritable(owner, project);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !Object.keys(body).length ||
        Object.keys(body).some(
          (key) => !['keepReleases', 'verifyMigrations', 'installThroughDeploy'].includes(key),
        )
      )
        fail('Invalid release preferences');
      if (
        body.keepReleases !== undefined &&
        (!Number.isInteger(body.keepReleases) || body.keepReleases < 1 || body.keepReleases > 100)
      )
        fail('Keep between 1 and 100 earlier releases');
      if (body.verifyMigrations !== undefined && typeof body.verifyMigrations !== 'boolean')
        fail('verifyMigrations must be a boolean');
      if (body.installThroughDeploy !== undefined && typeof body.installThroughDeploy !== 'boolean')
        fail('installThroughDeploy must be a boolean');
      const policy = { ...projectReleasePolicy(owner, project.id), ...body };
      save('v2-project-policy', owner, { id: project.id, ...policy });
      retainProjectReleases(owner, project.id, policy.keepReleases);
      return policy;
    })
    .immediate();
}

// Keep the current release and N prior activation receipts available for rollback.
// Audit history and backup receipts survive expiration; expired code cannot be a target.
export function retainProjectReleases(
  owner: string,
  projectId: string,
  keep = projectReleasePolicy(owner, projectId).keepReleases,
) {
  const current = list('v2-project-current', owner).find((row) => row.id === projectId)?.releaseId;
  const prior = list('v2-release', owner)
    .filter(
      (row) =>
        row.release.projectId === projectId &&
        row.id !== current &&
        ['superseded', 'rolled-back'].includes(row.release.state) &&
        row.plan,
    )
    .reverse();
  for (const row of prior.slice(keep)) {
    const { plan: _plan, ...retained } = row;
    save('v2-release', owner, { ...retained, codeExpiredAt: new Date().toISOString() });
  }
}
