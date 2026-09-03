import { openSync, closeSync, readSync, statSync } from 'node:fs';
import {
  appendArtifactTransferChunk,
  beginArtifactTransfer,
  getArtifact,
  type ArtifactMetadata,
} from './content-store.ts';
import {
  MULTISITE_PROTOCOL_VERSION,
  authenticateSite,
  buildFleetEventBody,
  canonicalFleetPayload,
  ensureFleetIdentity,
  listTopology,
  updateSitePresence,
  verifyRemoteFleetEvent,
  type SiteMode,
} from './multisite.ts';
import { getSqlite, retainApplicationRevisionArtifact } from './store.ts';
import { projectFleetDataMutation, projectFleetPolicyMutation } from './suitcase-projector.ts';
import {
  applicationSpecDigest,
  canonicalApplicationJson,
  parseStoredApplicationSpec,
} from './application-spec.ts';
import {
  ingestFleetTelemetryRecords,
  validateFleetTelemetryRecord,
  type WireFleetTelemetryRecord,
} from './fleet-telemetry.ts';
import {
  isManualDataSyncControlOperation,
  manualDataSyncControlTarget,
  MANUAL_DATA_SYNC_COMPLETED,
  MANUAL_DATA_SYNC_FAILED,
  MANUAL_DATA_SYNC_REQUESTED,
} from './manual-data-sync.ts';
import {
  FLEET_MUTATION_ACKNOWLEDGED,
  FLEET_MUTATION_REQUESTED,
  fleetMutationControlTargets,
  isFleetMutationControlOperation,
} from './fleet-mutation-guard.ts';
import { COMPONENT_SITE_COUNT_UPDATED } from './component-site-overrides.ts';
import { assertApplicationSuitcaseDataMode } from './application-data-contract.ts';

const EVENT_LIMIT = 200;
const MAX_ARTIFACT_CHUNK_BYTES = 4 * 1024 * 1024;
const ID_PATTERN = /^[a-z][a-z0-9_-]{2,191}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CANDIDATE_OPERATIONS = new Set([
  'application.command.candidate',
  'application.release.candidate',
  'application.offline.release.candidate',
  'application.configuration.candidate',
]);

export class SuitcaseProtocolError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    status = 400,
    code = 'invalid_request',
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SuitcaseProtocolError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface SiteAuthorization {
  siteId: string;
  fleetId: string;
  homeSiteId: string;
  protocolVersion: number;
}

export interface WireFleetEvent {
  id: string;
  fleetId: string;
  originSiteId: string;
  originSequence: number;
  appId: string | null;
  authorityEpoch: number | null;
  generation: number | null;
  actor: string;
  operation: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  artifactDigests: string[];
  parentEventId: string | null;
  body: string;
  authenticatedDigest: string;
  createdAt: string;
}

export interface SuitcaseExchangeInput {
  protocolVersion: number;
  fleetId?: string;
  mode?: SiteMode;
  capabilities?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  networkFingerprint?: string;
  cursors?: Record<string, number>;
  events?: WireFleetEvent[];
  telemetryCursors?: Record<string, number>;
  telemetry?: WireFleetTelemetryRecord[];
  manualSync?: boolean;
  /** When present, explicit manual admission is limited to these applications. */
  manualSyncAppIds?: string[];
}

interface SiteRow {
  id: string;
  fleet_id: string;
  kind: string;
  credential_status: string;
  revoked_at: string | null;
  mode: string;
  platform: string | null;
  access_mode: string;
  capabilities: string;
  readiness_summary: string;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SuitcaseProtocolError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function siteRow(siteId: string): SiteRow | undefined {
  return getSqlite()!
    .prepare(
      `SELECT id, fleet_id, kind, credential_status, revoked_at, mode,
              platform, access_mode, capabilities, readiness_summary
         FROM sites WHERE id = ?`,
    )
    .get(siteId) as SiteRow | undefined;
}

export function authorizeSuitcaseSite(input: {
  siteId?: string;
  credential?: string;
  protocolVersion?: string | number;
}): SiteAuthorization {
  const protocolVersion = Number(input.protocolVersion);
  if (protocolVersion !== MULTISITE_PROTOCOL_VERSION) {
    throw new SuitcaseProtocolError(
      `Suitcase protocol ${MULTISITE_PROTOCOL_VERSION} is required`,
      426,
      'protocol_version_mismatch',
    );
  }
  if (!input.siteId || !input.credential) {
    throw new SuitcaseProtocolError(
      'Suitcase site credential required',
      401,
      'credential_required',
    );
  }
  const row = siteRow(input.siteId);
  if (!row || row.kind !== 'suitcase') {
    throw new SuitcaseProtocolError('Unknown suitcase identity', 401, 'invalid_credential');
  }
  if (row.revoked_at || row.credential_status === 'revoked') {
    throw new SuitcaseProtocolError('Suitcase identity has been revoked', 403, 'site_revoked');
  }
  if (row.credential_status === 'recovery-pending') {
    throw new SuitcaseProtocolError(
      'Recovered Home requires a signed Suitcase re-adoption proof',
      428,
      'recovery_readoption_required',
    );
  }
  if (row.credential_status === 'rotation-required') {
    throw new SuitcaseProtocolError(
      'Suitcase credential rotation must complete before synchronization',
      428,
      'credential_rotation_required',
    );
  }
  if (row.credential_status !== 'active') {
    throw new SuitcaseProtocolError(
      'Suitcase identity is quarantined for administrator review',
      403,
      'site_quarantined',
    );
  }
  if (!authenticateSite(input.siteId, input.credential)) {
    throw new SuitcaseProtocolError('Invalid suitcase credential', 401, 'invalid_credential');
  }
  const fleet = ensureFleetIdentity();
  if (row.fleet_id !== fleet.id) {
    throw new SuitcaseProtocolError('Suitcase belongs to another fleet', 403, 'fleet_mismatch');
  }
  return {
    siteId: input.siteId,
    fleetId: fleet.id,
    homeSiteId: fleet.homeSiteId,
    protocolVersion,
  };
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'string') return requireRecord(value, label);
  try {
    return requireRecord(JSON.parse(value), label);
  } catch (error) {
    if (error instanceof SuitcaseProtocolError) throw error;
    throw new SuitcaseProtocolError(`${label} is invalid JSON`);
  }
}

