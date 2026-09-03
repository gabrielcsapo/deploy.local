import { createHash } from 'node:crypto';
import {
  emptyApplicationSpec,
  planApplicationChange,
  type ApplicationChangePlan,
} from './application-plan.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';
import { appendLocalFleetEvent, ensureFleetIdentity, sortableId } from './multisite.ts';
import { refreshDeploymentInCache, getSqlite } from './store.ts';

export type MaterializationCapability =
  | 'runtime'
  | 'build'
  | 'data'
  | 'access'
  | 'identity'
  | 'release'
  | 'rollback';

export interface MaterializationUpdate {
  appId: string;
  siteId: string;
  capability: MaterializationCapability;
  desiredDigest?: string;
  availableDigest?: string;
  desiredGeneration?: number;
  availableGeneration?: number;
  state: 'ready' | 'syncing' | 'missing' | 'invalid' | 'blocked' | 'unknown';
  blockers?: string[];
  evidence?: unknown[];
  verifiedAt?: string;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`;
}

export function updateMaterialization(input: MaterializationUpdate): void {
  getSqlite()!
    .prepare(
      `INSERT INTO app_materialization
        (app_id, site_id, capability, desired_digest, available_digest,
         desired_generation, available_generation, state, blockers, evidence, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(app_id, site_id, capability) DO UPDATE SET
         desired_digest = excluded.desired_digest,
         available_digest = excluded.available_digest,
         desired_generation = excluded.desired_generation,
         available_generation = excluded.available_generation,
         state = excluded.state,
         blockers = excluded.blockers,
         evidence = excluded.evidence,
         verified_at = excluded.verified_at`,
    )
    .run(
      input.appId,
      input.siteId,
      input.capability,
      input.desiredDigest || null,
      input.availableDigest || null,
      input.desiredGeneration ?? null,
      input.availableGeneration ?? null,
      input.state,
      JSON.stringify(input.blockers || []),
      JSON.stringify(input.evidence || []),
      input.verifiedAt || (input.state === 'ready' ? new Date().toISOString() : null),
    );
  invalidateReadinessCertificates(
    input.appId,
    input.siteId,
    `${input.capability} materialization changed`,
  );
}

export function evaluateReplicaReadiness(input: {
  appId: string;
  siteId: string;
  specDigest: string;
  checkpointId?: string;
  analyzerVersion: string;
  requireBuild?: boolean;
  expiresAt?: string;
}): {
  certificateId: string;
  runtimeReady: boolean;
  buildReady: boolean;
  dataReady: boolean;
  accessReady: boolean;
  blockers: string[];
} {
  const sqlite = getSqlite()!;
  const materializations = sqlite
    .prepare('SELECT * FROM app_materialization WHERE app_id = ? AND site_id = ?')
    .all(input.appId, input.siteId) as Array<Record<string, unknown>>;
  const byCapability = new Map(materializations.map((row) => [String(row.capability), row]));
  const ready = (capability: MaterializationCapability) => {
    const row = byCapability.get(capability);
    return (
      row?.state === 'ready' &&
      (!row.desired_digest || row.desired_digest === row.available_digest) &&
      (row.desired_generation === null ||
        row.desired_generation === undefined ||
        row.desired_generation === row.available_generation)
    );
  };
  const requiredCapabilities = new Set<string>([
    'runtime',
    'data',
    'access',
    'identity',
    'release',
    ...(input.requireBuild ? ['build'] : []),
  ]);
  const blockers = materializations.flatMap((row) => {
    if (!requiredCapabilities.has(String(row.capability))) return [];
    if (row.state === 'ready') return [];
    const details = JSON.parse(String(row.blockers || '[]')) as string[];
    return details.length > 0
      ? details.map((detail) => `${String(row.capability)}: ${detail}`)
      : [`${String(row.capability)}: ${String(row.state)}`];
  });
  for (const required of ['runtime', 'data', 'access', 'identity', 'release'] as const) {
    if (!byCapability.has(required)) blockers.push(`${required}: no materialization evidence`);
  }
  if (input.requireBuild && !byCapability.has('build'))
    blockers.push('build: no no-network build evidence');
  const runtimeReady = ready('runtime') && ready('identity') && ready('release');
  const buildReady = ready('build');
  const dataReady = ready('data');
  const accessReady = ready('access');
  const facts = materializations.map((row) => ({
    capability: row.capability,
    desiredDigest: row.desired_digest,
    availableDigest: row.available_digest,
    desiredGeneration: row.desired_generation,
    availableGeneration: row.available_generation,
    state: row.state,
    evidence: JSON.parse(String(row.evidence || '[]')),
    verifiedAt: row.verified_at,
  }));
  const capabilityDigest = digest({
    appId: input.appId,
    siteId: input.siteId,
    specDigest: input.specDigest,
    checkpointId: input.checkpointId || null,
    analyzerVersion: input.analyzerVersion,
    facts,
  });
  const certificateId = sortableId('readiness');
  sqlite
    .prepare(
      `INSERT INTO readiness_certificates
        (id, app_id, site_id, spec_digest, checkpoint_id, capability_digest,
         analyzer_version, runtime_ready, build_ready, data_ready, access_ready,
         blockers, evidence, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      certificateId,
      input.appId,
      input.siteId,
      input.specDigest,
      input.checkpointId || null,
      capabilityDigest,
      input.analyzerVersion,
      runtimeReady ? 1 : 0,
      buildReady ? 1 : 0,
      dataReady ? 1 : 0,
      accessReady ? 1 : 0,
      JSON.stringify([...new Set(blockers)]),
      JSON.stringify(facts),
      new Date().toISOString(),
      input.expiresAt || null,
    );
  const summary = {
    certificateId,
    runtimeReady,
    buildReady,
    dataReady,
    accessReady,
    readyOffline:
      runtimeReady &&
      dataReady &&
      accessReady &&
      (!input.requireBuild || buildReady) &&
      blockers.length === 0,
    blockers: [...new Set(blockers)],
  };
  sqlite
    .prepare(
      'UPDATE app_replicas SET readiness = ?, updated_at = ? WHERE app_id = ? AND site_id = ?',
    )
    .run(JSON.stringify(summary), new Date().toISOString(), input.appId, input.siteId);
  return {
    certificateId,
    runtimeReady,
    buildReady,
    dataReady,
    accessReady,
    blockers: summary.blockers,
  };
}

export function invalidateReadinessCertificates(
  appId: string,
  siteId: string | undefined,
  reason: string,
): number {
  const now = new Date().toISOString();
  const result = siteId
    ? getSqlite()!
        .prepare(
          `UPDATE readiness_certificates
              SET invalidated_at = ?, invalidation_reason = ?
            WHERE app_id = ? AND site_id = ? AND invalidated_at IS NULL`,
        )
        .run(now, reason, appId, siteId)
    : getSqlite()!
        .prepare(
          `UPDATE readiness_certificates
              SET invalidated_at = ?, invalidation_reason = ?
            WHERE app_id = ? AND invalidated_at IS NULL`,
        )
        .run(now, reason, appId);
  return Number(result.changes);
}

export function createReleaseCandidate(input: {
  appId: string;
  originSiteId: string;
  actor: string;
  specDigest?: string;
  parentSpecDigest?: string;
  requestedAlias?: string;
  sourceArtifactDigest?: string;
  imageArtifactDigest?: string;
  snapshotArtifactDigest?: string;
  artifactDigests?: string[];
  configurationDigest?: string;
  architecture?: string;
}): string {
  const deployment = getSqlite()!
    .prepare('SELECT release_authority_epoch, release_generation FROM deployments WHERE app_id = ?')
    .get(input.appId) as
    | { release_authority_epoch: number; release_generation: number }
    | undefined;
  if (!deployment) throw new Error('Application not found');
  if (!input.specDigest && !input.sourceArtifactDigest && !input.imageArtifactDigest)
    throw new Error('A release candidate requires an application revision, source, or image');
  const artifacts = [
    ...(input.artifactDigests || []),
    input.sourceArtifactDigest,
    input.imageArtifactDigest,
    input.snapshotArtifactDigest,
  ].filter((value): value is string => Boolean(value));
  const id = sortableId('release');
  getSqlite()!
    .prepare(
      `INSERT INTO release_candidates
        (id, app_id, origin_site_id, actor, base_authority_epoch, base_generation,
         spec_digest, parent_spec_digest, requested_alias, source_artifact_digest,
         image_artifact_digest, snapshot_artifact_digest, artifact_digests,
         configuration_digest, architecture, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`,
    )
    .run(
      id,
      input.appId,
      input.originSiteId,
      input.actor,
      deployment.release_authority_epoch,
      deployment.release_generation,
      input.specDigest || null,
      input.parentSpecDigest || null,
      input.requestedAlias || null,
      input.sourceArtifactDigest || null,
      input.imageArtifactDigest || null,
      input.snapshotArtifactDigest || null,
      JSON.stringify([...new Set(artifacts)].sort()),
      input.configurationDigest || null,
      input.architecture || null,
      new Date().toISOString(),
    );
  return id;
}

export function evaluateReleaseCandidate(
  candidateId: string,
):
  | 'ready-to-promote'
  | 'stale-generation'
  | 'stale-authority'
  | 'missing-artifact'
  | 'blocked-change' {
  const sqlite = getSqlite()!;
  const candidate = sqlite
    .prepare('SELECT * FROM release_candidates WHERE id = ?')
    .get(candidateId) as Record<string, unknown> | undefined;
  if (!candidate) throw new Error('Release candidate not found');
  const deployment = sqlite
    .prepare(
      'SELECT name, release_authority_epoch, release_generation FROM deployments WHERE app_id = ?',
    )
    .get(candidate.app_id) as {
    name: string;
    release_authority_epoch: number;
    release_generation: number;
  };
  let state: ReturnType<typeof evaluateReleaseCandidate>;
  if (Number(candidate.base_authority_epoch) !== deployment.release_authority_epoch)
    state = 'stale-authority';
  else if (Number(candidate.base_generation) !== deployment.release_generation)
    state = 'stale-generation';
  else {
    let retainedArtifacts: unknown = [];
    try {
      retainedArtifacts = JSON.parse(String(candidate.artifact_digests || '[]'));
    } catch {
      retainedArtifacts = null;
    }
    const artifactManifestReady = Array.isArray(retainedArtifacts);
    const referenced = [
      ...(Array.isArray(retainedArtifacts) ? retainedArtifacts : []),
      candidate.source_artifact_digest,
      candidate.image_artifact_digest,
      candidate.snapshot_artifact_digest,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const verified = referenced.every((artifact) =>
      sqlite
        .prepare("SELECT 1 FROM artifacts WHERE digest = ? AND verification_status = 'verified'")
        .get(artifact),
    );
    const revisionReady = candidate.spec_digest
      ? Boolean(
          sqlite
            .prepare(
              `SELECT 1 FROM application_spec_revisions
                WHERE deployment_name = ? AND digest = ? AND parent_digest IS ?`,
            )
            .get(deployment.name, candidate.spec_digest, candidate.parent_spec_digest || null),
        )
      : true;
    if (!artifactManifestReady || !verified || !revisionReady) {
      state = 'missing-artifact';
    } else {
      const plan = planReleaseCandidateChange(candidateId);
      state = plan?.blocked ? 'blocked-change' : 'ready-to-promote';
    }
  }
  sqlite.prepare('UPDATE release_candidates SET state = ? WHERE id = ?').run(state, candidateId);
  return state;
}

export function promoteReleaseCandidate(input: {
  candidateId: string;
  actor: string;
  confirmDestructive?: boolean;
}): number {
  const sqlite = getSqlite()!;
  const fleet = ensureFleetIdentity();
  const candidate = sqlite
    .prepare('SELECT * FROM release_candidates WHERE id = ?')
    .get(input.candidateId) as Record<string, unknown> | undefined;
  if (!candidate) throw new Error('Release candidate not found');
  if (evaluateReleaseCandidate(input.candidateId) !== 'ready-to-promote')
    throw new Error(
      'Release candidate is not safe to promote from its recorded authority/generation base',
    );
  const changePlan = planReleaseCandidateChange(input.candidateId);
  if (changePlan?.blocked) throw new Error('Release candidate application change plan is blocked');
  if (changePlan?.destructive && input.confirmDestructive !== true) {
    throw new Error('Destructive release candidate changes require explicit confirmation');
  }
  const deploymentBefore = sqlite
    .prepare(
      `SELECT name, type, desired_spec_digest, active_spec_digest,
              release_authority_epoch, release_generation
         FROM deployments WHERE app_id = ?`,
    )
    .get(candidate.app_id) as
    | {
        name: string;
        type: string | null;
        desired_spec_digest: string | null;
        active_spec_digest: string | null;
        release_authority_epoch: number;
        release_generation: number;
      }
    | undefined;
  if (!deploymentBefore) throw new Error('Release candidate application no longer exists');
  const specDigest = candidate.spec_digest ? String(candidate.spec_digest) : null;
  const parentSpecDigest = candidate.parent_spec_digest
    ? String(candidate.parent_spec_digest)
    : null;
  const expectedParent =
    deploymentBefore.desired_spec_digest || deploymentBefore.active_spec_digest;
  if (specDigest && parentSpecDigest !== expectedParent) {
    throw new Error('Release candidate application revision is stale against its recorded parent');
  }
  const revision = specDigest
    ? (sqlite
        .prepare(
          `SELECT api_version, manifest_format, normalized_spec
             FROM application_spec_revisions WHERE deployment_name = ? AND digest = ?`,
        )
        .get(deploymentBefore.name, specDigest) as
        | { api_version: string; manifest_format: string; normalized_spec: string }
        | undefined)
    : undefined;
  if (specDigest && !revision) throw new Error('Release candidate application revision is missing');

  const retainedArtifacts = retainedCandidateArtifacts(candidate);
  const desiredDigest = String(
    candidate.image_artifact_digest || candidate.source_artifact_digest || specDigest,
  );
  const isNewOfflineApplication = deploymentBefore.type === 'fleet-candidate';
  const requestedAlias = candidate.requested_alias
    ? String(candidate.requested_alias)
    : deploymentBefore.name;
  if (isNewOfflineApplication) {
    if (!specDigest) throw new Error('A new offline application requires an immutable revision');
    assertPromotableAlias({
      fleetId: fleet.id,
      appId: String(candidate.app_id),
      alias: requestedAlias,
    });
  }
  const homeReplicaId = sortableId('replica');
  const promote = sqlite.transaction(() => {
    const deployment = sqlite
      .prepare(
        `SELECT name, type, desired_spec_digest, active_spec_digest,
                release_authority_epoch, release_generation
           FROM deployments WHERE app_id = ?`,
      )
      .get(candidate.app_id) as typeof deploymentBefore;
    if (!deployment) throw new Error('Release candidate application no longer exists');
    if (
      deployment.release_authority_epoch !== Number(candidate.base_authority_epoch) ||
      deployment.release_generation !== Number(candidate.base_generation)
    )
      throw new Error('Release authority changed during promotion');
    const currentParent = deployment.desired_spec_digest || deployment.active_spec_digest;
    if (specDigest && currentParent !== parentSpecDigest) {
      throw new Error('Application revision ancestry changed during promotion');
    }
    if (isNewOfflineApplication) {
      assertPromotableAlias({
        fleetId: fleet.id,
        appId: String(candidate.app_id),
        alias: requestedAlias,
      });
    }
    const generation = deployment.release_generation + 1;
    const updated = sqlite
      .prepare(
        `UPDATE deployments
            SET release_generation = ?, desired_release_digest = ?, desired_spec_digest = COALESCE(?, desired_spec_digest),
                source_artifact_digest = COALESCE(?, source_artifact_digest),
                image_artifact_digest = COALESCE(?, image_artifact_digest),
                snapshot_artifact_digest = COALESCE(?, snapshot_artifact_digest),
                configuration_digest = COALESCE(?, configuration_digest),
                spec_source = CASE WHEN ? IS NULL THEN spec_source ELSE 'offline' END,
                desired_node_id = CASE WHEN type = 'fleet-candidate' THEN 'coordinator' ELSE desired_node_id END,
                status = CASE WHEN type = 'fleet-candidate' THEN 'pending' ELSE status END,
                updated_at = ?
          WHERE app_id = ? AND release_authority_epoch = ? AND release_generation = ?`,
      )
      .run(
        generation,
        desiredDigest,
        specDigest,
        candidate.source_artifact_digest,
        candidate.image_artifact_digest,
        candidate.snapshot_artifact_digest,
        candidate.configuration_digest,
        specDigest,
        new Date().toISOString(),
        candidate.app_id,
        candidate.base_authority_epoch,
        candidate.base_generation,
      );
    if (updated.changes !== 1)
      throw new Error('Release promotion lost its optimistic concurrency race');
    if (specDigest) {
      sqlite
        .prepare(
          `INSERT INTO application_spec_transitions
            (deployment_name, from_digest, to_digest, source, created_by, created_at)
           VALUES (?, ?, ?, 'offline', ?, ?)`,
        )
        .run(deployment.name, parentSpecDigest, specDigest, input.actor, new Date().toISOString());
    }
    if (isNewOfflineApplication) {
      sqlite
        .prepare(
          `UPDATE application_aliases SET state = 'active'
            WHERE fleet_id = ? AND alias = ? AND app_id = ? AND state = 'reserved'`,
        )
        .run(fleet.id, requestedAlias, candidate.app_id);
    }
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, desired_release_digest, runtime_status, data_mode,
           sync_policy, shared_lineage, readiness, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 'site-local', 'none', 0, '{}', ?, ?)
         ON CONFLICT(app_id, site_id) DO UPDATE SET
           desired_release_digest = excluded.desired_release_digest,
           runtime_status = 'pending',
           data_mode = CASE WHEN ? = 1 THEN 'site-local' ELSE data_mode END,
           sync_policy = CASE WHEN ? = 1 THEN 'none' ELSE sync_policy END,
           shared_lineage = CASE WHEN ? = 1 THEN 0 ELSE shared_lineage END,
           removed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        homeReplicaId,
        candidate.app_id,
        fleet.homeSiteId,
        desiredDigest,
        now,
        now,
        isNewOfflineApplication ? 1 : 0,
        isNewOfflineApplication ? 1 : 0,
        isNewOfflineApplication ? 1 : 0,
      );
    sqlite
      .prepare(
        `UPDATE app_replicas SET desired_release_digest = ?, runtime_status = 'pending',
                updated_at = ? WHERE app_id = ? AND removed_at IS NULL`,
      )
      .run(desiredDigest, now, candidate.app_id);
    if (specDigest && revision) {
      appendLocalFleetEvent({
        originSiteId: fleet.homeSiteId,
        appId: String(candidate.app_id),
        actor: input.actor,
        operation: 'application.revision.desired',
        authorityEpoch: Number(candidate.base_authority_epoch),
        generation,
        payload: {
          name: deployment.name,
          appId: String(candidate.app_id),
          specDigest,
          parentDigest: parentSpecDigest,
          apiVersion: revision.api_version,
          manifestFormat: revision.manifest_format,
          normalizedSpec: revision.normalized_spec,
          configurationDigest: candidate.configuration_digest || null,
          source: 'offline-promotion',
          sourceArtifactDigest: candidate.source_artifact_digest || null,
          imageArtifactDigest: candidate.image_artifact_digest || null,
          snapshotArtifactDigest: candidate.snapshot_artifact_digest || null,
          releaseCandidateId: input.candidateId,
        },
        artifactDigests: retainedArtifacts,
      });
    }
    sqlite
      .prepare("UPDATE release_candidates SET state = 'promoted' WHERE id = ?")
      .run(input.candidateId);
    sqlite
      .prepare(
        `UPDATE release_candidates SET state = 'superseded', superseded_by = ?
          WHERE app_id = ? AND id <> ? AND state IN ('candidate', 'ready-to-promote')`,
      )
      .run(input.candidateId, candidate.app_id, input.candidateId);
    invalidateReadinessCertificates(
      String(candidate.app_id),
      undefined,
      `release promoted by ${input.actor}`,
    );
    return generation;
  });
  const generation = promote.immediate();
  refreshDeploymentInCache(deploymentBefore.name);
  return generation;
}

