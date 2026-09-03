import { updateMaterialization } from './fleet-release.ts';
import {
  assertApplicationSuitcaseDataMode,
  SuitcaseDataModeContractError,
} from './application-data-contract.ts';
import {
  appendLocalFleetEvent,
  resolveLocalSiteId,
  sortableId,
  type DataSyncPolicy,
} from './multisite.ts';
import { getSqlite } from './store.ts';
import type { ConflictPolicy } from './data-reconciliation.ts';

export type DataPolicyRejoinChoice =
  | 'replace-site-from-shared'
  | 'replace-shared-from-site'
  | 'import-site-as-new-application';

export interface ReplicaDataPolicyTransitionInput {
  appId: string;
  siteId: string;
  policy: DataSyncPolicy;
  conflictPolicy?: ConflictPolicy;
  acknowledgedRisks?: string[];
  rejoinChoice?: DataPolicyRejoinChoice;
  protectedConfirmation?: string;
  updatedBy: string;
}

export interface CompletedReplicaDataPolicyTransition {
  status: 'unchanged' | 'completed';
  eventId: string | null;
  appId: string;
  siteId: string;
  previousPolicy: DataSyncPolicy;
  policy: DataSyncPolicy;
  sharedLineage: boolean;
  baseCheckpointId: string | null;
  forkCheckpointId: string | null;
  siteLocalNamespaceId: string | null;
}

export interface PendingReplicaDataPolicyTransition {
  status: 'pending-target-processing';
  eventId: string;
  appId: string;
  siteId: string;
  previousPolicy: 'none';
  policy: Exclude<DataSyncPolicy, 'none'>;
  rejoinChoice: DataPolicyRejoinChoice;
  requiredActions: string[];
  consequence: string;
}

export type ReplicaDataPolicyTransition =
  | CompletedReplicaDataPolicyTransition
  | PendingReplicaDataPolicyTransition;

export interface PolicyTransitionBackupEvidence {
  eventId: string;
  siteId: string;
  artifactReference: string;
  artifactDigest: string;
  verification: string;
  scope: 'site-local-namespace' | 'shared-home-namespace';
}

export class DataPolicyTransitionError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, code: string, statusCode = 409) {
    super(message);
    this.name = 'DataPolicyTransitionError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function assertPolicyTopology(
  appId: string,
  mode: 'syncs-across-sites' | 'follows-one-site' | 'site-local',
): void {
  try {
    assertApplicationSuitcaseDataMode(appId, mode);
  } catch (error) {
    if (error instanceof SuitcaseDataModeContractError) {
      throw new DataPolicyTransitionError(error.message, error.code, error.statusCode);
    }
    throw error;
  }
}

interface ReplicaPolicyState {
  id: string;
  policy: DataSyncPolicy;
  conflictPolicy: ConflictPolicy;
  dataMode: string;
  sharedLineage: boolean;
  baseCheckpointId: string | null;
  profileVersion: string | null;
  branchCheckpointId: string | null;
  pendingChangesets: number;
  pendingBlobs: number;
  conflictCount: number;
  lastPolicyEventId: string | null;
}

interface PendingWork {
  replicaChangesets: number;
  replicaBlobs: number;
  replicaConflicts: number;
  durableChangesets: number;
  openConflicts: number;
  branchCheckpointId: string | null;
}

function replicaState(appId: string, siteId: string): ReplicaPolicyState {
  const row = getSqlite()!
    .prepare(
      `SELECT r.id, r.sync_policy, r.data_mode, r.shared_lineage,
              r.base_checkpoint_id, r.branch_checkpoint_id, r.pending_changesets,
              r.pending_blobs, r.conflict_count, r.last_policy_event_id, r.profile_version,
              COALESCE(site_policy.conflict_policy, app_policy.conflict_policy, 'collect')
                AS conflict_policy
         FROM app_replicas r
         LEFT JOIN data_sync_policies site_policy
           ON site_policy.app_id = r.app_id AND site_policy.site_id = r.site_id
         LEFT JOIN data_sync_policies app_policy
           ON app_policy.app_id = r.app_id AND app_policy.site_id = ''
        WHERE r.app_id = ? AND r.site_id = ? AND r.removed_at IS NULL`,
    )
    .get(appId, siteId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new DataPolicyTransitionError(
      'Active application replica not found',
      'replica_not_found',
      404,
    );
  }
  const policy = String(row.sync_policy);
  if (policy !== 'automatic' && policy !== 'manual' && policy !== 'none') {
    throw new DataPolicyTransitionError(
      `Replica has an unsupported data sync policy: ${policy}`,
      'invalid_current_policy',
    );
  }
  return {
    id: String(row.id),
    policy,
    conflictPolicy: String(row.conflict_policy) as ConflictPolicy,
    dataMode: String(row.data_mode),
    sharedLineage: Boolean(row.shared_lineage),
    baseCheckpointId: row.base_checkpoint_id ? String(row.base_checkpoint_id) : null,
    profileVersion: row.profile_version ? String(row.profile_version) : null,
    branchCheckpointId: row.branch_checkpoint_id ? String(row.branch_checkpoint_id) : null,
    pendingChangesets: Number(row.pending_changesets || 0),
    pendingBlobs: Number(row.pending_blobs || 0),
    conflictCount: Number(row.conflict_count || 0),
    lastPolicyEventId: row.last_policy_event_id ? String(row.last_policy_event_id) : null,
  };
}