function parseJsonStrings(value: unknown, label: string): string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new SuitcaseProtocolError(`${label} is invalid JSON`);
    }
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new SuitcaseProtocolError(`${label} must be an array of strings`);
  }
  return parsed;
}

function wireEventFromRow(row: Record<string, unknown>): WireFleetEvent {
  const payload = parseJsonObject(row.payload, 'event payload');
  const artifactDigests = parseJsonStrings(row.artifact_digests, 'event artifact digests');
  const event = {
    id: String(row.id),
    fleetId: String(row.fleet_id),
    originSiteId: String(row.origin_site_id),
    originSequence: Number(row.origin_sequence),
    appId: row.app_id ? String(row.app_id) : null,
    authorityEpoch: row.authority_epoch === null ? null : Number(row.authority_epoch),
    generation: row.generation === null ? null : Number(row.generation),
    actor: String(row.actor),
    operation: String(row.operation),
    schemaVersion: Number(row.schema_version),
    payload,
    artifactDigests,
    parentEventId: row.parent_event_id ? String(row.parent_event_id) : null,
    authenticatedDigest: String(row.authenticated_digest),
    createdAt: String(row.created_at),
  };
  return { ...event, body: buildFleetEventBody(event) };
}

function requireCursorMap(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  const record = requireRecord(value, 'cursors');
  return Object.fromEntries(
    Object.entries(record).map(([originSiteId, cursor]) => {
      if (!ID_PATTERN.test(originSiteId) || !Number.isSafeInteger(cursor) || Number(cursor) < 0) {
        throw new SuitcaseProtocolError(
          'Cursor entries require a site ID and non-negative integer',
        );
      }
      return [originSiteId, Number(cursor)];
    }),
  );
}

function validateWireEvent(value: unknown, auth: SiteAuthorization): WireFleetEvent {
  const event = requireRecord(value, 'event') as unknown as WireFleetEvent;
  if (!ID_PATTERN.test(event.id) || !ID_PATTERN.test(event.originSiteId)) {
    throw new SuitcaseProtocolError('Event identity is invalid');
  }
  if (
    event.fleetId !== auth.fleetId ||
    event.originSiteId !== auth.siteId ||
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.originSequence) ||
    event.originSequence < 1
  ) {
    throw new SuitcaseProtocolError('Event fleet, origin, schema, or sequence is invalid');
  }
  if (event.appId !== null && (typeof event.appId !== 'string' || !ID_PATTERN.test(event.appId))) {
    throw new SuitcaseProtocolError('Event application identity is invalid');
  }
  if (
    !event.actor ||
    typeof event.actor !== 'string' ||
    !event.operation ||
    typeof event.operation !== 'string'
  ) {
    throw new SuitcaseProtocolError('Event actor and operation are required');
  }
  event.payload = requireRecord(event.payload, 'event payload');
  event.artifactDigests = parseJsonStrings(event.artifactDigests, 'event artifact digests');
  if (event.artifactDigests.some((digest) => !DIGEST_PATTERN.test(digest))) {
    throw new SuitcaseProtocolError('Event contains an invalid artifact digest');
  }
  if (typeof event.body !== 'string' || typeof event.authenticatedDigest !== 'string') {
    throw new SuitcaseProtocolError('Signed event body and digest are required');
  }
  let signed: Record<string, unknown>;
  try {
    signed = requireRecord(JSON.parse(event.body), 'signed event body');
  } catch {
    throw new SuitcaseProtocolError('Signed event body is invalid JSON');
  }
  if (canonicalFleetPayload(signed) !== event.body || buildFleetEventBody(event) !== event.body) {
    throw new SuitcaseProtocolError('Signed event body does not match its envelope');
  }
  if (!verifyRemoteFleetEvent(event as unknown as Record<string, unknown>)) {
    throw new SuitcaseProtocolError('Event signature is invalid', 403, 'invalid_event_signature');
  }
  if (
    event.operation === FLEET_MUTATION_REQUESTED ||
    event.operation === COMPONENT_SITE_COUNT_UPDATED
  ) {
    throw new SuitcaseProtocolError(
      'Fleet control intent must be authored by the Home coordinator',
      403,
      'coordinator_control_required',
    );
  }
  if (event.operation === 'application.revision.activated') {
    throw new SuitcaseProtocolError(
      'Suitcase revisions must return as reviewable release candidates',
      409,
      'release_candidate_required',
    );
  }
  return event;
}

