import { platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getArtifact, putArtifactFile } from './content-store.ts';
import {
  COMPONENT_SITE_COUNT_UPDATED,
  projectComponentSiteCount,
} from './component-site-overrides.ts';
import { assertApplicationSuitcaseDataMode } from './application-data-contract.ts';
import { loadFileManifestArtifact } from './data-reconciliation.ts';
import { buildFleetEventBody, canonicalFleetPayload, sortableId } from './multisite.ts';
import { applyAdministratorProjection, type AdministratorProjection } from './offline-auth.ts';
import {
  applySiteConfigurationProjection,
  type SiteConfigurationProjection,
} from './site-configuration-envelope.ts';
import { verifySitePayload } from './site-identity.ts';
import { getSqlite, retainApplicationRevisionArtifact } from './store.ts';
import type { WireFleetEvent } from './suitcase-transport.ts';
import {
  projectOpaqueVolumeAuthorityTransferEvent,
  projectOpaqueVolumeSnapshotEvent,
} from './volume-sync.ts';

export interface SuitcaseProjectionContext {
  fleetId: string;
  fleetName?: string;
  homeSiteId: string;
  localSiteId: string;
  localSiteName: string;
  rootPublicIdentity: string;
  localPublicKey: string;
  siteKeys: Record<string, string>;
  defaultDataPolicy: 'automatic' | 'manual' | 'none';
  accessMode: string;
  securityProfile: string;
  siteCredential: string;
}

const FORBIDDEN_VALUE_KEYS = new Set([
  'secretvalue',
  'secretvalues',
  'password',
  'passwords',
  'token',
  'tokens',
  'credential',
  'credentials',
  'privatekey',
  'environmentvalues',
  'envvalues',
]);

function assertNoSecretValues(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecretValues(child, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    if (FORBIDDEN_VALUE_KEYS.has(normalized)) {
      throw new Error(`Fleet event contains a forbidden configuration value at ${path}.${key}`);
    }
    assertNoSecretValues(child, `${path}.${key}`);
  }
}

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) throw new Error(`Fleet event payload requires ${key}`);
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Error(`Fleet event payload ${key} must be a string`);
  return value;
}

export function bootstrapSuitcaseFleet(context: SuitcaseProjectionContext): void {
  const sqlite = getSqlite()!;
  const existing = sqlite.prepare('SELECT id, home_site_id FROM fleets LIMIT 1').get() as
    | { id: string; home_site_id: string }
    | undefined;
  if (
    existing &&
    (existing.id !== context.fleetId || existing.home_site_id !== context.homeSiteId)
  ) {
    throw new Error('Suitcase database is already bound to a different fleet');
  }
  const now = new Date().toISOString();
  const save = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO fleets
          (id, name, protocol_version, root_public_identity, home_site_id, created_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      )
      .run(
        context.fleetId,
        context.fleetName || 'Home Fleet',
        context.rootPublicIdentity,
        context.homeSiteId,
        now,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO sites
          (id, fleet_id, node_id, name, kind, public_key, credential_status,
           platform, architecture, version, capabilities, mode, default_data_policy,
           access_mode, security_profile, readiness_summary, last_contact_at, created_at, updated_at)
         VALUES (?, ?, 'coordinator', 'Home', 'home', ?, 'active', ?, ?, 'fleet-sync', '{}',
                 'docked', 'automatic', 'existing-lan', 'isolated', '{}', ?, ?, ?)`,
      )
      .run(
        context.homeSiteId,
        context.fleetId,
        context.rootPublicIdentity,
        platform(),
        arch(),
        Date.now(),
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT INTO sites
          (id, fleet_id, node_id, name, kind, public_key, credential_status,
           platform, architecture, version, capabilities, mode, default_data_policy,
           access_mode, security_profile, readiness_summary, last_contact_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'suitcase', ?, 'active', ?, ?, 'fleet-sync', '{}',
                 'docked', ?, ?, ?, '{}', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key,
           name = excluded.name, default_data_policy = excluded.default_data_policy,
           access_mode = excluded.access_mode, security_profile = excluded.security_profile,
           updated_at = excluded.updated_at`,
      )
      .run(
        context.localSiteId,
        context.fleetId,
        context.localSiteId,
        context.localSiteName,
        context.localPublicKey,
        platform(),
        arch(),
        context.defaultDataPolicy,
        context.accessMode,
        context.securityProfile,
        Date.now(),
        now,
        now,
      );
    const insertPeer = sqlite.prepare(
      `INSERT OR IGNORE INTO sites
        (id, fleet_id, node_id, name, kind, public_key, credential_status,
         platform, architecture, version, capabilities, mode, default_data_policy,
         access_mode, security_profile, readiness_summary, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'suitcase', ?, 'active', NULL, NULL, 'fleet-sync', '{}',
               'away', 'none', 'existing-lan', 'isolated', '{}', ?, ?)`,
    );
    for (const [siteId, publicKey] of Object.entries(context.siteKeys)) {
      if (siteId === context.homeSiteId || siteId === context.localSiteId) continue;
      insertPeer.run(siteId, context.fleetId, siteId, siteId, publicKey, now, now);
    }
  });
  save.immediate();
}