export function planReleaseCandidateChange(candidateId: string): ApplicationChangePlan | null {
  const sqlite = getSqlite()!;
  const candidate = sqlite
    .prepare(
      `SELECT app_id, origin_site_id, spec_digest, requested_alias
         FROM release_candidates WHERE id = ?`,
    )
    .get(candidateId) as
    | {
        app_id: string;
        origin_site_id: string;
        spec_digest: string | null;
        requested_alias: string | null;
      }
    | undefined;
  if (!candidate) throw new Error('Release candidate not found');
  if (!candidate.spec_digest) return null;
  const deployment = sqlite
    .prepare(
      'SELECT name, desired_spec_digest, active_spec_digest FROM deployments WHERE app_id = ?',
    )
    .get(candidate.app_id) as
    | { name: string; desired_spec_digest: string | null; active_spec_digest: string | null }
    | undefined;
  if (!deployment) throw new Error('Release candidate application no longer exists');
  const candidateRevision = sqlite
    .prepare(
      `SELECT normalized_spec FROM application_spec_revisions
        WHERE deployment_name = ? AND digest = ?`,
    )
    .get(deployment.name, candidate.spec_digest) as { normalized_spec: string } | undefined;
  if (!candidateRevision) return null;
  const currentDigest = deployment.desired_spec_digest || deployment.active_spec_digest;
  const currentRevision = currentDigest
    ? (sqlite
        .prepare(
          `SELECT normalized_spec FROM application_spec_revisions
            WHERE deployment_name = ? AND digest = ?`,
        )
        .get(deployment.name, currentDigest) as { normalized_spec: string } | undefined)
    : undefined;
  const desired = parseStoredApplicationSpec(candidateRevision.normalized_spec);
  const current = currentRevision
    ? parseStoredApplicationSpec(currentRevision.normalized_spec)
    : emptyApplicationSpec(candidate.requested_alias || desired.metadata.name || deployment.name);
  return planApplicationChange(current, desired, {
    source: 'offline-candidate',
    targetSiteId: candidate.origin_site_id,
    targetSiteKind: 'suitcase',
    suitcaseSiteIds: [candidate.origin_site_id],
  });
}