function updateCursor(
  localSiteId: string,
  remoteSiteId: string,
  stream: string,
  sequence: number,
  successful: boolean,
): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO site_sync_cursors
        (local_site_id, remote_site_id, stream, last_accepted_sequence,
         protocol_version, last_attempt_at, last_success_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(local_site_id, remote_site_id, stream) DO UPDATE SET
         last_accepted_sequence = MAX(last_accepted_sequence, excluded.last_accepted_sequence),
         protocol_version = excluded.protocol_version,
         last_attempt_at = excluded.last_attempt_at,
         last_success_at = COALESCE(excluded.last_success_at, last_success_at)`,
    )
    .run(
      localSiteId,
      remoteSiteId,
      stream,
      sequence,
      MULTISITE_PROTOCOL_VERSION,
      now,
      successful ? now : null,
    );
}

function importOfflineApplicationCandidate(event: WireFleetEvent): void {
  if (event.operation !== 'application.offline.release.candidate' || !event.appId) return;
  const payload = event.payload;
  const required = (key: string): string => {
    const value = payload[key];
    if (typeof value !== 'string' || !value) {
      throw new SuitcaseProtocolError(`Offline release candidate requires ${key}`);
    }
    return value;
  };
  if (payload.appId !== event.appId) {
    throw new SuitcaseProtocolError('Offline release candidate application identity differs');
  }
  const name = required('name');
  if (name.length > 128 || /[\r\n/]/.test(name)) {
    throw new SuitcaseProtocolError('Offline release candidate name is invalid');
  }
  const specDigest = required('specDigest');
  if (!DIGEST_PATTERN.test(specDigest)) {
    throw new SuitcaseProtocolError('Offline release candidate spec digest is invalid');
  }
  const normalizedSpec = required('normalizedSpec');
  try {
    const spec = parseStoredApplicationSpec(normalizedSpec);
    if (
      canonicalApplicationJson(spec) !== normalizedSpec ||
      applicationSpecDigest(spec) !== specDigest
    ) {
      throw new Error('digest mismatch');
    }
  } catch {
    throw new SuitcaseProtocolError('Offline release candidate application graph is invalid');
  }
  const sqlite = getSqlite()!;
  const existing = sqlite
    .prepare('SELECT name FROM deployments WHERE app_id = ?')
    .get(event.appId) as { name: string } | undefined;
  if (existing && existing.name !== name) {
    throw new SuitcaseProtocolError('Offline release candidate cannot rename an existing app');
  }
  const now = event.createdAt || new Date().toISOString();
  let deploymentName = existing?.name || name;
  if (!existing) {
    const aliasOwners = sqlite
      .prepare(
        `SELECT app_id FROM application_aliases
          WHERE fleet_id = ? AND alias = ? AND app_id <> ? AND state IN ('active', 'reserved')`,
      )
      .all(event.fleetId, name, event.appId) as Array<{ app_id: string }>;
    const deploymentCollision = sqlite
      .prepare('SELECT app_id FROM deployments WHERE name = ? AND app_id <> ?')
      .get(name, event.appId) as { app_id: string | null } | undefined;
    const conflict = aliasOwners.length > 0 || Boolean(deploymentCollision);
    if (conflict) {
      deploymentName = `candidate-${event.appId}`.slice(0, 128);
      sqlite
        .prepare(
          `UPDATE application_aliases SET state = 'conflict'
            WHERE fleet_id = ? AND alias = ? AND state IN ('active', 'reserved')`,
        )
        .run(event.fleetId, name);
    }
    sqlite
      .prepare(
        `INSERT INTO deployments
          (name, type, username, status, app_id, spec_source, release_authority_epoch,
           release_generation, created_at, updated_at)
         VALUES (?, 'fleet-candidate', ?, 'candidate', ?, 'offline-candidate', ?, ?, ?, ?)`,
      )
      .run(
        deploymentName,
        event.actor,
        event.appId,
        Number(payload.baseAuthorityEpoch ?? event.authorityEpoch ?? 1),
        Number(payload.baseGeneration ?? event.generation ?? 0),
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO application_aliases
          (fleet_id, alias, app_id, origin_site_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.fleetId,
        name,
        event.appId,
        event.originSiteId,
        conflict ? 'conflict' : 'reserved',
        now,
      );
  }
  const stored = sqlite
    .prepare(
      `SELECT normalized_spec FROM application_spec_revisions
        WHERE deployment_name = ? AND digest = ?`,
    )
    .get(deploymentName, specDigest) as { normalized_spec: string } | undefined;
  if (stored && stored.normalized_spec !== normalizedSpec) {
    throw new SuitcaseProtocolError('Offline release candidate revision digest conflicts');
  }
  const normalizedArtifactDigest = retainApplicationRevisionArtifact(
    normalizedSpec,
    'application-spec-normalized',
    'application/vnd.deploy.local.application+json',
  );
  const originalSource =
    typeof payload.originalSource === 'string' ? payload.originalSource : undefined;
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
       VALUES (?, ?, ?, ?, 'fleet:offline-candidate', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      specDigest,
      deploymentName,
      typeof payload.parentDigest === 'string' ? payload.parentDigest : null,
      typeof payload.apiVersion === 'string' ? payload.apiVersion : 'deploy.local/v1',
      required('manifestFormat'),
      normalizedSpec,
      originalArtifactDigest,
      normalizedArtifactDigest,
      event.actor,
      now,
    );
}

function recordReleaseCandidate(event: WireFleetEvent): void {
  if (
    event.operation !== 'application.release.candidate' &&
    event.operation !== 'application.offline.release.candidate'
  )
    return;
  if (!event.appId) throw new SuitcaseProtocolError('Release candidate requires an app ID');
  importOfflineApplicationCandidate(event);
  const payload = event.payload;
  const baseAuthorityEpoch = Number(payload.baseAuthorityEpoch ?? event.authorityEpoch);
  const baseGeneration = Number(payload.baseGeneration ?? event.generation);
  if (!Number.isSafeInteger(baseAuthorityEpoch) || !Number.isSafeInteger(baseGeneration)) {
    throw new SuitcaseProtocolError('Release candidate requires base authority and generation');
  }
  const optionalDigest = (key: string): string | null => {
    const value = payload[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
      throw new SuitcaseProtocolError(`Release candidate ${key} is invalid`);
    }
    return value;
  };
  getSqlite()!
    .prepare(
      `INSERT OR IGNORE INTO release_candidates
        (id, app_id, origin_site_id, actor, base_authority_epoch, base_generation,
         spec_digest, parent_spec_digest, requested_alias, source_artifact_digest,
         image_artifact_digest, snapshot_artifact_digest, artifact_digests,
         configuration_digest, architecture, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      event.id,
      event.appId,
      event.originSiteId,
      event.actor,
      baseAuthorityEpoch,
      baseGeneration,
      optionalDigest('specDigest'),
      optionalDigest('parentDigest'),
      typeof payload.name === 'string' ? payload.name : null,
      optionalDigest('sourceArtifactDigest'),
      optionalDigest('imageArtifactDigest'),
      optionalDigest('snapshotArtifactDigest'),
      canonicalFleetPayload(event.artifactDigests),
      typeof payload.configurationDigest === 'string' ? payload.configurationDigest : null,
      typeof payload.architecture === 'string' ? payload.architecture : null,
      new Date().toISOString(),
    );
}