function pendingWork(appId: string, siteId: string, replica: ReplicaPolicyState): PendingWork {
  const sqlite = getSqlite()!;
  const changesets = sqlite
    .prepare(
      `SELECT COUNT(*) AS count FROM data_changesets
        WHERE app_id = ? AND origin_site_id = ?
          AND status IN ('pending', 'conflicted', 'blocked')`,
    )
    .get(appId, siteId) as { count: number };
  const conflicts = sqlite
    .prepare(
      `SELECT COUNT(*) AS count
         FROM data_conflicts conflict
         LEFT JOIN data_changesets changeset ON changeset.id = conflict.changeset_id
        WHERE conflict.app_id = ? AND conflict.status = 'open'
          AND (changeset.origin_site_id = ? OR conflict.changeset_id IS NULL)`,
    )
    .get(appId, siteId) as { count: number };
  return {
    replicaChangesets: replica.pendingChangesets,
    replicaBlobs: replica.pendingBlobs,
    replicaConflicts: replica.conflictCount,
    durableChangesets: Number(changesets.count),
    openConflicts: Number(conflicts.count),
    branchCheckpointId: replica.branchCheckpointId,
  };
}

function assertNoPendingWork(appId: string, siteId: string, replica: ReplicaPolicyState): void {
  const pending = pendingWork(appId, siteId, replica);
  const blockers: string[] = [];
  if (pending.branchCheckpointId)
    blockers.push(`local branch is based on ${pending.branchCheckpointId}`);
  if (pending.replicaChangesets || pending.durableChangesets)
    blockers.push(
      `${Math.max(pending.replicaChangesets, pending.durableChangesets)} changeset(s) require reconciliation`,
    );
  if (pending.replicaBlobs) blockers.push(`${pending.replicaBlobs} blob transfer(s) are pending`);
  if (pending.replicaConflicts || pending.openConflicts)
    blockers.push(
      `${Math.max(pending.replicaConflicts, pending.openConflicts)} conflict(s) require resolution`,
    );
  if (blockers.length) {
    throw new DataPolicyTransitionError(
      `Data policy transition is blocked: ${blockers.join('; ')}`,
      'pending_reconciliation_work',
    );
  }
}

