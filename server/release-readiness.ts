import { existsSync, readFileSync } from 'node:fs';
import { certsExist } from './certs.ts';
import { getArtifact } from './content-store.ts';
import { listCheckpointRetentionBlockers } from './data-reconciliation.ts';
import { getSqlite } from './store.ts';

export interface ReleaseGateCheck {
  id: string;
  status: 'pass' | 'block' | 'warning';
  message: string;
  evidence: string[];
}

export interface V1ReleaseReadiness {
  ready: boolean;
  createdAt: string;
  checks: ReleaseGateCheck[];
}

export function evaluateV1ReleaseReadiness(): V1ReleaseReadiness {
  const sqlite = getSqlite()!;
  const checks: ReleaseGateCheck[] = [];
  const deployments = sqlite.prepare('SELECT * FROM deployments ORDER BY name').all() as Array<
    Record<string, unknown>
  >;
  const identityGaps = deployments.filter(
    (deployment) => !deployment.app_id || !deployment.active_spec_digest,
  );
  checks.push({
    id: 'CUTOVER.APPLICATION_IDENTITIES_AND_SPECS',
    status: identityGaps.length === 0 ? 'pass' : 'block',
    message:
      identityGaps.length === 0
        ? 'Every legacy application has a stable identity and active immutable v1 revision.'
        : `${identityGaps.length} application(s) still lack a stable identity or active v1 revision.`,
    evidence: identityGaps.map((deployment) => String(deployment.name)),
  });

  const fleet = sqlite.prepare('SELECT id, home_site_id FROM fleets LIMIT 1').get() as
    | { id: string; home_site_id: string }
    | undefined;
  const homeIdentity = fleet
    ? sqlite
        .prepare(
          "SELECT id FROM sites WHERE id = ? AND fleet_id = ? AND kind = 'home' AND revoked_at IS NULL",
        )
        .get(fleet.home_site_id, fleet.id)
    : undefined;
  checks.push({
    id: 'CUTOVER.FLEET_TRUST',
    status: fleet && homeIdentity && certsExist() ? 'pass' : 'block',
    message:
      fleet && homeIdentity && certsExist()
        ? 'Fleet, Home signing identity, and TLS trust anchor are present.'
        : 'Fleet/Home identity or TLS trust material is missing.',
    evidence: fleet ? [fleet.id, fleet.home_site_id, `tls=${certsExist()}`] : [],
  });
  const aliasGaps = deployments.filter((deployment) => {
    if (!deployment.app_id) return true;
    return !sqlite
      .prepare(
        `SELECT 1 FROM application_aliases
          WHERE app_id = ? AND alias = ? AND state = 'active'`,
      )
      .get(deployment.app_id, deployment.name);
  });
  checks.push({
    id: 'CUTOVER.URL_ALIASES',
    status: aliasGaps.length === 0 ? 'pass' : 'block',
    message:
      aliasGaps.length === 0
        ? 'Every application URL alias resolves to its stable identity.'
        : `${aliasGaps.length} URL alias(es) are not preserved.`,
    evidence: aliasGaps.map((deployment) => String(deployment.name)),
  });

  const suitcaseReadinessGaps = (
    sqlite
      .prepare(
        `SELECT r.app_id, r.site_id, r.runtime_status, r.readiness
           FROM app_replicas r
           JOIN sites s ON s.id = r.site_id
          WHERE r.removed_at IS NULL AND s.kind = 'suitcase' AND s.revoked_at IS NULL`,
      )
      .all() as Array<{
      app_id: string;
      site_id: string;
      runtime_status: string;
      readiness: string;
    }>
  ).filter((replica) => {
    try {
      return JSON.parse(replica.readiness).readyOffline !== true;
    } catch {
      return true;
    }
  });
  checks.push({
    id: 'CUTOVER.SUITCASE_READINESS',
    status: suitcaseReadinessGaps.length === 0 ? 'pass' : 'block',
    message:
      suitcaseReadinessGaps.length === 0
        ? 'Every selected active suitcase replica has a complete Ready offline certificate.'
        : `${suitcaseReadinessGaps.length} selected suitcase replica(s) are not Ready offline.`,
    evidence: suitcaseReadinessGaps.map(
      (replica) => `${replica.app_id}@${replica.site_id}:${replica.runtime_status}`,
    ),
  });

  const runningCatalogOperations = sqlite
    .prepare("SELECT id, operation FROM catalog_operations WHERE status = 'running'")
    .all() as Array<{ id: string; operation: string }>;
  checks.push({
    id: 'CUTOVER.CATALOG_OPERATIONS',
    status: runningCatalogOperations.length === 0 ? 'pass' : 'block',
    message:
      runningCatalogOperations.length === 0
        ? 'No catalog transaction is mid-flight.'
        : `${runningCatalogOperations.length} catalog operation(s) are still running.`,
    evidence: runningCatalogOperations.map((operation) => `${operation.id}:${operation.operation}`),
  });

  const opaqueSnapshotGaps: string[] = [];
  const opaqueSnapshots = sqlite
    .prepare(
      `SELECT id, manifest_artifact_digest FROM volume_snapshots
        WHERE latest_home_recovery = 1 AND verification_status = 'verified'`,
    )
    .all() as Array<{ id: string; manifest_artifact_digest: string }>;
  for (const snapshot of opaqueSnapshots) {
    const manifest = getArtifact(snapshot.manifest_artifact_digest);
    if (!manifest) {
      opaqueSnapshotGaps.push(`${snapshot.id}:manifest-missing`);
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(manifest.localPath, 'utf8')) as {
        resources?: Array<{ archiveArtifactDigest?: string }>;
      };
      for (const resource of parsed.resources ?? []) {
        if (!resource.archiveArtifactDigest || !getArtifact(resource.archiveArtifactDigest))
          opaqueSnapshotGaps.push(
            `${snapshot.id}:${resource.archiveArtifactDigest || 'archive-missing'}`,
          );
      }
    } catch {
      opaqueSnapshotGaps.push(`${snapshot.id}:manifest-invalid`);
    }
  }
  checks.push({
    id: 'CUTOVER.OPAQUE_RECOVERY',
    status: opaqueSnapshotGaps.length === 0 ? 'pass' : 'block',
    message:
      opaqueSnapshotGaps.length === 0
        ? 'Every retained Follows one site recovery snapshot has its immutable artifacts.'
        : `${opaqueSnapshotGaps.length} opaque recovery artifact(s) are unavailable.`,
    evidence: opaqueSnapshotGaps,
  });
  const revisionGaps = deployments.filter((deployment) => {
    if (!deployment.active_spec_digest) return true;
    return !sqlite
      .prepare('SELECT 1 FROM application_spec_revisions WHERE deployment_name = ? AND digest = ?')
      .get(deployment.name, deployment.active_spec_digest);
  });
  checks.push({
    id: 'CUTOVER.REVISION_REBUILD',
    status: revisionGaps.length === 0 ? 'pass' : 'block',
    message:
      revisionGaps.length === 0
        ? 'All active application projections can be rebuilt from canonical revisions.'
        : `${revisionGaps.length} active revision(s) are missing.`,
    evidence: revisionGaps.map((deployment) => String(deployment.name)),
  });

  const corruptArtifacts = (
    sqlite.prepare('SELECT digest, local_path, verification_status FROM artifacts').all() as Array<{
      digest: string;
      local_path: string;
      verification_status: string;
    }>
  ).filter(
    (artifact) =>
      artifact.verification_status !== 'verified' ||
      !existsSync(artifact.local_path) ||
      !getArtifact(artifact.digest),
  );
  checks.push({
    id: 'CUTOVER.ARTIFACT_INTEGRITY',
    status: corruptArtifacts.length === 0 ? 'pass' : 'block',
    message:
      corruptArtifacts.length === 0
        ? 'No retained artifact is known missing or corrupt.'
        : `${corruptArtifacts.length} retained artifact(s) are missing or corrupt.`,
    evidence: corruptArtifacts.map((artifact) => artifact.digest),
  });

  const recovery = sqlite
    .prepare(
      `SELECT id, inventory_digest, verified_at, rehearsal_status, rehearsed_at
         FROM fleet_recovery_bundles
        WHERE verification_status = 'verified' ORDER BY verified_at DESC LIMIT 1`,
    )
    .get() as
    | {
        id: string;
        inventory_digest: string;
        verified_at: string;
        rehearsal_status: string | null;
        rehearsed_at: string | null;
      }
    | undefined;
  const configuredRecoveryMaxAgeDays = Number(process.env.DEPLOY_RECOVERY_MAX_AGE_DAYS);
  const recoveryMaxAgeDays =
    Number.isFinite(configuredRecoveryMaxAgeDays) && configuredRecoveryMaxAgeDays > 0
      ? configuredRecoveryMaxAgeDays
      : 7;
  const recoveryFresh =
    recovery &&
    Number.isFinite(Date.parse(recovery.verified_at)) &&
    Date.now() - Date.parse(recovery.verified_at) <= recoveryMaxAgeDays * 24 * 60 * 60 * 1000;
  checks.push({
    id: 'CUTOVER.RECOVERY_BOUNDARY',
    status: recoveryFresh && recovery?.rehearsal_status === 'passed' ? 'pass' : 'block',
    message:
      recoveryFresh && recovery?.rehearsal_status === 'passed'
        ? `A verified and rehearsed encrypted Home recovery boundary is within the ${recoveryMaxAgeDays}-day freshness policy.`
        : recovery
          ? !recoveryFresh
            ? `The latest verified recovery boundary is older than the ${recoveryMaxAgeDays}-day freshness policy.`
            : 'The latest verified recovery boundary has not passed a clean-Home restore rehearsal.'
          : 'Create and independently verify an encrypted Home recovery bundle before cutover.',
    evidence: recovery
      ? [
          recovery.id,
          recovery.inventory_digest,
          recovery.verified_at,
          `rehearsal=${recovery.rehearsal_status || 'not-run'}`,
          ...(recovery.rehearsed_at ? [recovery.rehearsed_at] : []),
        ]
      : [],
  });

  const apps = deployments
    .filter((deployment) => Boolean(deployment.app_id))
    .map((deployment) => String(deployment.app_id));
  const retention = apps.flatMap((appId) =>
    listCheckpointRetentionBlockers(appId).filter(
      (checkpoint) => checkpoint.waitingForSiteIds.length > 0,
    ),
  );
  checks.push({
    id: 'CUTOVER.CHECKPOINT_RETENTION',
    status: retention.length === 0 ? 'pass' : 'warning',
    message:
      retention.length === 0
        ? 'Checkpoint acknowledgement does not block current retention.'
        : `${retention.length} checkpoint(s) remain pinned for live replicas; preserve them through the soak.`,
    evidence: retention.map(
      (checkpoint) => `${checkpoint.checkpointId}:${checkpoint.waitingForSiteIds.join(',')}`,
    ),
  });

  const databaseIntegrity = sqlite.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const foreignKeys = sqlite.pragma('foreign_key_check') as unknown[];
  const databaseValid =
    databaseIntegrity.length === 1 &&
    databaseIntegrity[0]?.integrity_check === 'ok' &&
    foreignKeys.length === 0;
  checks.push({
    id: 'CUTOVER.CONTROL_DATABASE',
    status: databaseValid ? 'pass' : 'block',
    message: databaseValid
      ? 'Control-plane integrity and foreign-key checks pass.'
      : 'Control-plane database validation failed.',
    evidence: databaseValid ? ['integrity_check=ok', 'foreign_key_check=0'] : [],
  });

  return {
    ready: checks.every((check) => check.status !== 'block'),
    createdAt: new Date().toISOString(),
    checks,
  };
}