function isPolicyControlEvent(event: Pick<WireFleetEvent, 'operation'>): boolean {
  return (
    event.operation === 'application.data.policy.updated' ||
    event.operation.startsWith('application.data.policy.transition.') ||
    event.operation === 'data.policy.updated'
  );
}

function isDataEvent(event: Pick<WireFleetEvent, 'operation'>): boolean {
  return (
    !isPolicyControlEvent(event) &&
    (event.operation.startsWith('data.') || event.operation.startsWith('application.data.'))
  );
}

function isVolumeAuthorityTransferEvent(event: Pick<WireFleetEvent, 'operation'>): boolean {
  return event.operation.startsWith('data.volume.authority.transfer.');
}

function effectiveDataPolicy(
  appId: string | null,
  siteId: string,
): 'automatic' | 'manual' | 'none' {
  const sqlite = getSqlite()!;
  const site = sqlite.prepare('SELECT default_data_policy FROM sites WHERE id = ?').get(siteId) as
    | { default_data_policy: string }
    | undefined;
  if (!appId) return 'none';
  const row = sqlite
    .prepare(
      `SELECT COALESCE(
                (SELECT policy FROM data_sync_policies WHERE app_id = ? AND site_id = ?),
                (SELECT policy FROM data_sync_policies WHERE app_id = ? AND site_id = ''),
                (SELECT sync_policy FROM app_replicas WHERE app_id = ? AND site_id = ?),
                ?
              ) AS policy`,
    )
    .get(appId, siteId, appId, appId, siteId, site?.default_data_policy || 'none') as {
    policy: string;
  };
  return row.policy === 'automatic' || row.policy === 'manual' ? row.policy : 'none';
}

function telemetryArtifactAllowed(
  record: WireFleetTelemetryRecord,
  siteId: string,
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
): boolean {
  if (record.kind !== 'backup' || !record.appId) return record.kind !== 'backup';
  const policy = effectiveDataPolicy(record.appId, siteId);
  return (
    policy === 'automatic' ||
    (policy === 'manual' && manualSyncAllowed(record.appId, manualSync, manualSyncAppIds))
  );
}

function outgoingTelemetry(
  auth: SiteAuthorization,
  cursors: Record<string, number>,
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
) {
  const rows = getSqlite()!
    .prepare(
      `SELECT * FROM fleet_telemetry_records
        WHERE fleet_id = ? AND origin_site_id <> ?
        ORDER BY created_at, origin_site_id, origin_sequence`,
    )
    .all(auth.fleetId, auth.siteId) as Array<Record<string, unknown>>;
  const telemetry: WireFleetTelemetryRecord[] = [];
  let hasMore = false;
  for (const row of rows) {
    const originSiteId = String(row.origin_site_id);
    if (Number(row.origin_sequence) <= (cursors[originSiteId] ?? 0)) continue;
    if (telemetry.length >= EVENT_LIMIT) {
      hasMore = true;
      continue;
    }
    const record = validateFleetTelemetryRecord(
      {
        id: row.id,
        fleetId: row.fleet_id,
        originSiteId: row.origin_site_id,
        originSequence: row.origin_sequence,
        kind: row.kind,
        appId: row.app_id,
        deploymentName: row.deployment_name,
        logicalKey: row.logical_key,
        observedAt: row.observed_at,
        payload: row.payload,
        artifactDigests: row.artifact_digests,
        createdAt: row.created_at,
      },
      { fleetId: auth.fleetId },
    );
    telemetry.push(
      telemetryArtifactAllowed(record, auth.siteId, manualSync, manualSyncAppIds)
        ? record
        : {
            ...record,
            artifactDigests: [],
            payload: { ...record.payload, contentAvailable: false, contentLocation: 'origin-site' },
          },
    );
  }
  return { telemetry, hasMore };
}

function manualSyncAllowed(
  appId: string | null,
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
): boolean {
  return manualSync && (!manualSyncAppIds || Boolean(appId && manualSyncAppIds.has(appId)));
}