function projectRevision(event: WireFleetEvent, context: SuitcaseProjectionContext): void {
  if (!event.appId) throw new Error('Application revision event requires an application id');
  const payload = event.payload;
  const targetSiteId = optionalString(payload, 'siteId');
  if (targetSiteId && targetSiteId !== context.localSiteId) return;
  const name = requiredString(payload, 'name');
  const digest = requiredString(payload, 'specDigest');
  const normalizedSpec = payload.normalizedSpec;
  if (normalizedSpec === undefined) throw new Error('Application revision requires normalizedSpec');
  const sqlite = getSqlite()!;
  const now = event.createdAt || new Date().toISOString();
  const aliases = sqlite
    .prepare(
      `SELECT app_id FROM application_aliases
        WHERE fleet_id = ? AND alias = ? AND state = 'active' AND app_id <> ?`,
    )
    .all(context.fleetId, name, event.appId) as Array<{ app_id: string }>;
  const aliasState = aliases.length ? 'conflict' : 'active';
  if (aliases.length) {
    sqlite
      .prepare(
        `UPDATE application_aliases SET state = 'conflict'
          WHERE fleet_id = ? AND alias = ? AND state = 'active'`,
      )
      .run(context.fleetId, name);
  }
  sqlite
    .prepare(
      `INSERT INTO deployments
        (name, type, username, status, desired_node_id, desired_spec_digest,
         active_spec_digest, configuration_digest, spec_source, app_id, data_mode,
         release_authority_epoch, release_generation, source_artifact_digest,
         image_artifact_digest, snapshot_artifact_digest, created_at, updated_at)
       VALUES (?, 'fleet', ?, 'stopped', ?, ?, NULL, ?, 'fleet:event', ?, 'single-site', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET desired_spec_digest = excluded.desired_spec_digest,
         configuration_digest = excluded.configuration_digest,
         source_artifact_digest = excluded.source_artifact_digest,
         image_artifact_digest = excluded.image_artifact_digest,
         snapshot_artifact_digest = excluded.snapshot_artifact_digest,
         app_id = excluded.app_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      name,
      event.actor || 'admin',
      context.localSiteId,
      digest,
      optionalString(payload, 'configurationDigest'),
      event.appId,
      event.authorityEpoch || 1,
      event.generation || 0,
      optionalString(payload, 'sourceArtifactDigest'),
      optionalString(payload, 'imageArtifactDigest'),
      optionalString(payload, 'snapshotArtifactDigest'),
      now,
      now,
    );
  const normalizedSource =
    typeof normalizedSpec === 'string' ? normalizedSpec : canonicalFleetPayload(normalizedSpec);
  const normalizedArtifactDigest = retainApplicationRevisionArtifact(
    normalizedSource,
    'application-spec-normalized',
    'application/vnd.deploy.local.application+json',
  );
  const originalSource = optionalString(payload, 'originalSource');
  const originalArtifactDigest = originalSource
    ? retainApplicationRevisionArtifact(
        originalSource,
        'application-spec-source',
        'application/yaml',
      )
    : null;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO application_spec_revisions
        (digest, deployment_name, parent_digest, api_version, source, manifest_format,
         normalized_spec, original_artifact_digest, normalized_artifact_digest,
         created_by, created_at)
       VALUES (?, ?, ?, ?, 'fleet:event', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      digest,
      name,
      optionalString(payload, 'parentDigest'),
      optionalString(payload, 'apiVersion') || 'deploy.local/v1',
      optionalString(payload, 'manifestFormat') || 'yaml',
      normalizedSource,
      originalArtifactDigest,
      normalizedArtifactDigest,
      event.actor,
      now,
    );
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO application_aliases
        (fleet_id, alias, app_id, origin_site_id, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(context.fleetId, name, event.appId, event.originSiteId, aliasState, now);
}

function projectReplica(event: WireFleetEvent, context: SuitcaseProjectionContext): void {
  if (!event.appId || event.payload.siteId !== context.localSiteId) return;
  const sqlite = getSqlite()!;
  const now = event.createdAt || new Date().toISOString();
  if (event.operation === 'application.replica.removed') {
    if (optionalString(event.payload, 'catalogOperationId')) {
      sqlite
        .prepare(
          `UPDATE app_replicas SET runtime_status = 'removal-pending', updated_at = ?
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .run(now, event.appId, context.localSiteId);
      return;
    }
    sqlite
      .prepare(
        `UPDATE app_replicas SET removed_at = ?, runtime_status = 'removed',
           shared_lineage = 0, updated_at = ? WHERE app_id = ? AND site_id = ?`,
      )
      .run(now, now, event.appId, context.localSiteId);
    return;
  }
  const policy = ['automatic', 'manual', 'none'].includes(String(event.payload.policy))
    ? String(event.payload.policy)
    : 'none';
  const declaredTopology = optionalString(event.payload, 'dataTopology');
  const dataTopology =
    declaredTopology === 'syncs-across-sites' ||
    declaredTopology === 'follows-one-site' ||
    declaredTopology === 'site-local'
      ? declaredTopology
      : policy === 'none'
        ? 'site-local'
        : 'syncs-across-sites';
  assertApplicationSuitcaseDataMode(event.appId, dataTopology);
  sqlite
    .prepare(
      `INSERT INTO app_replicas
        (id, app_id, site_id, desired_release_digest, runtime_status, data_mode,
         sync_policy, shared_lineage, profile_version, base_checkpoint_id, readiness,
         last_policy_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, '{}', ?, ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET
         desired_release_digest = excluded.desired_release_digest,
         runtime_status = 'pending', data_mode = excluded.data_mode,
         sync_policy = excluded.sync_policy, shared_lineage = excluded.shared_lineage,
         profile_version = excluded.profile_version,
         base_checkpoint_id = excluded.base_checkpoint_id, removed_at = NULL,
         last_policy_event_id = excluded.last_policy_event_id,
         updated_at = excluded.updated_at`,
    )
    .run(
      optionalString(event.payload, 'replicaId') || sortableId('replica'),
      event.appId,
      context.localSiteId,
      optionalString(event.payload, 'desiredReleaseDigest'),
      dataTopology === 'follows-one-site'
        ? 'follows-one-site-target'
        : dataTopology === 'site-local'
          ? 'site-local'
          : 'replicated',
      policy,
      event.payload.sharedLineage === true ? 1 : 0,
      optionalString(event.payload, 'profileDigest'),
      optionalString(event.payload, 'baseCheckpointId'),
      event.id,
      now,
      now,
    );
  sqlite
    .prepare(
      `INSERT INTO data_sync_policies
        (app_id, site_id, policy, conflict_policy, acknowledged_risks, revision, updated_by, updated_at)
       VALUES (?, ?, ?, ?, '[]', 1, ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET policy = excluded.policy,
         conflict_policy = excluded.conflict_policy, revision = data_sync_policies.revision + 1,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      event.appId,
      context.localSiteId,
      policy,
      optionalString(event.payload, 'conflictPolicy') || 'collect',
      event.actor,
      now,
    );
}

function projectPortabilityReport(event: WireFleetEvent, context: SuitcaseProjectionContext): void {
  if (!event.appId) throw new Error('Portability report requires an application id');
  const payload = event.payload;
  if (requiredString(payload, 'targetSiteId') !== context.localSiteId) return;
  const profile = payload.reconciliationProfile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('Portability report requires a reconciliation profile');
  }
  const item = profile as Record<string, unknown>;
  const arrays = [
    'sqliteFiles',
    'eligibleTables',
    'excludedTables',
    'uploadPaths',
    'opaquePaths',
  ] as const;
  for (const key of arrays) {
    if (!Array.isArray(item[key]))
      throw new Error(`Reconciliation profile ${key} must be an array`);
  }
  const conflictPolicy = requiredString(item, 'conflictPolicy');
  if (!['collect', 'prefer-home', 'prefer-suitcase'].includes(conflictPolicy)) {
    throw new Error('Reconciliation profile conflict policy is invalid');
  }
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const capabilityVector = payload.capabilityVector;
  if (
    !capabilityVector ||
    typeof capabilityVector !== 'object' ||
    Array.isArray(capabilityVector)
  ) {
    throw new Error('Portability report requires a capability vector');
  }
  const profileDigest = requiredString(payload, 'profileDigest');
  const profileCore = {
    analyzerVersion: requiredString(payload, 'analyzerVersion'),
    ...(optionalString(item, 'schemaFingerprint')
      ? { schemaFingerprint: optionalString(item, 'schemaFingerprint') }
      : {}),
    sqliteFiles: item.sqliteFiles,
    eligibleTables: item.eligibleTables,
    excludedTables: item.excludedTables,
    uploadPaths: item.uploadPaths,
    opaquePaths: item.opaquePaths,
    conflictPolicy,
  };
  const computedProfileDigest = `sha256:${createHash('sha256')
    .update(canonicalFleetPayload(profileCore))
    .digest('hex')}`;
  if (
    profileDigest !== computedProfileDigest ||
    requiredString(item, 'version') !== profileDigest
  ) {
    throw new Error('Portability report reconciliation profile digest does not match its content');
  }
  const compatibilityCore = {
    analyzerVersion: requiredString(payload, 'analyzerVersion'),
    ...(optionalString(item, 'schemaFingerprint')
      ? { schemaFingerprint: optionalString(item, 'schemaFingerprint') }
      : {}),
    eligibleTables: item.eligibleTables,
    excludedTables: item.excludedTables,
    uploadPaths: item.uploadPaths,
    conflictPolicy,
  };
  const computedCompatibilityDigest = `sha256:${createHash('sha256')
    .update(canonicalFleetPayload(compatibilityCore))
    .digest('hex')}`;
  if (requiredString(item, 'compatibilityDigest') !== computedCompatibilityDigest) {
    throw new Error('Portability report compatibility digest does not match its content');
  }
  const createdAt = requiredString(payload, 'createdAt');
  const sqlite = getSqlite()!;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO data_reconciliation_profiles
        (id, app_id, version, analyzer_version, schema_fingerprint, sqlite_files,
         eligible_tables, excluded_tables, upload_paths, opaque_paths, conflict_policy,
         compatibility_digest, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      profileDigest,
      event.appId,
      requiredString(item, 'version'),
      requiredString(payload, 'analyzerVersion'),
      optionalString(item, 'schemaFingerprint'),
      canonicalFleetPayload(item.sqliteFiles),
      canonicalFleetPayload(item.eligibleTables),
      canonicalFleetPayload(item.excludedTables),
      canonicalFleetPayload(item.uploadPaths),
      canonicalFleetPayload(item.opaquePaths),
      conflictPolicy,
      computedCompatibilityDigest,
      canonicalFleetPayload(findings),
      createdAt,
    );
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO portability_reports
        (id, app_id, spec_digest, site_id, analyzer_version, classification,
         capability_vector, findings, evidence, profile_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      requiredString(payload, 'reportId'),
      event.appId,
      requiredString(payload, 'specDigest'),
      context.localSiteId,
      requiredString(payload, 'analyzerVersion'),
      requiredString(payload, 'classification'),
      canonicalFleetPayload(capabilityVector),
      canonicalFleetPayload(findings),
      canonicalFleetPayload(evidence),
      profileDigest,
      createdAt,
    );
  sqlite
    .prepare(
      `UPDATE deployments SET reconciliation_profile_version = ?, updated_at = ?
        WHERE app_id = ?`,
    )
    .run(profileDigest, createdAt, event.appId);
}

/**
 * Project policy control separately from application data transfer. Policy
 * requests must reach a no-sync replica so an administrator can explicitly
 * re-enable it; they never carry database/file content themselves.
 */
export function projectFleetPolicyMutation(event: WireFleetEvent, localSiteId?: string): void {
  if (!event.appId) return;
  const siteId = optionalString(event.payload, 'siteId') || '';
  if (localSiteId && siteId && siteId !== localSiteId) return;
  const policy = requiredString(event.payload, 'policy');
  if (!['automatic', 'manual', 'none'].includes(policy)) throw new Error('Invalid data policy');
  const now = event.createdAt || new Date().toISOString();
  const sqlite = getSqlite()!;
  const declaredTopology = optionalString(event.payload, 'dataTopology');
  const existingReplica = siteId
    ? (sqlite
        .prepare(
          `SELECT data_mode FROM app_replicas
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .get(event.appId, siteId) as { data_mode: string } | undefined)
    : undefined;
  const contractMode =
    declaredTopology === 'syncs-across-sites' ||
    declaredTopology === 'follows-one-site' ||
    declaredTopology === 'site-local'
      ? declaredTopology
      : existingReplica?.data_mode.startsWith('follows-one-site')
        ? 'follows-one-site'
        : policy === 'none'
          ? 'site-local'
          : 'syncs-across-sites';
  assertApplicationSuitcaseDataMode(event.appId, contractMode);

  if (event.operation.startsWith('application.data.policy.transition.')) {
    if (
      event.operation === 'application.data.policy.transition.requested' &&
      event.payload.transitionStatus !== 'pending-target-processing'
    ) {
      throw new Error('Policy transition request must remain pending target processing');
    }
    if (event.operation !== 'application.data.policy.transition.completed') {
      if (event.operation === 'application.data.policy.transition.prepared') {
        projectCheckpoint(event);
      } else if (
        event.operation === 'application.data.policy.transition.requested' &&
        event.payload.proposedCheckpoint &&
        typeof event.payload.proposedCheckpoint === 'object' &&
        !Array.isArray(event.payload.proposedCheckpoint)
      ) {
        projectCheckpoint({
          ...event,
          payload: event.payload.proposedCheckpoint as Record<string, unknown>,
        });
      }
      if (siteId) {
        sqlite
          .prepare(
            `UPDATE app_replicas SET last_policy_event_id = ?, updated_at = ?
              WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
          )
          .run(event.id, now, event.appId, siteId);
      }
      return;
    }
  }

  const acknowledgedRisks = Array.isArray(event.payload.acknowledgedRisks)
    ? event.payload.acknowledgedRisks.filter((risk): risk is string => typeof risk === 'string')
    : [];
  sqlite
    .prepare(
      `INSERT INTO data_sync_policies
        (app_id, site_id, policy, conflict_policy, acknowledged_risks, revision, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(app_id, site_id) DO UPDATE SET policy = excluded.policy,
         conflict_policy = excluded.conflict_policy,
         acknowledged_risks = excluded.acknowledged_risks,
         revision = data_sync_policies.revision + 1,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    )
    .run(
      event.appId,
      siteId,
      policy,
      optionalString(event.payload, 'conflictPolicy') || 'collect',
      JSON.stringify(acknowledgedRisks),
      event.actor,
      now,
    );
  if (!siteId) return;

  const hasSharedLineage = typeof event.payload.sharedLineage === 'boolean';
  const hasBaseCheckpoint = Object.prototype.hasOwnProperty.call(event.payload, 'baseCheckpointId');
  const dataTopology = optionalString(event.payload, 'dataTopology');
  const projectedDataMode =
    dataTopology === 'site-local'
      ? 'site-local'
      : dataTopology === 'syncs-across-sites'
        ? 'replicated'
        : null;
  sqlite
    .prepare(
      `UPDATE app_replicas
          SET sync_policy = ?,
              shared_lineage = CASE WHEN ? THEN ? ELSE shared_lineage END,
              data_mode = CASE WHEN ? IS NOT NULL THEN ? ELSE data_mode END,
              base_checkpoint_id = CASE WHEN ? THEN ? ELSE base_checkpoint_id END,
              branch_checkpoint_id = CASE WHEN ? THEN NULL ELSE branch_checkpoint_id END,
              last_policy_event_id = ?, updated_at = ?
        WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(
      policy,
      hasSharedLineage ? 1 : 0,
      event.payload.sharedLineage === true ? 1 : 0,
      projectedDataMode,
      projectedDataMode,
      hasBaseCheckpoint ? 1 : 0,
      optionalString(event.payload, 'baseCheckpointId'),
      event.payload.clearBranch === true ? 1 : 0,
      event.id,
      now,
      event.appId,
      siteId,
    );
}

function projectCheckpoint(event: WireFleetEvent): void {
  if (!event.appId) throw new Error('Checkpoint event requires an application id');
  const payload = event.payload;
  const sqlite = getSqlite()!;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO data_checkpoints
        (id, app_id, parent_id, origin_site_id, sequence, database_artifact_digest,
         filesystem_artifact_digest, manifest_artifact_digest, schema_fingerprint,
         profile_version, verification_status, acknowledgements, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', '{}', ?)`,
    )
    .run(
      optionalString(payload, 'checkpointId') || event.id,
      event.appId,
      optionalString(payload, 'parentId'),
      event.originSiteId,
      Number(payload.sequence || event.generation || 0),
      optionalString(payload, 'databaseArtifactDigest'),
      optionalString(payload, 'filesystemArtifactDigest'),
      requiredString(payload, 'manifestArtifactDigest'),
      optionalString(payload, 'schemaFingerprint'),
      optionalString(payload, 'profileVersion'),
      event.createdAt,
    );
  const filesystemDigest = optionalString(payload, 'filesystemArtifactDigest');
  if (filesystemDigest) {
    const fileManifest = loadFileManifestArtifact(filesystemDigest);
    const insert = sqlite.prepare(
      `INSERT OR IGNORE INTO blob_references
        (app_id, logical_path, checkpoint_id, digest, metadata, marker, conflict_state)
       VALUES (?, ?, ?, ?, ?, 'present', NULL)`,
    );
    const checkpointId = optionalString(payload, 'checkpointId') || event.id;
    for (const entry of Object.values(fileManifest.entries)) {
      insert.run(
        event.appId,
        entry.path,
        checkpointId,
        entry.digest || null,
        JSON.stringify({ kind: entry.kind, byteSize: entry.byteSize, mode: entry.mode }),
      );
    }
  }
}

function projectChangeset(event: WireFleetEvent): void {
  if (!event.appId) throw new Error('Changeset event requires an application id');
  const payload = event.payload;
  const manifestDigest = requiredString(payload, 'branchManifestDigest');
  const manifest = getArtifact(manifestDigest);
  if (!manifest) throw new Error(`Changeset manifest ${manifestDigest} is not materialized`);
  const manifestBody = readFileSync(manifest.localPath, 'utf8');
  const parsedManifest = JSON.parse(manifestBody) as Record<string, unknown>;
  if (canonicalFleetPayload(parsedManifest) !== manifestBody) {
    throw new Error('Changeset manifest is not canonical');
  }
  const site = getSqlite()!
    .prepare('SELECT public_key FROM sites WHERE id = ? AND revoked_at IS NULL')
    .get(event.originSiteId) as { public_key: string } | undefined;
  if (
    !site ||
    !verifySitePayload(
      site.public_key,
      manifestBody,
      requiredString(payload, 'branchAuthenticatedDigest'),
    )
  ) {
    throw new Error('Changeset branch signature is invalid');
  }
  const manifestDatabaseDigest =
    optionalString(parsedManifest, 'databaseChangesetArtifactDigest') ||
    optionalString(parsedManifest, 'databaseArtifactDigest');
  const eventDatabaseDigest =
    optionalString(payload, 'databaseChangesetArtifactDigest') ||
    optionalString(payload, 'databaseArtifactDigest');
  const manifestBindings = {
    formatVersion: Number(parsedManifest.formatVersion),
    appId: optionalString(parsedManifest, 'appId'),
    originSiteId: optionalString(parsedManifest, 'originSiteId'),
    baseCheckpointId: optionalString(parsedManifest, 'baseCheckpointId'),
    schemaFingerprint: optionalString(parsedManifest, 'schemaFingerprint') || null,
    databaseArtifactDigest: manifestDatabaseDigest || null,
    fileManifestDigest: optionalString(parsedManifest, 'fileManifestDigest') || null,
  };
  const eventBindings = {
    formatVersion: 1,
    appId: event.appId,
    originSiteId: event.originSiteId,
    baseCheckpointId: optionalString(payload, 'baseCheckpointId'),
    schemaFingerprint: optionalString(payload, 'schemaFingerprint') || null,
    databaseArtifactDigest: eventDatabaseDigest || null,
    fileManifestDigest: optionalString(payload, 'fileDeltaArtifactDigest') || null,
  };
  if (canonicalFleetPayload(manifestBindings) !== canonicalFleetPayload(eventBindings)) {
    throw new Error('Changeset event does not match its signed branch manifest');
  }
  const result = getSqlite()!
    .prepare(
      `INSERT OR IGNORE INTO data_changesets
        (id, app_id, origin_site_id, base_checkpoint_id, branch_manifest_digest,
         schema_fingerprint, database_artifact_digest, file_delta_artifact_digest,
         authenticated_digest, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      requiredString(payload, 'changesetId'),
      event.appId,
      event.originSiteId,
      requiredString(payload, 'baseCheckpointId'),
      manifestDigest,
      optionalString(payload, 'schemaFingerprint'),
      eventDatabaseDigest,
      optionalString(payload, 'fileDeltaArtifactDigest'),
      requiredString(payload, 'branchAuthenticatedDigest'),
      event.createdAt,
    );
  if (result.changes) {
    getSqlite()!
      .prepare(
        `UPDATE app_replicas SET pending_changesets = pending_changesets + 1,
           branch_checkpoint_id = ?, updated_at = ?
         WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
      )
      .run(
        requiredString(payload, 'baseCheckpointId'),
        event.createdAt,
        event.appId,
        event.originSiteId,
      );
  }
}

function projectCheckpointAdoption(event: WireFleetEvent): void {
  if (!event.appId) throw new Error('Checkpoint adoption requires an application id');
  const siteId = requiredString(event.payload, 'siteId');
  const checkpointId = requiredString(event.payload, 'checkpointId');
  const checkpoint = getSqlite()!
    .prepare(
      `SELECT 1 FROM data_checkpoints
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(checkpointId, event.appId);
  if (!checkpoint) throw new Error('Checkpoint adoption references an unverified checkpoint');
  getSqlite()!
    .prepare(
      `UPDATE app_replicas SET base_checkpoint_id = ?, branch_checkpoint_id = NULL,
       pending_changesets = 0, updated_at = ?
       WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
    )
    .run(checkpointId, event.createdAt, event.appId, siteId);
}

/** Project authenticated data control records; blob contents are materialized separately. */
export function projectFleetDataMutation(event: WireFleetEvent): void {
  if (event.operation.startsWith('data.volume.authority.transfer.')) {
    projectOpaqueVolumeAuthorityTransferEvent(event);
  } else if (event.operation === 'data.checkpoint.created') projectCheckpoint(event);
  else if (event.operation === 'data.changeset.created') projectChangeset(event);
  else if (
    event.operation === 'data.volume.snapshot.created' ||
    event.operation === 'data.volume.authority.committed'
  ) {
    projectOpaqueVolumeSnapshotEvent(event);
    if (event.operation === 'data.volume.authority.committed' && event.appId) {
      assertApplicationSuitcaseDataMode(event.appId, 'follows-one-site');
      const siteId = requiredString(event.payload, 'authoritySiteId');
      const now = event.createdAt;
      getSqlite()!
        .prepare(
          "UPDATE deployments SET data_mode = 'follows-one-site', updated_at = ? WHERE app_id = ?",
        )
        .run(now, event.appId);
      getSqlite()!
        .prepare(
          `UPDATE app_replicas
              SET data_mode = CASE WHEN site_id = ? THEN 'follows-one-site-writer'
                                   ELSE 'follows-one-site-recovery' END,
                  runtime_status = CASE WHEN site_id = ? THEN runtime_status ELSE 'recovery-only' END,
                  updated_at = ?
            WHERE app_id = ? AND removed_at IS NULL`,
        )
        .run(siteId, siteId, now, event.appId);
    }
  } else if (
    event.operation === 'data.checkpoint.adopted' ||
    event.operation === 'data.checkpoint.acknowledged'
  )
    projectCheckpointAdoption(event);
}

export async function projectSuitcaseFleetEvent(
  event: WireFleetEvent,
  context: SuitcaseProjectionContext,
  artifactPaths: Record<string, string>,
): Promise<void> {
  if (event.fleetId !== context.fleetId) throw new Error('Fleet event targets a different fleet');
  const rebuiltBody = buildFleetEventBody(event);
  if (rebuiltBody !== event.body) throw new Error('Fleet event canonical body does not match');
  const publicKey = context.siteKeys[event.originSiteId];
  if (!publicKey || !verifySitePayload(publicKey, event.body, event.authenticatedDigest)) {
    throw new Error('Fleet event signature is invalid or its site identity is unknown');
  }
  assertNoSecretValues(event.payload);
  for (const digest of event.artifactDigests) {
    const path = artifactPaths[digest];
    if (!path) throw new Error(`Verified artifact ${digest} is unavailable to the projector`);
    const stored = await putArtifactFile(path, {
      type: 'fleet-event-artifact',
      createdByEventId: event.id,
      retentionClass: 'release',
    });
    if (stored.digest !== digest) throw new Error(`Artifact ${digest} failed digest verification`);
  }

  bootstrapSuitcaseFleet(context);
  const sqlite = getSqlite()!;
  const existing = sqlite
    .prepare('SELECT authenticated_digest FROM fleet_events WHERE id = ?')
    .get(event.id) as { authenticated_digest: string } | undefined;
  if (existing) {
    if (existing.authenticated_digest !== event.authenticatedDigest) {
      throw new Error('Fleet event id conflicts with a different authenticated event');
    }
    return;
  }
  const apply = sqlite.transaction(() => {
    if (
      event.operation === 'application.revision.activated' ||
      event.operation === 'application.revision.desired'
    )
      projectRevision(event, context);
    else if (event.operation === 'application.portability.reported')
      projectPortabilityReport(event, context);
    else if (
      event.operation === 'application.replica.selected' ||
      event.operation === 'application.replica.removed'
    )
      projectReplica(event, context);
    else if (event.operation === COMPONENT_SITE_COUNT_UPDATED)
      projectComponentSiteCount(event, context);
    else if (
      event.operation === 'application.data.policy.updated' ||
      event.operation === 'data.policy.updated' ||
      event.operation.startsWith('application.data.policy.transition.')
    )
      projectFleetPolicyMutation(event, context.localSiteId);
    else if (event.operation.startsWith('data.') && event.operation !== 'data.changeset.created')
      // Home is the v1 reconciliation authority. Other suitcases retain the
      // signed event but consume only Home's resulting checkpoint/adoption.
      projectFleetDataMutation(event);
    else if (event.operation === 'fleet.administrators.projected')
      applyAdministratorProjection(
        event.payload as unknown as AdministratorProjection,
        context.localSiteId,
      );
    else if (event.operation === 'application.configuration.projected')
      applySiteConfigurationProjection({
        projection: event.payload as unknown as SiteConfigurationProjection,
        localSiteId: context.localSiteId,
        siteCredential: context.siteCredential,
        actor: event.actor,
      });

    sqlite
      .prepare(
        `INSERT INTO fleet_events
          (id, fleet_id, origin_site_id, origin_sequence, app_id, authority_epoch,
           generation, actor, operation, schema_version, payload, artifact_digests,
           parent_event_id, authenticated_digest, created_at, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.fleetId,
        event.originSiteId,
        event.originSequence,
        event.appId,
        event.authorityEpoch,
        event.generation,
        event.actor,
        event.operation,
        event.schemaVersion,
        canonicalFleetPayload(event.payload),
        canonicalFleetPayload(event.artifactDigests),
        event.parentEventId,
        event.authenticatedDigest,
        event.createdAt,
        new Date().toISOString(),
      );
  });
  apply.immediate();
}
