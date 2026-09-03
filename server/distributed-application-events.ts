import {
  appendLocalFleetEvent,
  ensureFleetIdentity,
  resolveLocalSiteId,
  sortableId,
} from './multisite.ts';
import { getArtifact } from './content-store.ts';
import { getApplicationSpecRevision, getDeployment, getSqlite } from './store.ts';
import { arch } from 'node:os';

/** Publish the exact immutable graph only after its local runtime has become active. */
export function publishActivatedApplicationRevision(
  deploymentName: string,
  actor: string,
): { eventId: string; originSequence: number } {
  const deployment = getDeployment(deploymentName);
  if (!deployment?.appId || !deployment.activeSpecDigest) {
    throw new Error(
      'Active application identity and revision are required before fleet publication',
    );
  }
  const revision = getApplicationSpecRevision(deploymentName, deployment.activeSpecDigest);
  if (!revision) throw new Error('Active immutable application revision not found');
  const suitcaseCandidate = process.env.DEPLOY_SUITCASE === '1';
  const originSiteId = resolveLocalSiteId();
  if (suitcaseCandidate) {
    const fleet = ensureFleetIdentity();
    const now = new Date().toISOString();
    getSqlite()!
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, active_release_digest, desired_release_digest,
           runtime_status, data_mode, sync_policy, shared_lineage, readiness,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', 'site-local', 'none', 0, '{}', ?, ?)
         ON CONFLICT(app_id, site_id) DO UPDATE SET
           active_release_digest = excluded.active_release_digest,
           desired_release_digest = excluded.desired_release_digest,
           runtime_status = 'running', removed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        sortableId('replica'),
        deployment.appId,
        originSiteId,
        revision.digest,
        revision.digest,
        now,
        now,
      );
    getSqlite()!
      .prepare(
        `INSERT OR IGNORE INTO application_aliases
          (fleet_id, alias, app_id, origin_site_id, state, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(fleet.id, deploymentName, deployment.appId, originSiteId, now);
  }
  const event = appendLocalFleetEvent({
    originSiteId,
    appId: deployment.appId,
    actor,
    operation: suitcaseCandidate
      ? 'application.offline.release.candidate'
      : 'application.revision.activated',
    authorityEpoch: deployment.releaseAuthorityEpoch || 1,
    generation: deployment.releaseGeneration || 0,
    payload: {
      name: deploymentName,
      appId: deployment.appId,
      specDigest: revision.digest,
      parentDigest: revision.parentDigest || null,
      apiVersion: revision.apiVersion,
      manifestFormat: revision.manifestFormat,
      normalizedSpec: revision.normalizedSpec,
      configurationDigest: deployment.configurationDigest || null,
      source: revision.source,
      sourceArtifactDigest: deployment.sourceArtifactDigest || null,
      imageArtifactDigest: deployment.imageArtifactDigest || null,
      snapshotArtifactDigest: deployment.snapshotArtifactDigest || null,
      baseAuthorityEpoch: deployment.releaseAuthorityEpoch || 1,
      baseGeneration: deployment.releaseGeneration || 0,
      architecture: arch(),
      candidateKind: suitcaseCandidate ? 'offline-application-revision' : null,
    },
    artifactDigests: [
      deployment.sourceArtifactDigest,
      deployment.imageArtifactDigest,
      deployment.snapshotArtifactDigest,
    ].filter((value): value is string => Boolean(value && getArtifact(value))),
  });
  return { eventId: event.eventId, originSequence: event.originSequence };
}