function requireDataPolicy(
  event: WireFleetEvent,
  siteId: string,
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
): void {
  // Administrative control must reach its selected suitcase even while the
  // corresponding data stream is paused by manual or no-sync policy.
  if (
    isManualDataSyncControlOperation(event.operation) ||
    isFleetMutationControlOperation(event.operation)
  )
    return;
  if (!isDataEvent(event) || isVolumeAuthorityTransferEvent(event)) return;
  if (event.appId) {
    const removedReplica = getSqlite()!
      .prepare(
        `SELECT removed_at FROM app_replicas
          WHERE app_id = ? AND site_id = ? AND removed_at IS NOT NULL`,
      )
      .get(event.appId, siteId) as { removed_at: string } | undefined;
    if (removedReplica) {
      throw new SuitcaseProtocolError(
        `Replica ${siteId} was explicitly removed; its future data branch is quarantined`,
        409,
        'replica_branch_quarantined',
      );
    }
    if (event.operation === 'data.changeset.created') {
      const replica = getSqlite()!
        .prepare(
          `SELECT data_mode, shared_lineage FROM app_replicas
            WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
        )
        .get(event.appId, siteId) as { data_mode: string; shared_lineage: number } | undefined;
      if (!replica) {
        throw new SuitcaseProtocolError(
          `Application ${event.appId} is not selected on suitcase ${siteId}`,
          409,
          'replica_not_selected',
        );
      }
      if (replica.data_mode !== 'replicated' || replica.shared_lineage !== 1) {
        throw new SuitcaseProtocolError(
          `Application ${event.appId} cannot submit shared changesets from data mode ${replica.data_mode}`,
          409,
          'changeset_topology_forbidden',
        );
      }
      try {
        assertApplicationSuitcaseDataMode(event.appId, 'syncs-across-sites');
      } catch (error) {
        throw new SuitcaseProtocolError(
          error instanceof Error ? error.message : String(error),
          409,
          'changeset_data_contract_forbidden',
        );
      }
    }
  }
  const policy = effectiveDataPolicy(event.appId, siteId);
  if (policy === 'none') {
    throw new SuitcaseProtocolError(
      `Data sync is disabled for ${event.appId || 'this application'} on ${siteId}`,
      409,
      'data_sync_disabled',
    );
  }
  if (policy === 'manual' && !manualSyncAllowed(event.appId, manualSync, manualSyncAppIds)) {
    throw new SuitcaseProtocolError(
      `Data sync for ${event.appId || 'this application'} requires an explicit sync now`,
      409,
      'manual_sync_required',
    );
  }
}

function ingestEvents(
  auth: SiteAuthorization,
  input: unknown[],
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
): { acceptedThrough: number; replayed: number } {
  const sqlite = getSqlite()!;
  let acceptedThrough = Number(
    (
      sqlite
        .prepare(
          'SELECT COALESCE(MAX(origin_sequence), 0) AS sequence FROM fleet_events WHERE origin_site_id = ?',
        )
        .get(auth.siteId) as { sequence: number }
    ).sequence,
  );
  let replayed = 0;
  const insert = sqlite.transaction(() => {
    for (const raw of input) {
      const event = validateWireEvent(raw, auth);
      requireDataPolicy(event, auth.siteId, manualSync, manualSyncAppIds);
      const existing = sqlite
        .prepare(
          `SELECT id, authenticated_digest FROM fleet_events
            WHERE origin_site_id = ? AND origin_sequence = ?`,
        )
        .get(event.originSiteId, event.originSequence) as
        | { id: string; authenticated_digest: string }
        | undefined;
      if (existing) {
        if (
          existing.id !== event.id ||
          existing.authenticated_digest !== event.authenticatedDigest
        ) {
          throw new SuitcaseProtocolError(
            `Event sequence ${event.originSequence} conflicts with an accepted event`,
            409,
            'event_replay_conflict',
          );
        }
        replayed += 1;
        acceptedThrough = Math.max(acceptedThrough, event.originSequence);
        continue;
      }
      if (event.originSequence !== acceptedThrough + 1) {
        throw new SuitcaseProtocolError(
          `Expected event sequence ${acceptedThrough + 1}`,
          409,
          'event_sequence_gap',
        );
      }
      recordReleaseCandidate(event);
      if (isPolicyControlEvent(event)) projectFleetPolicyMutation(event);
      else if (isDataEvent(event)) projectFleetDataMutation(event);
      const isCandidate = CANDIDATE_OPERATIONS.has(event.operation);
      const now = new Date().toISOString();
      sqlite
        .prepare(
          `INSERT INTO fleet_events
            (id, fleet_id, origin_site_id, origin_sequence, app_id, authority_epoch,
             generation, actor, operation, schema_version, payload, artifact_digests,
             parent_event_id, authenticated_digest, created_at, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
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
          canonicalFleetPayload(event.payload),
          canonicalFleetPayload(event.artifactDigests),
          event.parentEventId,
          event.authenticatedDigest,
          now,
          isCandidate ? null : now,
        );
      acceptedThrough = event.originSequence;
    }
  });
  insert.immediate();
  updateCursor(auth.homeSiteId, auth.siteId, `events:${auth.siteId}`, acceptedThrough, true);
  return { acceptedThrough, replayed };
}

function outgoingEvents(
  auth: SiteAuthorization,
  cursors: Record<string, number>,
  manualSync: boolean,
  manualSyncAppIds?: ReadonlySet<string>,
) {
  const rows = getSqlite()!
    .prepare('SELECT * FROM fleet_events WHERE fleet_id = ? ORDER BY created_at, id')
    .all(auth.fleetId) as Array<Record<string, unknown>>;
  const pending = rows.filter((row) => {
    const origin = String(row.origin_site_id);
    return origin !== auth.siteId && Number(row.origin_sequence) > (cursors[origin] ?? 0);
  });
  const events: WireFleetEvent[] = [];
  const skippedSequences: Record<string, number[]> = {};
  const deferredOrigins = new Set<string>();
  let decisions = 0;
  let hasMore = false;
  for (const row of pending) {
    const event = wireEventFromRow(row);
    if (deferredOrigins.has(event.originSiteId)) continue;
    if (decisions >= EVENT_LIMIT) {
      hasMore = true;
      continue;
    }
    const controlTargets = [
      ...(manualDataSyncControlTarget(event) ? [manualDataSyncControlTarget(event)!] : []),
      ...fleetMutationControlTargets(event),
    ];
    if (controlTargets.length > 0 && !controlTargets.includes(auth.siteId)) {
      decisions += 1;
      (skippedSequences[event.originSiteId] ??= []).push(event.originSequence);
      continue;
    }
    const policy =
      isDataEvent(event) &&
      !isVolumeAuthorityTransferEvent(event) &&
      !isManualDataSyncControlOperation(event.operation) &&
      !isFleetMutationControlOperation(event.operation)
        ? effectiveDataPolicy(event.appId, auth.siteId)
        : 'automatic';
    if (policy === 'manual' && !manualSyncAllowed(event.appId, manualSync, manualSyncAppIds)) {
      // A background pass must not consume the cursor for manual data. It also
      // cannot send later events from the same origin without creating a gap.
      deferredOrigins.add(event.originSiteId);
      continue;
    }
    decisions += 1;
    if (policy === 'none') {
      // "none" is an explicit permanent exclusion for this replica. Report the
      // skipped sequence so the receiver can advance without retrying forever.
      (skippedSequences[event.originSiteId] ??= []).push(event.originSequence);
      continue;
    }
    events.push(event);
  }
  return {
    events,
    skippedSequences,
    deferredOrigins: [...deferredOrigins],
    hasMore,
  };
}