function upsertPolicy(input: {
  appId: string;
  siteId: string;
  policy: DataSyncPolicy;
  conflictPolicy: ConflictPolicy;
  acknowledgedRisks: string[];
  updatedBy: string;
  updatedAt: string;
}): void {
  getSqlite()!
    .prepare(
      `INSERT INTO data_sync_policies
        (app_id, site_id, policy, conflict_policy, acknowledged_risks, revision,
         updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET
         policy = excluded.policy,
         conflict_policy = excluded.conflict_policy,
         acknowledged_risks = excluded.acknowledged_risks,
         revision = data_sync_policies.revision + 1,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.appId,
      input.siteId,
      input.policy,
      input.conflictPolicy,
      JSON.stringify(input.acknowledgedRisks),
      input.updatedBy,
      input.updatedAt,
    );
}

function latestNamespaceMetadata(lastPolicyEventId: string | null): {
  forkCheckpointId: string | null;
  siteLocalNamespaceId: string | null;
} {
  if (!lastPolicyEventId) return { forkCheckpointId: null, siteLocalNamespaceId: null };
  const event = getSqlite()!
    .prepare('SELECT payload FROM fleet_events WHERE id = ?')
    .get(lastPolicyEventId) as { payload: string } | undefined;
  if (!event) return { forkCheckpointId: null, siteLocalNamespaceId: null };
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    return {
      forkCheckpointId:
        typeof payload.forkCheckpointId === 'string' ? payload.forkCheckpointId : null,
      siteLocalNamespaceId:
        typeof payload.siteLocalNamespaceId === 'string' ? payload.siteLocalNamespaceId : null,
    };
  } catch {
    return { forkCheckpointId: null, siteLocalNamespaceId: null };
  }
}

function eventPayload(eventId: string): {
  appId: string;
  originSiteId: string;
  operation: string;
  actor: string;
  payload: Record<string, unknown>;
} {
  const row = getSqlite()!
    .prepare(
      `SELECT app_id, origin_site_id, operation, actor, payload
         FROM fleet_events WHERE id = ?`,
    )
    .get(eventId) as
    | {
        app_id: string | null;
        origin_site_id: string;
        operation: string;
        actor: string;
        payload: string;
      }
    | undefined;
  if (!row?.app_id) {
    throw new DataPolicyTransitionError(
      `Policy transition event not found: ${eventId}`,
      'transition_event_not_found',
      404,
    );
  }
  return {
    appId: row.app_id,
    originSiteId: row.origin_site_id,
    operation: row.operation,
    actor: row.actor,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
}

function existingTerminalEvent(requestEventId: string): {
  id: string;
  operation: string;
  payload: Record<string, unknown>;
} | null {
  const row = getSqlite()!
    .prepare(
      `SELECT id, operation, payload FROM fleet_events
        WHERE operation IN ('application.data.policy.transition.completed',
                            'application.data.policy.transition.failed')
          AND json_extract(payload, '$.requestEventId') = ?
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(requestEventId) as { id: string; operation: string; payload: string } | undefined;
  return row
    ? {
        id: row.id,
        operation: row.operation,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
      }
    : null;
}

export function recordReplicaDataPolicyTransitionBackup(input: {
  requestEventId: string;
  siteId: string;
  scope: PolicyTransitionBackupEvidence['scope'];
  artifactReference: string;
  artifactDigest: string;
  verification: string;
  actor: string;
}): PolicyTransitionBackupEvidence {
  const request = eventPayload(input.requestEventId);
  if (request.operation !== 'application.data.policy.transition.requested') {
    throw new DataPolicyTransitionError(
      'Backup evidence must reference a policy transition request',
      'invalid_transition_request',
    );
  }
  const existing = getSqlite()!
    .prepare(
      `SELECT id, payload FROM fleet_events
        WHERE operation = 'application.data.policy.transition.backup.created'
          AND json_extract(payload, '$.requestEventId') = ?
          AND json_extract(payload, '$.siteId') = ?
          AND json_extract(payload, '$.scope') = ?
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(input.requestEventId, input.siteId, input.scope) as
    | { id: string; payload: string }
    | undefined;
  if (existing) {
    const payload = JSON.parse(existing.payload) as Record<string, unknown>;
    return {
      eventId: existing.id,
      siteId: String(payload.siteId),
      artifactReference: String(payload.artifactReference),
      artifactDigest: String(payload.artifactDigest),
      verification: String(payload.verification),
      scope: String(payload.scope) as PolicyTransitionBackupEvidence['scope'],
    };
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(input.artifactDigest)) {
    throw new DataPolicyTransitionError(
      'Policy transition backup digest is invalid',
      'invalid_backup_digest',
    );
  }
  const event = appendLocalFleetEvent({
    originSiteId: input.siteId,
    appId: request.appId,
    actor: input.actor,
    operation: 'application.data.policy.transition.backup.created',
    parentEventId: input.requestEventId,
    payload: {
      requestEventId: input.requestEventId,
      siteId: input.siteId,
      previousPolicy: request.payload.previousPolicy,
      policy: request.payload.policy,
      transitionStatus: 'backup-verified',
      rejoinChoice: request.payload.rejoinChoice,
      forkCheckpointId: request.payload.forkCheckpointId ?? null,
      siteLocalNamespaceId: request.payload.siteLocalNamespaceId ?? null,
      scope: input.scope,
      artifactReference: input.artifactReference,
      artifactDigest: input.artifactDigest,
      verification: input.verification,
    },
  });
  return {
    eventId: event.eventId,
    siteId: input.siteId,
    artifactReference: input.artifactReference,
    artifactDigest: input.artifactDigest,
    verification: input.verification,
    scope: input.scope,
  };
}

export function recordReplicaDataPolicyTransitionPrepared(input: {
  requestEventId: string;
  siteId: string;
  replacementCheckpointId: string;
  backupEventId: string;
  actor: string;
}): { eventId: string; replacementCheckpointId: string } {
  const request = eventPayload(input.requestEventId);
  if (
    request.operation !== 'application.data.policy.transition.requested' ||
    request.payload.rejoinChoice !== 'replace-shared-from-site'
  ) {
    throw new DataPolicyTransitionError(
      'Prepared Home replacement must reference a replace-shared-from-site request',
      'invalid_transition_request',
    );
  }
  const existing = getSqlite()!
    .prepare(
      `SELECT id, payload FROM fleet_events
        WHERE operation = 'application.data.policy.transition.prepared'
          AND json_extract(payload, '$.requestEventId') = ?
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(input.requestEventId) as { id: string; payload: string } | undefined;
  if (existing) {
    const payload = JSON.parse(existing.payload) as Record<string, unknown>;
    return {
      eventId: existing.id,
      replacementCheckpointId: String(payload.replacementCheckpointId),
    };
  }
  const checkpoint = getSqlite()!
    .prepare(
      `SELECT id, parent_id, origin_site_id, sequence, database_artifact_digest,
              filesystem_artifact_digest, manifest_artifact_digest, schema_fingerprint,
              profile_version, created_at
         FROM data_checkpoints
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(input.replacementCheckpointId, request.appId) as Record<string, unknown> | undefined;
  if (!checkpoint) {
    throw new DataPolicyTransitionError(
      'Prepared policy transition checkpoint is missing or unverified',
      'replacement_checkpoint_unverified',
    );
  }
  const event = appendLocalFleetEvent({
    originSiteId: input.siteId,
    appId: request.appId,
    actor: input.actor,
    operation: 'application.data.policy.transition.prepared',
    parentEventId: input.requestEventId,
    payload: {
      requestEventId: input.requestEventId,
      siteId: input.siteId,
      previousPolicy: request.payload.previousPolicy,
      policy: request.payload.policy,
      transitionStatus: 'awaiting-home-materialization',
      rejoinChoice: request.payload.rejoinChoice,
      conflictPolicy: request.payload.conflictPolicy,
      acknowledgedRisks: request.payload.acknowledgedRisks,
      forkCheckpointId: request.payload.forkCheckpointId ?? null,
      siteLocalNamespaceId: request.payload.siteLocalNamespaceId ?? null,
      replacementCheckpointId: input.replacementCheckpointId,
      checkpointId: input.replacementCheckpointId,
      parentId: checkpoint.parent_id || null,
      sequence: Number(checkpoint.sequence),
      databaseArtifactDigest: checkpoint.database_artifact_digest || null,
      filesystemArtifactDigest: checkpoint.filesystem_artifact_digest || null,
      manifestArtifactDigest: checkpoint.manifest_artifact_digest,
      schemaFingerprint: checkpoint.schema_fingerprint || null,
      profileVersion: checkpoint.profile_version || null,
      backupEventIds: [input.backupEventId],
    },
    artifactDigests: [
      checkpoint.database_artifact_digest,
      checkpoint.filesystem_artifact_digest,
      checkpoint.manifest_artifact_digest,
    ].filter((digest): digest is string => typeof digest === 'string'),
  });
  return { eventId: event.eventId, replacementCheckpointId: input.replacementCheckpointId };
}

export function completeReplicaDataPolicyTransition(input: {
  requestEventId: string;
  completedBySiteId: string;
  baseCheckpointId: string;
  backupEventIds: string[];
  preparedEventId?: string;
  importedApplicationId?: string;
  importedApplicationName?: string;
  actor: string;
}): { eventId: string; policy: Exclude<DataSyncPolicy, 'none'>; baseCheckpointId: string } {
  const request = eventPayload(input.requestEventId);
  if (request.operation !== 'application.data.policy.transition.requested') {
    throw new DataPolicyTransitionError(
      'Completion must reference a policy transition request',
      'invalid_transition_request',
    );
  }
  const targetPolicy = request.payload.policy;
  if (targetPolicy !== 'automatic' && targetPolicy !== 'manual') {
    throw new DataPolicyTransitionError(
      'Policy transition completion has an invalid target policy',
      'invalid_target_policy',
    );
  }
  const terminal = existingTerminalEvent(input.requestEventId);
  if (terminal) {
    if (terminal.operation === 'application.data.policy.transition.failed') {
      throw new DataPolicyTransitionError(
        'Failed policy transition requires a new administrator request before retry',
        'transition_already_failed',
      );
    }
    return {
      eventId: terminal.id,
      policy: String(terminal.payload.policy) as Exclude<DataSyncPolicy, 'none'>,
      baseCheckpointId: String(terminal.payload.baseCheckpointId),
    };
  }
  const siteId = String(request.payload.siteId || '');
  if (!siteId) {
    throw new DataPolicyTransitionError(
      'Policy transition request has no target site',
      'invalid_transition_request',
    );
  }
  assertPolicyTopology(request.appId, 'syncs-across-sites');
  const checkpoint = getSqlite()!
    .prepare(
      `SELECT id FROM data_checkpoints
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(input.baseCheckpointId, request.appId);
  if (!checkpoint) {
    throw new DataPolicyTransitionError(
      'Policy transition completion requires a verified shared checkpoint',
      'replacement_checkpoint_unverified',
    );
  }
  if (input.backupEventIds.length === 0) {
    throw new DataPolicyTransitionError(
      'Policy transition completion requires verified displaced-namespace backup evidence',
      'backup_evidence_required',
    );
  }
  for (const backupEventId of input.backupEventIds) {
    const backup = eventPayload(backupEventId);
    if (
      backup.appId !== request.appId ||
      backup.operation !== 'application.data.policy.transition.backup.created' ||
      backup.payload.requestEventId !== input.requestEventId ||
      backup.payload.transitionStatus !== 'backup-verified'
    ) {
      throw new DataPolicyTransitionError(
        `Invalid policy transition backup evidence: ${backupEventId}`,
        'invalid_backup_evidence',
      );
    }
  }
  if (request.payload.rejoinChoice === 'replace-shared-from-site') {
    if (!input.preparedEventId || input.backupEventIds.length < 2) {
      throw new DataPolicyTransitionError(
        'Replacing shared data requires target preparation plus retained target and Home backups',
        'home_replacement_evidence_required',
      );
    }
    const prepared = eventPayload(input.preparedEventId);
    if (
      prepared.operation !== 'application.data.policy.transition.prepared' ||
      prepared.payload.requestEventId !== input.requestEventId ||
      prepared.payload.replacementCheckpointId !== input.baseCheckpointId
    ) {
      throw new DataPolicyTransitionError(
        'Home replacement preparation evidence is invalid',
        'invalid_preparation_evidence',
      );
    }
  }
  if (request.payload.rejoinChoice === 'import-site-as-new-application') {
    const expectedId = String(request.payload.importedApplicationId || '');
    const imported = getSqlite()!
      .prepare('SELECT name FROM deployments WHERE app_id = ?')
      .get(expectedId) as { name: string } | undefined;
    if (
      !expectedId ||
      !imported ||
      input.importedApplicationId !== expectedId ||
      input.importedApplicationName !== imported.name
    ) {
      throw new DataPolicyTransitionError(
        'Imported application must be materialized and verified before the original joins shared data',
        'imported_application_unverified',
      );
    }
  }
  const consequence = String(request.payload.consequence || 'Shared data lineage restored');
  const event = appendLocalFleetEvent({
    originSiteId: input.completedBySiteId,
    appId: request.appId,
    actor: input.actor,
    operation: 'application.data.policy.transition.completed',
    parentEventId: input.preparedEventId || input.requestEventId,
    payload: {
      requestEventId: input.requestEventId,
      siteId,
      previousPolicy: 'none',
      policy: targetPolicy,
      transitionStatus: 'completed',
      rejoinChoice: request.payload.rejoinChoice,
      conflictPolicy: request.payload.conflictPolicy || 'collect',
      acknowledgedRisks: request.payload.acknowledgedRisks || [],
      dataTopology: 'syncs-across-sites',
      sharedLineage: true,
      baseCheckpointId: input.baseCheckpointId,
      forkCheckpointId: request.payload.forkCheckpointId ?? null,
      siteLocalNamespaceId: request.payload.siteLocalNamespaceId ?? null,
      clearBranch: true,
      backupEventIds: input.backupEventIds,
      preparedEventId: input.preparedEventId || null,
      importedApplicationId: input.importedApplicationId || null,
      importedApplicationName: input.importedApplicationName || null,
      consequence,
    },
  });
  const now = event.createdAt;
  const save = getSqlite()!.transaction(() => {
    upsertPolicy({
      appId: request.appId,
      siteId,
      policy: targetPolicy,
      conflictPolicy: String(request.payload.conflictPolicy || 'collect') as ConflictPolicy,
      acknowledgedRisks: Array.isArray(request.payload.acknowledgedRisks)
        ? request.payload.acknowledgedRisks.filter(
            (risk): risk is string => typeof risk === 'string',
          )
        : [],
      updatedBy: input.actor,
      updatedAt: now,
    });
    getSqlite()!
      .prepare(
        `UPDATE app_replicas
            SET sync_policy = ?, shared_lineage = 1, data_mode = 'replicated',
                base_checkpoint_id = ?, branch_checkpoint_id = NULL,
                pending_changesets = 0, pending_blobs = 0,
                last_policy_event_id = ?, updated_at = ?
          WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
      )
      .run(targetPolicy, input.baseCheckpointId, event.eventId, now, request.appId, siteId);
  });
  save.immediate();
  updateMaterialization({
    appId: request.appId,
    siteId,
    capability: 'data',
    desiredDigest: input.baseCheckpointId,
    availableDigest: input.baseCheckpointId,
    state: 'ready',
    blockers: [],
    evidence: [
      {
        source: 'policy-transition',
        requestEventId: input.requestEventId,
        backupEventIds: input.backupEventIds,
        rejoinChoice: request.payload.rejoinChoice,
      },
    ],
  });
  return { eventId: event.eventId, policy: targetPolicy, baseCheckpointId: input.baseCheckpointId };
}

export function failReplicaDataPolicyTransition(input: {
  requestEventId: string;
  failedBySiteId: string;
  backupEventIds?: string[];
  error: string;
  actor: string;
}): { eventId: string; failed: true } {
  const request = eventPayload(input.requestEventId);
  const terminal = existingTerminalEvent(input.requestEventId);
  if (terminal) return { eventId: terminal.id, failed: true };
  const event = appendLocalFleetEvent({
    originSiteId: input.failedBySiteId,
    appId: request.appId,
    actor: input.actor,
    operation: 'application.data.policy.transition.failed',
    parentEventId: input.requestEventId,
    payload: {
      requestEventId: input.requestEventId,
      siteId: request.payload.siteId,
      previousPolicy: request.payload.previousPolicy,
      policy: request.payload.policy,
      transitionStatus: 'failed',
      rejoinChoice: request.payload.rejoinChoice,
      forkCheckpointId: request.payload.forkCheckpointId ?? null,
      siteLocalNamespaceId: request.payload.siteLocalNamespaceId ?? null,
      backupEventIds: input.backupEventIds || [],
      error: input.error,
    },
  });
  getSqlite()!
    .prepare(
      `UPDATE app_replicas SET last_policy_event_id = ?, updated_at = ?
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(event.eventId, event.createdAt, request.appId, String(request.payload.siteId || ''));
  return { eventId: event.eventId, failed: true };
}

function requiredRejoinActions(
  choice: DataPolicyRejoinChoice,
  sharedCheckpointId: string | null,
): { actions: string[]; consequence: string } {
  if (choice === 'replace-site-from-shared') {
    return {
      actions: [
        'Capture and verify a retained backup of the current site-local namespace on the target site.',
        sharedCheckpointId
          ? `Restore and verify shared checkpoint ${sharedCheckpointId} on the target site.`
          : 'Create a verified shared checkpoint at Home, then restore it on the target site.',
        'Emit a target-signed completion event before changing lineage membership.',
      ],
      consequence:
        'The current site-local records and files will remain only in the retained backup; the replica will then match the shared lineage.',
    };
  }
  if (choice === 'replace-shared-from-site') {
    return {
      actions: [
        'Capture and verify a retained backup of both the current site-local namespace and the current shared namespace.',
        'Publish the site-local state as a new verified shared checkpoint and materialize it at Home.',
        'Emit target- and Home-verifiable completion evidence before changing lineage membership.',
      ],
      consequence:
        'The site-local state will replace shared Home data for this application; every displaced namespace must remain recoverable.',
    };
  }
  return {
    actions: [
      'Capture and verify a retained backup of the current site-local namespace on the target site.',
      'Create a distinct application identity from that backup and verify the imported application.',
      sharedCheckpointId
        ? `Restore and verify shared checkpoint ${sharedCheckpointId} for the original application on the target site.`
        : 'Create and restore a verified shared checkpoint for the original application.',
      'Emit a target-signed completion event before changing lineage membership.',
    ],
    consequence:
      'The site-local state will survive as a separate application; the original replica will rejoin its prior shared lineage.',
  };
}

/**
 * Change one active replica's data policy without inventing a missing common
 * base. Transitions that displace a no-sync namespace stop at a durable,
 * authenticated request until a target-side data operation can preserve and
 * prove the replacement/import.
 */
export function transitionReplicaDataPolicy(
  input: ReplicaDataPolicyTransitionInput,
): ReplicaDataPolicyTransition {
  const replica = replicaState(input.appId, input.siteId);
  if (replica.dataMode.startsWith('follows-one-site')) {
    const localSiteId = resolveLocalSiteId();
    if (process.env.DEPLOY_SUITCASE === '1' && localSiteId !== input.siteId) {
      throw new DataPolicyTransitionError(
        'A suitcase can change data policy only for its own local application replica',
        'remote_replica_policy_forbidden',
        403,
      );
    }
    if (input.policy === 'none') {
      throw new DataPolicyTransitionError(
        'Follows one site cannot become no-sync without first changing its volume-authority topology',
        'follows_one_site_topology_change_required',
      );
    }
    if (replica.policy === input.policy) {
      return {
        status: 'unchanged',
        eventId: null,
        appId: input.appId,
        siteId: input.siteId,
        previousPolicy: replica.policy,
        policy: replica.policy,
        sharedLineage: replica.sharedLineage,
        baseCheckpointId: replica.baseCheckpointId,
        forkCheckpointId: null,
        siteLocalNamespaceId: null,
      };
    }
    assertPolicyTopology(input.appId, 'follows-one-site');
    const conflictPolicy = input.conflictPolicy || replica.conflictPolicy;
    const acknowledgedRisks = [...new Set(input.acknowledgedRisks || [])];
    const event = appendLocalFleetEvent({
      originSiteId: localSiteId,
      appId: input.appId,
      actor: input.updatedBy,
      operation: 'application.data.policy.updated',
      parentEventId: replica.lastPolicyEventId || undefined,
      payload: {
        siteId: input.siteId,
        previousPolicy: replica.policy,
        policy: input.policy,
        transitionStatus: 'completed',
        conflictPolicy,
        acknowledgedRisks,
        dataTopology: 'follows-one-site',
        sharedLineage: replica.sharedLineage,
        baseCheckpointId: replica.baseCheckpointId,
        affectedReplicaIds: [replica.id],
        clearBranch: false,
        consequence:
          input.policy === 'automatic'
            ? 'Verified recovery snapshots are captured automatically while docked.'
            : 'Verified recovery snapshots are captured only after an administrator chooses Sync now.',
      },
    });
    const now = event.createdAt;
    const save = getSqlite()!.transaction(() => {
      upsertPolicy({
        appId: input.appId,
        siteId: input.siteId,
        policy: input.policy,
        conflictPolicy,
        acknowledgedRisks,
        updatedBy: input.updatedBy,
        updatedAt: now,
      });
      getSqlite()!
        .prepare(
          `UPDATE app_replicas
              SET sync_policy = ?, last_policy_event_id = ?, updated_at = ?
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .run(input.policy, event.eventId, now, input.appId, input.siteId);
    });
    save.immediate();
    return {
      status: 'completed',
      eventId: event.eventId,
      appId: input.appId,
      siteId: input.siteId,
      previousPolicy: replica.policy,
      policy: input.policy,
      sharedLineage: replica.sharedLineage,
      baseCheckpointId: replica.baseCheckpointId,
      forkCheckpointId: null,
      siteLocalNamespaceId: null,
    };
  }
  if (replica.policy === input.policy) {
    const namespace = latestNamespaceMetadata(replica.lastPolicyEventId);
    return {
      status: 'unchanged',
      eventId: null,
      appId: input.appId,
      siteId: input.siteId,
      previousPolicy: replica.policy,
      policy: replica.policy,
      sharedLineage: replica.sharedLineage,
      baseCheckpointId: replica.baseCheckpointId,
      forkCheckpointId: namespace.forkCheckpointId,
      siteLocalNamespaceId: namespace.siteLocalNamespaceId,
    };
  }
  assertPolicyTopology(input.appId, input.policy === 'none' ? 'site-local' : 'syncs-across-sites');

  const conflictPolicy = input.conflictPolicy || replica.conflictPolicy;
  const acknowledgedRisks = [...new Set(input.acknowledgedRisks || [])];
  const localSiteId = resolveLocalSiteId();
  if (process.env.DEPLOY_SUITCASE === '1' && localSiteId !== input.siteId) {
    throw new DataPolicyTransitionError(
      'A suitcase can change data policy only for its own local application replica',
      'remote_replica_policy_forbidden',
      403,
    );
  }

  if (replica.policy === 'none' && input.policy !== 'none') {
    if (!input.rejoinChoice) {
      throw new DataPolicyTransitionError(
        'Rejoining shared data requires rejoinChoice: replace-site-from-shared, replace-shared-from-site, or import-site-as-new-application',
        'rejoin_choice_required',
      );
    }
    if (
      input.rejoinChoice === 'replace-shared-from-site' &&
      input.protectedConfirmation !== `REPLACE SHARED DATA FROM ${input.siteId}`
    ) {
      throw new DataPolicyTransitionError(
        `Replacing shared data requires the exact confirmation: REPLACE SHARED DATA FROM ${input.siteId}`,
        'protected_confirmation_required',
      );
    }
    const compatibility = getSqlite()!
      .prepare(
        `SELECT classification FROM portability_reports
          WHERE app_id = ? AND site_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.appId, input.siteId) as { classification: string } | undefined;
    if (
      !compatibility ||
      !new Set([
        'stateless-replica',
        'file-replica',
        'sqlite-replica',
        'adapter-managed-replica',
      ]).has(compatibility.classification) ||
      !replica.profileVersion
    ) {
      throw new DataPolicyTransitionError(
        'Rejoining shared data requires a current multi-site compatibility report and persisted reconciliation profile',
        'shared_data_compatibility_required',
      );
    }
    const sharedCheckpoint = getSqlite()!
      .prepare(
        `SELECT id, parent_id, sequence, database_artifact_digest,
                filesystem_artifact_digest, manifest_artifact_digest,
                schema_fingerprint, profile_version
           FROM data_checkpoints
          WHERE app_id = ? AND verification_status = 'verified'
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(input.appId) as Record<string, unknown> | undefined;
    const sharedCheckpointId = sharedCheckpoint ? String(sharedCheckpoint.id) : null;
    if (input.rejoinChoice !== 'replace-shared-from-site' && !sharedCheckpoint) {
      throw new DataPolicyTransitionError(
        'This rejoin choice requires a verified shared checkpoint to restore on the target',
        'shared_checkpoint_required',
      );
    }
    const deployment = getSqlite()!
      .prepare('SELECT name FROM deployments WHERE app_id = ?')
      .get(input.appId) as { name: string } | undefined;
    if (!deployment) {
      throw new DataPolicyTransitionError('Application not found', 'application_not_found', 404);
    }
    const importedApplicationId =
      input.rejoinChoice === 'import-site-as-new-application' ? sortableId('app') : null;
    const importedApplicationName = importedApplicationId
      ? `${deployment.name}-${input.siteId.replaceAll(/[^a-zA-Z0-9-]/g, '-').slice(-24)}-import-${importedApplicationId.slice(-6)}`
      : null;
    const namespace = latestNamespaceMetadata(replica.lastPolicyEventId);
    const siteLocalNamespaceId = namespace.siteLocalNamespaceId || sortableId('namespace');
    const required = requiredRejoinActions(input.rejoinChoice, sharedCheckpointId);
    const event = appendLocalFleetEvent({
      originSiteId: localSiteId,
      appId: input.appId,
      actor: input.updatedBy,
      operation: 'application.data.policy.transition.requested',
      parentEventId: replica.lastPolicyEventId || undefined,
      payload: {
        siteId: input.siteId,
        previousPolicy: replica.policy,
        policy: input.policy,
        transitionStatus: 'pending-target-processing',
        rejoinChoice: input.rejoinChoice,
        conflictPolicy,
        acknowledgedRisks,
        forkCheckpointId: namespace.forkCheckpointId,
        siteLocalNamespaceId,
        proposedSharedCheckpointId: sharedCheckpointId,
        proposedCheckpoint:
          sharedCheckpoint && input.rejoinChoice !== 'replace-shared-from-site'
            ? {
                checkpointId: sharedCheckpointId,
                parentId: sharedCheckpoint.parent_id || null,
                sequence: Number(sharedCheckpoint.sequence),
                databaseArtifactDigest: sharedCheckpoint.database_artifact_digest || null,
                filesystemArtifactDigest: sharedCheckpoint.filesystem_artifact_digest || null,
                manifestArtifactDigest: sharedCheckpoint.manifest_artifact_digest,
                schemaFingerprint: sharedCheckpoint.schema_fingerprint || null,
                profileVersion: sharedCheckpoint.profile_version || null,
              }
            : null,
        importedApplicationId,
        importedApplicationName,
        requiredActions: required.actions,
        consequence: required.consequence,
      },
      artifactDigests:
        sharedCheckpoint && input.rejoinChoice !== 'replace-shared-from-site'
          ? [
              sharedCheckpoint.database_artifact_digest,
              sharedCheckpoint.filesystem_artifact_digest,
              sharedCheckpoint.manifest_artifact_digest,
            ].filter((digest): digest is string => typeof digest === 'string')
          : [],
    });
    getSqlite()!
      .prepare(
        `UPDATE app_replicas SET last_policy_event_id = ?, updated_at = ?
          WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
      )
      .run(event.eventId, event.createdAt, input.appId, input.siteId);
    return {
      status: 'pending-target-processing',
      eventId: event.eventId,
      appId: input.appId,
      siteId: input.siteId,
      previousPolicy: 'none',
      policy: input.policy,
      rejoinChoice: input.rejoinChoice,
      requiredActions: required.actions,
      consequence: required.consequence,
    };
  }

  // A manual branch cannot silently become automatic, and a shared replica
  // cannot leave the lineage while it has work that has not been reconciled.
  if ((replica.policy === 'manual' && input.policy === 'automatic') || input.policy === 'none') {
    assertNoPendingWork(input.appId, input.siteId, replica);
  }

  const leavingSharedLineage = input.policy === 'none';
  const forkCheckpointId = leavingSharedLineage ? replica.baseCheckpointId : null;
  const siteLocalNamespaceId = leavingSharedLineage ? sortableId('namespace') : null;
  const baseCheckpointId = leavingSharedLineage ? null : replica.baseCheckpointId;
  const sharedLineage = leavingSharedLineage ? false : replica.sharedLineage;
  const consequence = leavingSharedLineage
    ? 'This replica now has an independent site-local namespace. Future records and files do not converge with Home or other suitcases.'
    : input.policy === 'manual'
      ? 'The replica retains its shared base, but data exchange and reconciliation require an administrator to choose Sync now.'
      : 'The replica retains its shared base and clean future changes may reconcile automatically.';
  const risks = leavingSharedLineage
    ? [...new Set([...acknowledgedRisks, consequence])]
    : acknowledgedRisks;
  const event = appendLocalFleetEvent({
    originSiteId: localSiteId,
    appId: input.appId,
    actor: input.updatedBy,
    operation: 'application.data.policy.updated',
    parentEventId: replica.lastPolicyEventId || undefined,
    payload: {
      siteId: input.siteId,
      previousPolicy: replica.policy,
      policy: input.policy,
      transitionStatus: 'completed',
      conflictPolicy,
      acknowledgedRisks: risks,
      dataTopology: leavingSharedLineage ? 'site-local' : 'syncs-across-sites',
      sharedLineage,
      baseCheckpointId,
      forkCheckpointId,
      siteLocalNamespaceId,
      affectedReplicaIds: [replica.id],
      clearBranch: leavingSharedLineage,
      consequence,
    },
  });
  const now = event.createdAt;
  const save = getSqlite()!.transaction(() => {
    upsertPolicy({
      appId: input.appId,
      siteId: input.siteId,
      policy: input.policy,
      conflictPolicy,
      acknowledgedRisks: risks,
      updatedBy: input.updatedBy,
      updatedAt: now,
    });
    getSqlite()!
      .prepare(
        `UPDATE app_replicas
            SET sync_policy = ?, shared_lineage = ?, data_mode = ?,
                base_checkpoint_id = ?,
                branch_checkpoint_id = CASE WHEN ? THEN NULL ELSE branch_checkpoint_id END,
                last_policy_event_id = ?, updated_at = ?
          WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
      )
      .run(
        input.policy,
        sharedLineage ? 1 : 0,
        leavingSharedLineage ? 'site-local' : 'replicated',
        baseCheckpointId,
        leavingSharedLineage ? 1 : 0,
        event.eventId,
        now,
        input.appId,
        input.siteId,
      );
  });
  save.immediate();
  if (leavingSharedLineage) {
    updateMaterialization({
      appId: input.appId,
      siteId: input.siteId,
      capability: 'data',
      desiredDigest: forkCheckpointId || siteLocalNamespaceId || undefined,
      availableDigest: forkCheckpointId || siteLocalNamespaceId || undefined,
      state: 'ready',
      blockers: [],
      evidence: [
        {
          source: 'policy-fork',
          detail: `${siteLocalNamespaceId}; forked from ${forkCheckpointId || 'an unseeded lineage'}`,
        },
      ],
    });
  }
  return {
    status: 'completed',
    eventId: event.eventId,
    appId: input.appId,
    siteId: input.siteId,
    previousPolicy: replica.policy,
    policy: input.policy,
    sharedLineage,
    baseCheckpointId,
    forkCheckpointId,
    siteLocalNamespaceId,
  };
}
