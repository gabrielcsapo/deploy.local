import { resolveApplicationConfiguration } from './application-configuration.ts';
import { assertApplicationSuitcaseDataMode } from './application-data-contract.ts';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from './application-graph-executor.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';
import { setDataSyncPolicy, type ConflictPolicy } from './data-reconciliation.ts';
import { updateMaterialization } from './fleet-release.ts';
import {
  appendLocalFleetEvent,
  ensureFleetIdentity,
  sortableId,
  type DataSyncPolicy,
} from './multisite.ts';
import { getApplicationSpecRevision, getSqlite } from './store.ts';
import { projectApplicationConfigurationToSite } from './site-configuration-envelope.ts';
import {
  createInitialSuitcaseCheckpoint,
  type SuitcaseDataExecutor,
} from './suitcase-data-bridge.ts';

export async function keepApplicationOnSuitcase(input: {
  appId: string;
  siteId: string;
  policy?: DataSyncPolicy;
  dataTopology?: 'syncs-across-sites' | 'follows-one-site' | 'site-local';
  initialWriterSiteId?: string;
  conflictPolicy?: ConflictPolicy;
  actor: string;
  executor?: SuitcaseDataExecutor;
}): Promise<{
  replicaId: string;
  policy: DataSyncPolicy;
  dataTopology: 'syncs-across-sites' | 'follows-one-site' | 'site-local';
  sharedLineage: boolean;
  siteLocalNamespaceId: string | null;
}> {
  const sqlite = getSqlite()!;
  const fleet = ensureFleetIdentity();
  const app = sqlite
    .prepare(
      `SELECT name, desired_spec_digest, active_spec_digest, desired_release_digest,
              release_generation, reconciliation_profile_version, directory,
              memory_limit, cpu_limit
         FROM deployments WHERE app_id = ?`,
    )
    .get(input.appId) as
    | {
        name: string;
        desired_spec_digest: string | null;
        active_spec_digest: string | null;
        desired_release_digest: string | null;
        release_generation: number;
        reconciliation_profile_version: string | null;
        directory: string | null;
        memory_limit: string | null;
        cpu_limit: string | null;
      }
    | undefined;
  if (!app) throw new Error('Application not found');
  const site = sqlite
    .prepare(
      `SELECT default_data_policy, revoked_at FROM sites
        WHERE id = ? AND fleet_id = ? AND kind = 'suitcase'`,
    )
    .get(input.siteId, fleet.id) as
    | { default_data_policy: DataSyncPolicy; revoked_at: string | null }
    | undefined;
  if (!site || site.revoked_at) throw new Error('Active suitcase site not found');
  const policy = input.policy || site.default_data_policy || 'none';
  const dataTopology =
    input.dataTopology || (policy === 'none' ? 'site-local' : 'syncs-across-sites');
  if (dataTopology === 'site-local' && policy !== 'none')
    throw new Error('Site-local topology requires No data sync');
  if (dataTopology === 'follows-one-site' && policy === 'none')
    throw new Error('Follows one site requires automatic or manual recovery snapshot transfer');
  if (dataTopology === 'follows-one-site') {
    if (!input.initialWriterSiteId) {
      throw new Error('Follows one site requires an explicit initial writer site');
    }
    if (
      input.initialWriterSiteId !== fleet.homeSiteId &&
      input.initialWriterSiteId !== input.siteId
    ) {
      throw new Error('Initial writer must be Home or the selected suitcase site');
    }
  } else if (input.initialWriterSiteId) {
    throw new Error('Initial writer site is only valid for Follows one site');
  }
  assertApplicationSuitcaseDataMode(input.appId, dataTopology);
  const report = sqlite
    .prepare(
      `SELECT classification, profile_digest, capability_vector, findings FROM portability_reports
        WHERE app_id = ? AND site_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(input.appId, input.siteId) as
    | {
        classification: string;
        profile_digest: string | null;
        capability_vector: string;
        findings: string;
      }
    | undefined;
  const syncClasses = new Set([
    'stateless-replica',
    'file-replica',
    'sqlite-replica',
    'adapter-managed-replica',
  ]);
  const capabilityVector = report ? parseCapabilityVector(report.capability_vector) : {};
  const runtimeEvidencePassed = [
    'compute',
    'runtimeContainment',
    'offlineDependencies',
    'identityAndSecrets',
    'materialization',
  ].every((dimension) => capabilityVector[dimension] === 'pass');
  const reconciliationEvidencePassed = capabilityVector.verification === 'pass';
  if (
    dataTopology === 'syncs-across-sites' &&
    policy !== 'none' &&
    (!report ||
      !syncClasses.has(report.classification) ||
      !runtimeEvidencePassed ||
      !reconciliationEvidencePassed)
  ) {
    throw new Error(
      'Automatic or manual data sync requires a portability report with exact runtime and reconciliation validation for this release and target; choose no data sync or Follows one site',
    );
  }
  if (
    dataTopology === 'follows-one-site' &&
    (!report || report.classification === 'not-suitcase-compatible' || !runtimeEvidencePassed)
  ) {
    throw new Error(
      'Follows one site requires a portability report with exact runtime, offline access, identity, and artifact validation for this release and target',
    );
  }
  const existing = sqlite
    .prepare('SELECT id FROM app_replicas WHERE app_id = ? AND site_id = ?')
    .get(input.appId, input.siteId) as { id: string } | undefined;
  const replicaId = existing?.id || sortableId('replica');
  const now = new Date().toISOString();
  let baseCheckpoint =
    policy === 'none' || dataTopology === 'follows-one-site'
      ? null
      : (
          sqlite
            .prepare(
              `SELECT id FROM data_checkpoints
            WHERE app_id = ? AND verification_status = 'verified'
            ORDER BY sequence DESC LIMIT 1`,
            )
            .get(input.appId) as { id: string } | undefined
        )?.id || null;
  const profileVersion = report?.profile_digest || app.reconciliation_profile_version;
  if (policy !== 'none' && dataTopology === 'syncs-across-sites' && !baseCheckpoint) {
    if (!profileVersion) throw new Error('Shared data selection requires a reconciliation profile');
    const specDigest = app.active_spec_digest || app.desired_spec_digest;
    const revision = specDigest ? getApplicationSpecRevision(app.name, specDigest) : undefined;
    if (!revision) throw new Error('Shared data selection requires an active immutable revision');
    const spec = parseStoredApplicationSpec(revision.normalizedSpec);
    const configuration = resolveApplicationConfiguration({
      deploymentName: app.name,
      specDigest: revision.digest,
      declarations: spec.configuration,
      siteId: fleet.homeSiteId,
    });
    if (!configuration.ready) {
      throw new Error(`Home configuration is missing: ${configuration.missing.join(', ')}`);
    }
    const runtime = buildApplicationGraphRuntime({
      applicationId: input.appId,
      specDigest: revision.digest,
      spec,
      configuration,
    });
    if (!runtime.ready) {
      throw new Error(
        runtime.execution.findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => finding.message)
          .join('; ') || 'Home graph is not admissible for checkpoint capture',
      );
    }
    const context: GraphExecutorContext = {
      deploymentName: app.name,
      applicationId: input.appId,
      siteId: fleet.homeSiteId,
      nodeId: 'coordinator',
      projectDirectory: app.directory || process.cwd(),
      runtime,
      memoryLimit: app.memory_limit || '4g',
      cpuLimit: app.cpu_limit || undefined,
      writerSiteId: fleet.homeSiteId,
    };
    const checkpoint = await createInitialSuitcaseCheckpoint({
      applicationId: input.appId,
      originSiteId: fleet.homeSiteId,
      profileVersion,
      context,
      executor: input.executor || new ApplicationGraphExecutor(),
      actor: input.actor,
    });
    baseCheckpoint = checkpoint.id;
  }
  const sharedLineage =
    dataTopology === 'syncs-across-sites' && policy !== 'none' && Boolean(baseCheckpoint);
  const siteLocalNamespaceId = policy === 'none' ? sortableId('namespace') : null;
  const save = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO app_replicas
          (id, app_id, site_id, desired_release_digest, runtime_status, data_mode,
           sync_policy, shared_lineage, profile_version, base_checkpoint_id,
           readiness, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, '{}', ?, ?)
         ON CONFLICT(app_id, site_id) DO UPDATE SET
           desired_release_digest = excluded.desired_release_digest,
           runtime_status = 'pending', data_mode = excluded.data_mode,
           sync_policy = excluded.sync_policy, shared_lineage = excluded.shared_lineage,
           profile_version = excluded.profile_version,
           base_checkpoint_id = COALESCE(excluded.base_checkpoint_id, base_checkpoint_id),
           removed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        replicaId,
        input.appId,
        input.siteId,
        app.desired_release_digest,
        dataTopology === 'follows-one-site'
          ? 'follows-one-site-target'
          : policy === 'none'
            ? 'site-local'
            : 'replicated',
        policy,
        sharedLineage ? 1 : 0,
        profileVersion,
        baseCheckpoint,
        now,
        now,
      );
    if (sharedLineage) {
      const home = sqlite
        .prepare(
          `UPDATE app_replicas
              SET data_mode = 'replicated', sync_policy = 'automatic', shared_lineage = 1,
                  profile_version = ?, base_checkpoint_id = ?, updated_at = ?
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .run(profileVersion, baseCheckpoint, now, input.appId, fleet.homeSiteId);
      if (home.changes !== 1) throw new Error('Home application replica is missing');
    }
  });
  save.immediate();
  setDataSyncPolicy({
    appId: input.appId,
    siteId: input.siteId,
    policy,
    conflictPolicy: input.conflictPolicy,
    updatedBy: input.actor,
    acknowledgedRisks:
      dataTopology === 'follows-one-site'
        ? ['Only the authority site may mount this opaque volume for writes']
        : policy === 'none'
          ? ['Site-local data will not converge with Home or other suitcases']
          : [],
  });
  if (sharedLineage) {
    setDataSyncPolicy({
      appId: input.appId,
      siteId: fleet.homeSiteId,
      policy: 'automatic',
      conflictPolicy: 'collect',
      updatedBy: input.actor,
    });
  }

  const specDigest = app.desired_spec_digest || app.active_spec_digest;
  updateMaterialization({
    appId: input.appId,
    siteId: input.siteId,
    capability: 'release',
    desiredDigest: app.desired_release_digest || specDigest || undefined,
    desiredGeneration: app.release_generation,
    state: 'missing',
    blockers: ['release artifacts have not been verified on the suitcase'],
  });
  updateMaterialization({
    appId: input.appId,
    siteId: input.siteId,
    capability: 'data',
    desiredDigest: baseCheckpoint || undefined,
    state:
      dataTopology === 'follows-one-site'
        ? 'missing'
        : policy === 'none'
          ? 'unknown'
          : baseCheckpoint
            ? 'syncing'
            : 'missing',
    blockers:
      dataTopology === 'follows-one-site'
        ? ['opaque volume authority has not been transferred to this site']
        : policy === 'none'
          ? ['site-local namespace requires initialization and acknowledgement']
          : baseCheckpoint
            ? ['shared checkpoint is queued for materialization']
            : ['initial verified checkpoint is missing'],
  });
  const selectionEvent = appendLocalFleetEvent({
    originSiteId: fleet.homeSiteId,
    appId: input.appId,
    actor: input.actor,
    operation: 'application.replica.selected',
    generation: app.release_generation,
    payload: {
      replicaId,
      applicationName: app.name,
      siteId: input.siteId,
      specDigest,
      desiredReleaseDigest: app.desired_release_digest,
      policy,
      dataTopology,
      initialWriterSiteId: dataTopology === 'follows-one-site' ? input.initialWriterSiteId : null,
      conflictPolicy: input.conflictPolicy || 'collect',
      sharedLineage,
      baseCheckpointId: baseCheckpoint,
      forkCheckpointId: null,
      siteLocalNamespaceId,
      consequence:
        policy === 'none'
          ? 'This site-local namespace does not converge with Home or other suitcases.'
          : 'This replica participates in the application shared data lineage.',
      profileDigest: report?.profile_digest || null,
    },
  });
  sqlite
    .prepare(
      `UPDATE app_replicas SET last_policy_event_id = ?, updated_at = ?
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(selectionEvent.eventId, selectionEvent.createdAt, input.appId, input.siteId);
  if (specDigest) {
    const revision = getApplicationSpecRevision(app.name, specDigest);
    if (
      revision &&
      Object.keys(parseStoredApplicationSpec(revision.normalizedSpec).configuration).length > 0
    ) {
      projectApplicationConfigurationToSite({
        appId: input.appId,
        siteId: input.siteId,
        actor: input.actor,
      });
    }
  }
  return { replicaId, policy, dataTopology, sharedLineage, siteLocalNamespaceId };
}

function parseCapabilityVector(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, capability]) => [
        key,
        capability && typeof capability === 'object' && !Array.isArray(capability)
          ? String((capability as { status?: unknown }).status || '')
          : '',
      ]),
    );
  } catch {
    return {};
  }
}

export function removeLostApplicationReplica(input: {
  appId: string;
  siteId: string;
  actor: string;
  acknowledgeUnreceivedDataLoss: boolean;
}): { lastAdoptedCheckpointId: string | null } {
  if (!input.acknowledgeUnreceivedDataLoss)
    throw new Error(
      'Replica removal requires acknowledgement that unreceived away data may be lost',
    );
  const sqlite = getSqlite()!;
  const replica = sqlite
    .prepare(
      `SELECT base_checkpoint_id, removed_at FROM app_replicas
        WHERE app_id = ? AND site_id = ?`,
    )
    .get(input.appId, input.siteId) as
    | { base_checkpoint_id: string | null; removed_at: string | null }
    | undefined;
  if (!replica || replica.removed_at) throw new Error('Active application replica not found');
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `UPDATE app_replicas SET removed_at = ?, runtime_status = 'removed',
              shared_lineage = 0, updated_at = ?
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(now, now, input.appId, input.siteId);
  const fleet = ensureFleetIdentity();
  appendLocalFleetEvent({
    originSiteId: fleet.homeSiteId,
    appId: input.appId,
    actor: input.actor,
    operation: 'application.replica.removed',
    payload: {
      siteId: input.siteId,
      lastAdoptedCheckpointId: replica.base_checkpoint_id,
      unreceivedBranchAcknowledged: true,
    },
  });
  return { lastAdoptedCheckpointId: replica.base_checkpoint_id };
}