/**
 * Control events have their own authenticated lane so an earlier deferred
 * manual data event cannot block an administrator's request behind a cursor.
 * The ordinary stream may deliver the same event later; both the inbox and
 * projector already deduplicate by signed event identity.
 */
function outgoingAdministrativeControls(auth: SiteAuthorization): WireFleetEvent[] {
  const sqlite = getSqlite()!;
  const manualRows = sqlite
    .prepare(
      `SELECT request.* FROM fleet_events request
        WHERE request.fleet_id = ? AND request.operation = ?
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events terminal
             WHERE terminal.parent_event_id = request.id
               AND terminal.operation IN (?, ?)
          )
        ORDER BY request.created_at, request.id`,
    )
    .all(
      auth.fleetId,
      MANUAL_DATA_SYNC_REQUESTED,
      MANUAL_DATA_SYNC_COMPLETED,
      MANUAL_DATA_SYNC_FAILED,
    ) as Array<Record<string, unknown>>;
  const mutationRows = sqlite
    .prepare(
      `SELECT request.* FROM fleet_events request
        WHERE request.fleet_id = ? AND request.operation = ?
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events acknowledgement
             WHERE acknowledgement.parent_event_id = request.id
               AND acknowledgement.operation = ?
               AND acknowledgement.origin_site_id = ?
               AND json_extract(acknowledgement.payload, '$.requestedSiteId') = ?
               AND json_extract(acknowledgement.payload, '$.mutationFingerprint') =
                   json_extract(request.payload, '$.mutationFingerprint')
          )
        ORDER BY request.created_at, request.id`,
    )
    .all(
      auth.fleetId,
      FLEET_MUTATION_REQUESTED,
      FLEET_MUTATION_ACKNOWLEDGED,
      auth.siteId,
      auth.siteId,
    ) as Array<Record<string, unknown>>;
  return [...manualRows, ...mutationRows]
    .map(wireEventFromRow)
    .filter(
      (event) =>
        event.originSiteId !== auth.siteId &&
        (manualDataSyncControlTarget(event) === auth.siteId ||
          fleetMutationControlTargets(event).includes(auth.siteId)),
    )
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(0, EVENT_LIMIT);
}