function retainedCandidateArtifacts(candidate: Record<string, unknown>): string[] {
  let values: unknown;
  try {
    values = JSON.parse(String(candidate.artifact_digests || '[]'));
  } catch {
    throw new Error('Release candidate artifact manifest is invalid');
  }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error('Release candidate artifact manifest is invalid');
  }
  return [
    ...new Set(
      [
        ...values,
        candidate.source_artifact_digest,
        candidate.image_artifact_digest,
        candidate.snapshot_artifact_digest,
      ].filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ].sort();
}

function assertPromotableAlias(input: { fleetId: string; appId: string; alias: string }): void {
  const sqlite = getSqlite()!;
  const own = sqlite
    .prepare(
      `SELECT state FROM application_aliases
        WHERE fleet_id = ? AND alias = ? AND app_id = ?`,
    )
    .get(input.fleetId, input.alias, input.appId) as { state: string } | undefined;
  const owner = sqlite
    .prepare(
      `SELECT app_id FROM application_aliases
        WHERE fleet_id = ? AND alias = ? AND app_id <> ? AND state IN ('active', 'reserved')
        LIMIT 1`,
    )
    .get(input.fleetId, input.alias, input.appId) as { app_id: string } | undefined;
  if (!own || own.state === 'conflict' || owner) {
    throw new Error(
      `Offline application alias ${JSON.stringify(input.alias)} conflicts with an existing application`,
    );
  }
  if (own.state !== 'reserved' && own.state !== 'active') {
    throw new Error(`Offline application alias ${JSON.stringify(input.alias)} is not reserved`);
  }
}

export function discardReleaseCandidate(candidateId: string): void {
  const result = getSqlite()!
    .prepare(
      "UPDATE release_candidates SET state = 'discarded' WHERE id = ? AND state NOT IN ('promoted', 'discarded')",
    )
    .run(candidateId);
  if (result.changes === 0) throw new Error('Discardable release candidate not found');
}