export function exchangeSuitcaseEvents(auth: SiteAuthorization, inputValue: SuitcaseExchangeInput) {
  const input = requireRecord(inputValue, 'exchange') as unknown as SuitcaseExchangeInput;
  if (input.protocolVersion !== MULTISITE_PROTOCOL_VERSION) {
    throw new SuitcaseProtocolError(
      `Suitcase protocol ${MULTISITE_PROTOCOL_VERSION} is required`,
      426,
      'protocol_version_mismatch',
    );
  }
  if (input.fleetId && input.fleetId !== auth.fleetId) {
    throw new SuitcaseProtocolError(
      'Exchange fleet does not match credential',
      403,
      'fleet_mismatch',
    );
  }
  const cursors = requireCursorMap(input.cursors);
  const telemetryCursors = requireCursorMap(input.telemetryCursors);
  const events = input.events ?? [];
  if (!Array.isArray(events) || events.length > EVENT_LIMIT) {
    throw new SuitcaseProtocolError(`At most ${EVENT_LIMIT} events may be exchanged at once`);
  }
  const manualSync = input.manualSync === true;
  const manualSyncAppIds = input.manualSyncAppIds
    ? new Set(
        input.manualSyncAppIds.map((appId) => {
          if (typeof appId !== 'string' || !ID_PATTERN.test(appId)) {
            throw new SuitcaseProtocolError('manualSyncAppIds contains an invalid application ID');
          }
          return appId;
        }),
      )
    : undefined;
  if (manualSyncAppIds && manualSyncAppIds.size > 100) {
    throw new SuitcaseProtocolError('At most 100 manual sync applications may be exchanged');
  }
  const telemetry = input.telemetry ?? [];
  if (!Array.isArray(telemetry) || telemetry.length > EVENT_LIMIT) {
    throw new SuitcaseProtocolError(
      `At most ${EVENT_LIMIT} telemetry records may be exchanged at once`,
    );
  }
  const missingArtifacts: string[] = [];
  const readyEvents: WireFleetEvent[] = [];
  let artifactBlocked = false;
  for (const raw of events) {
    const event = validateWireEvent(raw, auth);
    requireDataPolicy(event, auth.siteId, manualSync, manualSyncAppIds);
    const missingForEvent = event.artifactDigests.filter((digest) => !getArtifact(digest));
    if (missingForEvent.length) artifactBlocked = true;
    missingArtifacts.push(...missingForEvent);
    // Origin sequences are contiguous. Never acknowledge a later event while
    // an earlier event is waiting for its verified content artifacts.
    if (!artifactBlocked) readyEvents.push(event);
  }
  const readyTelemetry: WireFleetTelemetryRecord[] = [];
  let telemetryArtifactBlocked = false;
  for (const raw of telemetry) {
    let record: WireFleetTelemetryRecord;
    try {
      record = validateFleetTelemetryRecord(raw, {
        fleetId: auth.fleetId,
        originSiteId: auth.siteId,
      });
    } catch (cause) {
      throw new SuitcaseProtocolError(
        cause instanceof Error ? cause.message : 'Fleet telemetry record is invalid',
      );
    }
    const requiredArtifacts = telemetryArtifactAllowed(
      record,
      auth.siteId,
      manualSync,
      manualSyncAppIds,
    )
      ? record.artifactDigests
      : [];
    const missingForRecord = requiredArtifacts.filter((digest) => !getArtifact(digest));
    if (missingForRecord.length) telemetryArtifactBlocked = true;
    missingArtifacts.push(...missingForRecord);
    if (!telemetryArtifactBlocked) readyTelemetry.push(record);
  }
  const accepted = ingestEvents(auth, readyEvents, manualSync, manualSyncAppIds);
  let telemetryAccepted: { acceptedThrough: number; replayed: number };
  try {
    telemetryAccepted = ingestFleetTelemetryRecords(readyTelemetry, {
      fleetId: auth.fleetId,
      originSiteId: auth.siteId,
    });
  } catch (cause) {
    throw new SuitcaseProtocolError(
      cause instanceof Error ? cause.message : 'Fleet telemetry could not be accepted',
      409,
      'telemetry_sequence_conflict',
    );
  }
  if (input.mode || input.capabilities || input.readiness || input.networkFingerprint) {
    updateSitePresence({
      siteId: auth.siteId,
      mode: input.mode ?? 'docked',
      capabilities: input.capabilities,
      readiness: input.readiness,
      networkFingerprint: input.networkFingerprint,
    });
  }
  for (const [origin, sequence] of Object.entries(cursors)) {
    updateCursor(auth.homeSiteId, auth.siteId, `delivered:${origin}`, sequence, true);
  }
  const outgoing = outgoingEvents(auth, cursors, manualSync, manualSyncAppIds);
  const controlRequests = outgoingAdministrativeControls(auth);
  const telemetryOutgoing = outgoingTelemetry(auth, telemetryCursors, manualSync, manualSyncAppIds);
  const sitePublicKeys = Object.fromEntries(
    (
      getSqlite()!
        .prepare('SELECT id, public_key FROM sites WHERE fleet_id = ? AND revoked_at IS NULL')
        .all(auth.fleetId) as Array<{ id: string; public_key: string }>
    ).map((site) => [site.id, site.public_key]),
  );
  return {
    protocolVersion: MULTISITE_PROTOCOL_VERSION,
    fleetId: auth.fleetId,
    homeSiteId: auth.homeSiteId,
    siteId: auth.siteId,
    acceptedThrough: accepted.acceptedThrough,
    replayed: accepted.replayed,
    acceptedTelemetryThrough: telemetryAccepted.acceptedThrough,
    telemetryReplayed: telemetryAccepted.replayed,
    events: outgoing.events,
    controlRequests,
    telemetry: telemetryOutgoing.telemetry,
    skippedSequences: outgoing.skippedSequences,
    deferredOrigins: outgoing.deferredOrigins,
    hasMore: outgoing.hasMore || telemetryOutgoing.hasMore,
    missingArtifacts: [...new Set(missingArtifacts)],
    sitePublicKeys,
    serverTime: new Date().toISOString(),
  };
}

export function suitcaseSyncStatus(siteId: string) {
  const site = siteRow(siteId);
  if (!site || site.kind !== 'suitcase') throw new SuitcaseProtocolError('Suitcase not found', 404);
  const sqlite = getSqlite()!;
  const cursors = sqlite
    .prepare('SELECT * FROM site_sync_cursors WHERE remote_site_id = ? ORDER BY stream')
    .all(siteId) as Array<Record<string, unknown>>;
  const replicas = sqlite
    .prepare(
      `SELECT r.*, d.name,
              COALESCE(site_policy.policy, app_policy.policy, r.sync_policy, 'none') AS effective_policy
         FROM app_replicas r
         LEFT JOIN deployments d ON d.app_id = r.app_id
         LEFT JOIN data_sync_policies site_policy
           ON site_policy.app_id = r.app_id AND site_policy.site_id = r.site_id
         LEFT JOIN data_sync_policies app_policy
           ON app_policy.app_id = r.app_id AND app_policy.site_id = ''
        WHERE r.site_id = ? AND r.removed_at IS NULL
        ORDER BY d.name`,
    )
    .all(siteId) as Array<Record<string, unknown>>;
  const candidates = sqlite
    .prepare(
      `SELECT id, app_id, actor, operation, payload, created_at
         FROM fleet_events
        WHERE origin_site_id = ? AND operation LIKE '%.candidate' AND applied_at IS NULL
        ORDER BY created_at`,
    )
    .all(siteId) as Array<Record<string, unknown>>;
  return {
    protocolVersion: MULTISITE_PROTOCOL_VERSION,
    site: {
      id: site.id,
      fleetId: site.fleet_id,
      mode: site.revoked_at ? 'revoked' : site.mode,
      credentialStatus: site.credential_status,
      revokedAt: site.revoked_at,
    },
    cursors: cursors.map((cursor) => ({
      stream: String(cursor.stream),
      sequence: Number(cursor.last_accepted_sequence),
      lastAttemptAt: cursor.last_attempt_at,
      lastSuccessAt: cursor.last_success_at,
    })),
    replicas: replicas.map((replica) => ({
      appId: replica.app_id,
      name: replica.name,
      policy: replica.effective_policy,
      pendingChangesets: Number(replica.pending_changesets),
      pendingBlobs: Number(replica.pending_blobs),
      conflicts: Number(replica.conflict_count),
      baseCheckpointId: replica.base_checkpoint_id,
      branchCheckpointId: replica.branch_checkpoint_id,
    })),
    commandCandidates: candidates.map((candidate) => ({
      id: candidate.id,
      appId: candidate.app_id,
      actor: candidate.actor,
      operation: candidate.operation,
      payload: parseJsonObject(candidate.payload, 'candidate payload'),
      createdAt: candidate.created_at,
    })),
  };
}

export function suitcaseAccessDiagnostics(siteId: string) {
  const site = siteRow(siteId);
  if (!site || site.kind !== 'suitcase') throw new SuitcaseProtocolError('Suitcase not found', 404);
  const capabilities = parseJsonObject(site.capabilities, 'site capabilities');
  const readiness = parseJsonObject(site.readiness_summary, 'site readiness');
  const instructions: string[] = [];
  if (site.access_mode === 'host-hotspot') {
    instructions.push(
      'Use the host operating system hotspot; containers cannot configure physical Wi-Fi.',
    );
  } else if (site.access_mode === 'linux-access-point') {
    instructions.push(
      'Verify the Linux access-point service and DHCP/DNS services before departure.',
    );
  } else {
    instructions.push('Connect the suitcase and clients to the same existing LAN.');
  }
  if (site.platform === 'darwin')
    instructions.push('Enable macOS Internet Sharing and Docker Desktop at login.');
  else if (site.platform === 'win32')
    instructions.push('Enable Windows Mobile hotspot and Docker Desktop at sign-in.');
  else if (site.platform === 'linux')
    instructions.push('Enable the host hotspot and Docker services at boot.');
  const blockers = Object.entries(readiness)
    .filter(([, ready]) => ready === false)
    .map(([capability]) => `${capability} readiness is false`);
  return {
    siteId,
    mode: site.access_mode,
    platform: site.platform,
    capabilities,
    readiness,
    ready: !site.revoked_at && blockers.length === 0,
    blockers: site.revoked_at ? ['site is revoked', ...blockers] : blockers,
    instructions,
  };
}

export function fleetTopologyWithSync() {
  const topology = listTopology();
  return {
    ...topology,
    sites: topology.sites.map((site) => ({
      ...site,
      sync: site.kind === 'suitcase' ? suitcaseSyncStatus(site.id) : null,
      access: site.kind === 'suitcase' ? suitcaseAccessDiagnostics(site.id) : null,
    })),
  };
}

export function beginSuitcaseArtifactUpload(
  auth: SiteAuthorization,
  input: { digest: string; expectedSize: number },
) {
  if (!DIGEST_PATTERN.test(input.digest))
    throw new SuitcaseProtocolError('Invalid artifact digest');
  const transfer = beginArtifactTransfer({
    sourceSiteId: auth.siteId,
    destinationSiteId: auth.homeSiteId,
    digest: input.digest,
    expectedSize: input.expectedSize,
  });
  return {
    id: String(transfer.id),
    digest: String(transfer.digest),
    expectedSize: Number(transfer.expected_size),
    verifiedOffset: Number(transfer.verified_offset),
    status: String(transfer.status),
  };
}

export async function appendSuitcaseArtifactChunk(
  auth: SiteAuthorization,
  input: {
    transferId: string;
    digest: string;
    offset: number;
    bytes: Buffer;
    metadata: ArtifactMetadata;
  },
) {
  if (input.bytes.length > MAX_ARTIFACT_CHUNK_BYTES) {
    throw new SuitcaseProtocolError('Artifact chunk exceeds 4 MiB', 413, 'chunk_too_large');
  }
  const transfer = getSqlite()!
    .prepare('SELECT * FROM artifact_transfers WHERE id = ?')
    .get(input.transferId) as Record<string, unknown> | undefined;
  if (
    !transfer ||
    transfer.source_site_id !== auth.siteId ||
    transfer.destination_site_id !== auth.homeSiteId ||
    transfer.digest !== input.digest
  ) {
    throw new SuitcaseProtocolError('Artifact transfer does not belong to this suitcase', 403);
  }
  const updated = (await appendArtifactTransferChunk(
    input.transferId,
    input.offset,
    input.bytes,
    input.metadata,
  )) as Record<string, unknown>;
  return {
    id: String(updated.id),
    digest: String(updated.digest),
    verifiedOffset: Number(updated.verified_offset),
    expectedSize: Number(updated.expected_size),
    status: String(updated.status),
  };
}

export function readSuitcaseArtifactChunk(
  _auth: SiteAuthorization,
  digest: string,
  offset: number,
  requestedBytes = MAX_ARTIFACT_CHUNK_BYTES,
) {
  if (!DIGEST_PATTERN.test(digest)) throw new SuitcaseProtocolError('Invalid artifact digest');
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new SuitcaseProtocolError('Invalid offset');
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1) {
    throw new SuitcaseProtocolError('Invalid artifact chunk size');
  }
  const artifact = getArtifact(digest);
  if (!artifact) throw new SuitcaseProtocolError('Artifact not found', 404);
  const artifactRecord = artifact as Record<string, unknown> & { localPath: string };
  const size = statSync(artifactRecord.localPath).size;
  if (offset > size)
    throw new SuitcaseProtocolError(`Expected artifact offset at most ${size}`, 416);
  const length = Math.min(requestedBytes, MAX_ARTIFACT_CHUNK_BYTES, size - offset);
  const bytes = Buffer.alloc(length);
  if (length > 0) {
    const descriptor = openSync(artifactRecord.localPath, 'r');
    try {
      readSync(descriptor, bytes, 0, length, offset);
    } finally {
      closeSync(descriptor);
    }
  }
  return {
    digest,
    bytes,
    offset,
    nextOffset: offset + length,
    totalSize: size,
    complete: offset + length === size,
    type: String(artifactRecord.type),
    mediaType: String(artifactRecord.media_type),
  };
}

export { MAX_ARTIFACT_CHUNK_BYTES };
