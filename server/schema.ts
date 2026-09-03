import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  username: text('username').primaryKey(),
  password: text('password').notNull(),
  role: text('role').notNull().default('member'),
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    username: text('username').notNull(),
    token: text('token').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
    // Epoch ms. Null on rows created before session TTLs existed; those are
    // accepted by authenticate() and aged out by createdAt in maintenance.
    expiresAt: integer('expires_at'),
  },
  (table) => ({
    usernameIdx: index('idx_sessions_username').on(table.username),
    tokenIdx: index('idx_sessions_token').on(table.token),
  }),
);

export const deployments = sqliteTable(
  'deployments',
  {
    name: text('name').primaryKey(),
    type: text('type'),
    username: text('username').notNull(),
    port: integer('port'),
    containerId: text('container_id'),
    containerName: text('container_name'),
    directory: text('directory'),
    status: text('status').default('stopped'),
    currentBuildLogId: integer('current_build_log_id'),
    extraPorts: text('extra_ports'),
    envVars: text('env_vars'),
    memoryLimit: text('memory_limit'),
    cpuLimit: text('cpu_limit'),
    volumes: text('volumes'),
    gpuEnabled: integer('gpu_enabled', { mode: 'boolean' }).default(false),
    privilegedDocker: integer('privileged_docker', { mode: 'boolean' }).default(false),
    autoBackup: integer('auto_backup', { mode: 'boolean' }).default(false),
    discoverable: integer('discoverable', { mode: 'boolean' }).default(false),
    desiredNodeId: text('desired_node_id'),
    activeNodeId: text('active_node_id'),
    containerStartedAt: integer('container_started_at'),
    /**
     * v1 application-graph migration pointers. These remain nullable while a
     * legacy deployment has not yet been compiled into an ApplicationSpec.
     * The immutable revision itself lives in application_spec_revisions.
     */
    desiredSpecDigest: text('desired_spec_digest'),
    activeSpecDigest: text('active_spec_digest'),
    configurationDigest: text('configuration_digest'),
    specSource: text('spec_source'),
    /** Stable distributed identity; name remains the human-facing URL alias. */
    appId: text('app_id'),
    dataMode: text('data_mode').default('single-site'),
    reconciliationProfileVersion: text('reconciliation_profile_version'),
    releaseAuthorityEpoch: integer('release_authority_epoch').default(1),
    releaseGeneration: integer('release_generation').default(0),
    desiredReleaseDigest: text('desired_release_digest'),
    sourceArtifactDigest: text('source_artifact_digest'),
    imageArtifactDigest: text('image_artifact_digest'),
    snapshotArtifactDigest: text('snapshot_artifact_digest'),
    createdAt: text('created_at'),
    updatedAt: text('updated_at'),
  },
  (table) => ({
    usernameIdx: index('idx_deployments_username').on(table.username),
    appIdIdx: index('idx_deployments_app_id').on(table.appId),
  }),
);

export const fleets = sqliteTable('fleets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  protocolVersion: integer('protocol_version').notNull().default(1),
  rootPublicIdentity: text('root_public_identity').notNull(),
  homeSiteId: text('home_site_id').notNull(),
  createdAt: text('created_at').notNull(),
});

export const sites = sqliteTable(
  'sites',
  {
    id: text('id').primaryKey(),
    fleetId: text('fleet_id').notNull(),
    nodeId: text('node_id'),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    publicKey: text('public_key').notNull(),
    credentialHash: text('credential_hash'),
    credentialStatus: text('credential_status').notNull().default('active'),
    platform: text('platform'),
    architecture: text('architecture'),
    version: text('version'),
    capabilities: text('capabilities').notNull().default('{}'),
    mode: text('mode').notNull().default('docked'),
    defaultDataPolicy: text('default_data_policy').notNull().default('none'),
    accessMode: text('access_mode').notNull().default('existing-lan'),
    securityProfile: text('security_profile').notNull().default('isolated'),
    networkFingerprint: text('network_fingerprint'),
    readinessSummary: text('readiness_summary').notNull().default('{}'),
    lastContactAt: integer('last_contact_at'),
    revokedAt: text('revoked_at'),
    removedAt: text('removed_at'),
    quarantineReason: text('quarantine_reason'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    fleetIdx: index('idx_sites_fleet').on(table.fleetId, table.kind),
    nodeIdx: index('idx_sites_node').on(table.nodeId),
  }),
);

export const sitePairingCodes = sqliteTable(
  'site_pairing_codes',
  {
    id: text('id').primaryKey(),
    fleetId: text('fleet_id').notNull(),
    name: text('name').notNull(),
    codeHash: text('code_hash').notNull(),
    defaultDataPolicy: text('default_data_policy').notNull(),
    accessMode: text('access_mode').notNull(),
    securityProfile: text('security_profile').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => ({
    codeIdx: index('idx_site_pairing_codes_hash').on(table.codeHash),
    expiryIdx: index('idx_site_pairing_codes_expiry').on(table.expiresAt),
  }),
);

export const siteUsers = sqliteTable(
  'site_users',
  {
    siteId: text('site_id').notNull(),
    username: text('username').notNull(),
    role: text('role').notNull(),
    passwordVerifier: text('password_verifier').notNull(),
    revision: integer('revision').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.siteId, table.username] }),
  }),
);

export const applicationAliases = sqliteTable(
  'application_aliases',
  {
    fleetId: text('fleet_id').notNull(),
    alias: text('alias').notNull(),
    appId: text('app_id').notNull(),
    originSiteId: text('origin_site_id').notNull(),
    state: text('state').notNull().default('active'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.fleetId, table.alias, table.appId] }),
    aliasIdx: index('idx_application_aliases_alias').on(table.fleetId, table.alias, table.state),
  }),
);

export const dataSyncPolicies = sqliteTable(
  'data_sync_policies',
  {
    appId: text('app_id').notNull(),
    siteId: text('site_id').notNull().default(''),
    policy: text('policy').notNull(),
    conflictPolicy: text('conflict_policy').notNull().default('collect'),
    acknowledgedRisks: text('acknowledged_risks').notNull().default('[]'),
    revision: integer('revision').notNull().default(1),
    updatedBy: text('updated_by').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.siteId] }),
  }),
);

export const readinessCertificates = sqliteTable(
  'readiness_certificates',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    siteId: text('site_id').notNull(),
    specDigest: text('spec_digest').notNull(),
    checkpointId: text('checkpoint_id'),
    capabilityDigest: text('capability_digest').notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    runtimeReady: integer('runtime_ready', { mode: 'boolean' }).notNull(),
    buildReady: integer('build_ready', { mode: 'boolean' }).notNull(),
    dataReady: integer('data_ready', { mode: 'boolean' }).notNull(),
    accessReady: integer('access_ready', { mode: 'boolean' }).notNull(),
    blockers: text('blockers').notNull().default('[]'),
    evidence: text('evidence').notNull().default('[]'),
    issuedAt: text('issued_at').notNull(),
    expiresAt: text('expires_at'),
    invalidatedAt: text('invalidated_at'),
    invalidationReason: text('invalidation_reason'),
  },
  (table) => ({
    appSiteIdx: index('idx_readiness_certificates_app_site').on(table.appId, table.siteId),
  }),
);

export const appReplicas = sqliteTable(
  'app_replicas',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    siteId: text('site_id').notNull(),
    activeReleaseDigest: text('active_release_digest'),
    desiredReleaseDigest: text('desired_release_digest'),
    runtimeStatus: text('runtime_status').notNull().default('pending'),
    dataMode: text('data_mode').notNull().default('single-site'),
    syncPolicy: text('sync_policy').notNull().default('none'),
    sharedLineage: integer('shared_lineage', { mode: 'boolean' }).notNull().default(false),
    schemaFingerprint: text('schema_fingerprint'),
    profileVersion: text('profile_version'),
    baseCheckpointId: text('base_checkpoint_id'),
    branchCheckpointId: text('branch_checkpoint_id'),
    pendingChangesets: integer('pending_changesets').notNull().default(0),
    pendingBlobs: integer('pending_blobs').notNull().default(0),
    conflictCount: integer('conflict_count').notNull().default(0),
    readiness: text('readiness').notNull().default('{}'),
    lastPolicyEventId: text('last_policy_event_id'),
    lastContactAt: integer('last_contact_at'),
    removedAt: text('removed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    appSiteIdx: uniqueIndex('idx_app_replicas_app_site').on(table.appId, table.siteId),
  }),
);

export const dataReconciliationProfiles = sqliteTable('data_reconciliation_profiles', {
  id: text('id').primaryKey(),
  appId: text('app_id').notNull(),
  version: text('version').notNull(),
  analyzerVersion: text('analyzer_version').notNull(),
  schemaFingerprint: text('schema_fingerprint'),
  sqliteFiles: text('sqlite_files').notNull().default('[]'),
  eligibleTables: text('eligible_tables').notNull().default('[]'),
  excludedTables: text('excluded_tables').notNull().default('[]'),
  uploadPaths: text('upload_paths').notNull().default('[]'),
  opaquePaths: text('opaque_paths').notNull().default('[]'),
  conflictPolicy: text('conflict_policy').notNull().default('collect'),
  compatibilityDigest: text('compatibility_digest').notNull(),
  findings: text('findings').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});

export const dataCheckpoints = sqliteTable(
  'data_checkpoints',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    parentId: text('parent_id'),
    originSiteId: text('origin_site_id').notNull(),
    sequence: integer('sequence').notNull(),
    databaseArtifactDigest: text('database_artifact_digest'),
    filesystemArtifactDigest: text('filesystem_artifact_digest'),
    manifestArtifactDigest: text('manifest_artifact_digest').notNull(),
    schemaFingerprint: text('schema_fingerprint'),
    profileVersion: text('profile_version'),
    verificationStatus: text('verification_status').notNull(),
    acknowledgements: text('acknowledgements').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    appSequenceIdx: index('idx_data_checkpoints_app_sequence').on(table.appId, table.sequence),
  }),
);

export const dataChangesets = sqliteTable(
  'data_changesets',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    originSiteId: text('origin_site_id').notNull(),
    baseCheckpointId: text('base_checkpoint_id').notNull(),
    branchManifestDigest: text('branch_manifest_digest').notNull(),
    schemaFingerprint: text('schema_fingerprint'),
    databaseArtifactDigest: text('database_artifact_digest'),
    fileDeltaArtifactDigest: text('file_delta_artifact_digest'),
    authenticatedDigest: text('authenticated_digest').notNull(),
    status: text('status').notNull().default('pending'),
    conflictReport: text('conflict_report'),
    resultingCheckpointId: text('resulting_checkpoint_id'),
    createdAt: text('created_at').notNull(),
    verifiedAt: text('verified_at'),
  },
  (table) => ({
    appStatusIdx: index('idx_data_changesets_app_status').on(table.appId, table.status),
  }),
);

export const dataConflicts = sqliteTable(
  'data_conflicts',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    changesetId: text('changeset_id'),
    kind: text('kind').notNull(),
    logicalAddress: text('logical_address').notNull(),
    baseValue: text('base_value'),
    homeValue: text('home_value'),
    suitcaseValue: text('suitcase_value'),
    resolution: text('resolution'),
    status: text('status').notNull().default('open'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
    resolvedBy: text('resolved_by'),
  },
  (table) => ({
    appStatusIdx: index('idx_data_conflicts_app_status').on(table.appId, table.status),
  }),
);

export const blobReferences = sqliteTable(
  'blob_references',
  {
    appId: text('app_id').notNull(),
    logicalPath: text('logical_path').notNull(),
    checkpointId: text('checkpoint_id').notNull(),
    digest: text('digest'),
    metadata: text('metadata').notNull().default('{}'),
    marker: text('marker').notNull().default('present'),
    conflictState: text('conflict_state'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.logicalPath, table.checkpointId] }),
  }),
);

export const fleetEvents = sqliteTable(
  'fleet_events',
  {
    id: text('id').primaryKey(),
    fleetId: text('fleet_id').notNull(),
    originSiteId: text('origin_site_id').notNull(),
    originSequence: integer('origin_sequence').notNull(),
    appId: text('app_id'),
    authorityEpoch: integer('authority_epoch'),
    generation: integer('generation'),
    actor: text('actor').notNull(),
    operation: text('operation').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    payload: text('payload').notNull(),
    artifactDigests: text('artifact_digests').notNull().default('[]'),
    parentEventId: text('parent_event_id'),
    authenticatedDigest: text('authenticated_digest').notNull(),
    createdAt: text('created_at').notNull(),
    appliedAt: text('applied_at'),
    rejectionReason: text('rejection_reason'),
  },
  (table) => ({
    originIdx: index('idx_fleet_events_origin').on(table.originSiteId, table.originSequence),
    appGenerationIdx: index('idx_fleet_events_app_generation').on(
      table.appId,
      table.authorityEpoch,
      table.generation,
    ),
  }),
);

export const siteSyncCursors = sqliteTable(
  'site_sync_cursors',
  {
    localSiteId: text('local_site_id').notNull(),
    remoteSiteId: text('remote_site_id').notNull(),
    stream: text('stream').notNull(),
    lastAcceptedSequence: integer('last_accepted_sequence').notNull().default(0),
    protocolVersion: integer('protocol_version').notNull().default(1),
    lastAttemptAt: text('last_attempt_at'),
    lastSuccessAt: text('last_success_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.localSiteId, table.remoteSiteId, table.stream] }),
  }),
);

/**
 * Low-volume, site-authored operational records exchanged independently from
 * the signed semantic command log. Multiple immutable revisions may share a
 * logical key; readers select the greatest origin sequence so a still-running
 * build or request bucket can be refreshed without mutating acknowledged data.
 */
export const fleetTelemetryRecords = sqliteTable(
  'fleet_telemetry_records',
  {
    id: text('id').primaryKey(),
    fleetId: text('fleet_id').notNull(),
    originSiteId: text('origin_site_id').notNull(),
    originSequence: integer('origin_sequence').notNull(),
    kind: text('kind').notNull(),
    appId: text('app_id'),
    deploymentName: text('deployment_name').notNull(),
    logicalKey: text('logical_key').notNull(),
    observedAt: text('observed_at').notNull(),
    payload: text('payload').notNull(),
    artifactDigests: text('artifact_digests').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    originSequenceIdx: uniqueIndex('idx_fleet_telemetry_origin_sequence').on(
      table.originSiteId,
      table.originSequence,
    ),
    logicalIdx: index('idx_fleet_telemetry_logical').on(
      table.originSiteId,
      table.kind,
      table.logicalKey,
      table.originSequence,
    ),
    appIdx: index('idx_fleet_telemetry_app').on(table.deploymentName, table.kind, table.observedAt),
  }),
);

export const artifacts = sqliteTable('artifacts', {
  digest: text('digest').primaryKey(),
  type: text('type').notNull(),
  byteSize: integer('byte_size').notNull(),
  mediaType: text('media_type').notNull(),
  architecture: text('architecture'),
  localPath: text('local_path').notNull(),
  verificationStatus: text('verification_status').notNull(),
  createdByEventId: text('created_by_event_id'),
  retentionClass: text('retention_class').notNull().default('temporary'),
  pinCount: integer('pin_count').notNull().default(0),
  createdAt: text('created_at').notNull(),
  lastAccessAt: text('last_access_at').notNull(),
});

export const artifactTransfers = sqliteTable('artifact_transfers', {
  id: text('id').primaryKey(),
  sourceSiteId: text('source_site_id').notNull(),
  destinationSiteId: text('destination_site_id').notNull(),
  digest: text('digest').notNull(),
  expectedSize: integer('expected_size').notNull(),
  verifiedOffset: integer('verified_offset').notNull().default(0),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  temporaryPath: text('temporary_path'),
  error: text('error'),
  updatedAt: text('updated_at').notNull(),
});

export const appMaterialization = sqliteTable(
  'app_materialization',
  {
    appId: text('app_id').notNull(),
    siteId: text('site_id').notNull(),
    capability: text('capability').notNull(),
    desiredDigest: text('desired_digest'),
    availableDigest: text('available_digest'),
    desiredGeneration: integer('desired_generation'),
    availableGeneration: integer('available_generation'),
    state: text('state').notNull(),
    blockers: text('blockers').notNull().default('[]'),
    evidence: text('evidence').notNull().default('[]'),
    verifiedAt: text('verified_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.siteId, table.capability] }),
  }),
);

export const releaseCandidates = sqliteTable(
  'release_candidates',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    originSiteId: text('origin_site_id').notNull(),
    actor: text('actor').notNull(),
    baseAuthorityEpoch: integer('base_authority_epoch').notNull(),
    baseGeneration: integer('base_generation').notNull(),
    specDigest: text('spec_digest'),
    parentSpecDigest: text('parent_spec_digest'),
    requestedAlias: text('requested_alias'),
    sourceArtifactDigest: text('source_artifact_digest'),
    imageArtifactDigest: text('image_artifact_digest'),
    snapshotArtifactDigest: text('snapshot_artifact_digest'),
    artifactDigests: text('artifact_digests').notNull().default('[]'),
    configurationDigest: text('configuration_digest'),
    architecture: text('architecture'),
    state: text('state').notNull(),
    supersededBy: text('superseded_by'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    appStateIdx: index('idx_release_candidates_app_state').on(table.appId, table.state),
  }),
);

export const volumeSnapshots = sqliteTable(
  'volume_snapshots',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    authoritySiteId: text('authority_site_id').notNull(),
    authorityEpoch: integer('authority_epoch').notNull(),
    dataSequence: integer('data_sequence').notNull(),
    parentSnapshotId: text('parent_snapshot_id'),
    manifestArtifactDigest: text('manifest_artifact_digest').notNull(),
    consistencyMode: text('consistency_mode').notNull(),
    logicalBytes: integer('logical_bytes').notNull(),
    uniqueBytes: integer('unique_bytes').notNull(),
    verificationStatus: text('verification_status').notNull(),
    releaseGeneration: integer('release_generation'),
    retentionClass: text('retention_class').notNull(),
    latestHomeRecovery: integer('latest_home_recovery', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    appSequenceIdx: index('idx_volume_snapshots_app_sequence').on(table.appId, table.dataSequence),
  }),
);

export const volumeAuthorityTransfers = sqliteTable(
  'volume_authority_transfers',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    sourceSiteId: text('source_site_id').notNull(),
    targetSiteId: text('target_site_id').notNull(),
    state: text('state').notNull(),
    expectedSnapshotId: text('expected_snapshot_id'),
    expectedAuthorityEpoch: integer('expected_authority_epoch').notNull(),
    expectedDataSequence: integer('expected_data_sequence').notNull(),
    snapshotId: text('snapshot_id'),
    snapshotAuthorityEpoch: integer('snapshot_authority_epoch'),
    snapshotDataSequence: integer('snapshot_data_sequence'),
    manifestArtifactDigest: text('manifest_artifact_digest'),
    requestedBy: text('requested_by').notNull(),
    requestEventId: text('request_event_id'),
    snapshotEventId: text('snapshot_event_id'),
    targetReadyEventId: text('target_ready_event_id'),
    commitEventId: text('commit_event_id'),
    terminalEventId: text('terminal_event_id'),
    sourceResumed: integer('source_resumed', { mode: 'boolean' }).notNull().default(false),
    attempts: integer('attempts').notNull().default(0),
    version: integer('version').notNull().default(1),
    error: text('error'),
    requestedAt: text('requested_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => ({
    appStateIdx: index('idx_volume_authority_transfers_app_state').on(table.appId, table.state),
    siteStateIdx: index('idx_volume_authority_transfers_site_state').on(
      table.sourceSiteId,
      table.targetSiteId,
      table.state,
    ),
  }),
);

export const portabilityReports = sqliteTable(
  'portability_reports',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    specDigest: text('spec_digest').notNull(),
    siteId: text('site_id').notNull(),
    analyzerVersion: text('analyzer_version').notNull(),
    classification: text('classification').notNull(),
    capabilityVector: text('capability_vector').notNull(),
    findings: text('findings').notNull(),
    evidence: text('evidence').notNull(),
    profileDigest: text('profile_digest'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at'),
  },
  (table) => ({
    appSiteIdx: index('idx_portability_reports_app_site').on(table.appId, table.siteId),
  }),
);

export const suitcaseCapacityPlans = sqliteTable('suitcase_capacity_plans', {
  id: text('id').primaryKey(),
  fleetId: text('fleet_id').notNull(),
  selectedAppIds: text('selected_app_ids').notNull(),
  assumptions: text('assumptions').notNull(),
  minimumMemoryBytes: integer('minimum_memory_bytes').notNull(),
  recommendedMemoryBytes: integer('recommended_memory_bytes').notNull(),
  minimumStorageBytes: integer('minimum_storage_bytes').notNull(),
  recommendedStorageBytes: integer('recommended_storage_bytes').notNull(),
  contributors: text('contributors').notNull(),
  confidence: text('confidence').notNull(),
  unknowns: text('unknowns').notNull(),
  measuredResult: text('measured_result'),
  createdAt: text('created_at').notNull(),
});

export const fleetRecoveryBundles = sqliteTable('fleet_recovery_bundles', {
  id: text('id').primaryKey(),
  fleetId: text('fleet_id').notNull(),
  formatVersion: integer('format_version').notNull(),
  artifactDigest: text('artifact_digest').notNull(),
  encryptionMetadata: text('encryption_metadata').notNull(),
  inventoryDigest: text('inventory_digest').notNull(),
  verificationStatus: text('verification_status').notNull(),
  rehearsalStatus: text('rehearsal_status'),
  createdAt: text('created_at').notNull(),
  verifiedAt: text('verified_at'),
  rehearsedAt: text('rehearsed_at'),
});

/**
 * Immutable, portable application definitions.
 *
 * Relational component/resource projections will make graph queries fast,
 * but this content-addressed document remains the durable definition that can
 * be exported, copied to a suitcase, and rebuilt into those projections.
 */
export const applicationSpecRevisions = sqliteTable(
  'application_spec_revisions',
  {
    digest: text('digest').notNull(),
    deploymentName: text('deployment_name').notNull(),
    parentDigest: text('parent_digest'),
    apiVersion: text('api_version').notNull(),
    source: text('source').notNull(),
    manifestFormat: text('manifest_format').notNull(),
    normalizedSpec: text('normalized_spec').notNull(),
    originalArtifactDigest: text('original_artifact_digest'),
    normalizedArtifactDigest: text('normalized_artifact_digest'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.deploymentName, table.digest] }),
    deploymentIdx: index('idx_application_spec_revisions_deployment').on(
      table.deploymentName,
      table.createdAt,
    ),
    parentIdx: index('idx_application_spec_revisions_parent').on(table.parentDigest),
  }),
);

/** Ordered desired-revision transitions. Content digests may be revisited by a later revert. */
export const applicationSpecTransitions = sqliteTable(
  'application_spec_transitions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    fromDigest: text('from_digest'),
    toDigest: text('to_digest').notNull(),
    source: text('source').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_application_spec_transitions_deployment').on(
      table.deploymentName,
      table.id,
    ),
  }),
);

/**
 * Resolved values for declarations in deploy.yaml. Secret values are stored as
 * authenticated ciphertext; ordinary configuration remains separate from the
 * immutable ApplicationSpec so value rotation does not rewrite the manifest.
 * An empty site_id is the application-wide value inherited by every site.
 */
export const applicationConfigurationValues = sqliteTable(
  'application_configuration_values',
  {
    deploymentName: text('deployment_name').notNull(),
    specDigest: text('spec_digest').notNull(),
    key: text('key').notNull(),
    siteId: text('site_id').notNull().default(''),
    valueType: text('value_type').notNull(),
    value: text('value').notNull(),
    valueDigest: text('value_digest').notNull(),
    revision: integer('revision').notNull().default(1),
    updatedBy: text('updated_by').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.deploymentName, table.specDigest, table.key, table.siteId],
    }),
    deploymentIdx: index('idx_application_configuration_deployment').on(
      table.deploymentName,
      table.specDigest,
      table.siteId,
    ),
  }),
);

/** Catalog ownership and lifecycle state layered on the ordinary deployment/spec records. */
export const catalogInstallations = sqliteTable(
  'catalog_installations',
  {
    id: text('id').primaryKey(),
    applicationName: text('application_name').notNull(),
    blueprintId: text('blueprint_id').notNull(),
    release: text('release').notNull(),
    blueprintDigest: text('blueprint_digest').notNull(),
    installedSpecDigest: text('installed_spec_digest').notNull(),
    currentSpecDigest: text('current_spec_digest').notNull(),
    siteId: text('site_id').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    revision: integer('revision').notNull().default(1),
    driftedAddresses: text('drifted_addresses').notNull().default('[]'),
    localBlueprintId: text('local_blueprint_id'),
    lastOperationId: text('last_operation_id'),
    failure: text('failure'),
    dataRetained: integer('data_retained', { mode: 'boolean' }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    applicationIdx: uniqueIndex('idx_catalog_installations_application').on(table.applicationName),
    blueprintIdx: index('idx_catalog_installations_blueprint').on(table.blueprintId, table.release),
    stateIdx: index('idx_catalog_installations_state').on(table.status, table.updatedAt),
  }),
);

/** Durable operation intents allow interrupted catalog work to be retried without guessing. */
export const catalogOperations = sqliteTable(
  'catalog_operations',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    applicationName: text('application_name').notNull(),
    operation: text('operation').notNull(),
    status: text('status').notNull(),
    plan: text('plan').notNull(),
    attempt: integer('attempt').notNull().default(1),
    actor: text('actor').notNull(),
    retainData: integer('retain_data', { mode: 'boolean' }),
    recoveryPointId: text('recovery_point_id'),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    completedAt: text('completed_at'),
  },
  (table) => ({
    installationIdx: index('idx_catalog_operations_installation').on(
      table.installationId,
      table.createdAt,
    ),
    stateIdx: index('idx_catalog_operations_state').on(table.status, table.updatedAt),
  }),
);

/** Runtime-created recovery artifacts are ineligible for destructive work until verified. */
export const catalogRecoveryPoints = sqliteTable(
  'catalog_recovery_points',
  {
    id: text('id').primaryKey(),
    installationId: text('installation_id').notNull(),
    applicationName: text('application_name').notNull(),
    siteId: text('site_id').notNull(),
    release: text('release').notNull(),
    specDigest: text('spec_digest').notNull(),
    status: text('status').notNull(),
    artifactReference: text('artifact_reference'),
    artifactDigest: text('artifact_digest'),
    verification: text('verification'),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    verifiedAt: text('verified_at'),
  },
  (table) => ({
    installationIdx: index('idx_catalog_recovery_points_installation').on(
      table.installationId,
      table.createdAt,
    ),
    verificationIdx: index('idx_catalog_recovery_points_verification').on(
      table.installationId,
      table.status,
    ),
  }),
);

/** Desired component placement for one application materialization at one site. */
export const componentPlacements = sqliteTable(
  'component_placements',
  {
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    desiredInstances: integer('desired_instances').notNull(),
    defaultInstances: integer('default_instances').notNull().default(1),
    minimumReady: integer('minimum_ready').notNull().default(1),
    rolloutStrategy: text('rollout_strategy').notNull().default('rolling'),
    maxSurge: integer('max_surge').notNull().default(1),
    maxUnavailable: integer('max_unavailable').notNull().default(0),
    placementIntent: text('placement_intent').notNull().default('coLocate'),
    capacity: text('capacity').notNull().default('{}'),
    releaseDigest: text('release_digest').notNull(),
    configurationDigest: text('configuration_digest').notNull(),
    generation: integer('generation').notNull().default(1),
    state: text('state').notNull().default('pending'),
    profile: text('profile'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.siteId, table.componentKey] }),
    deploymentIdx: index('idx_component_placements_deployment').on(
      table.deploymentName,
      table.siteId,
    ),
  }),
);

/** Site-local fixed-count intent layered over the portable manifest default. */
export const componentSiteOverrides = sqliteTable(
  'component_site_overrides',
  {
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    instances: integer('instances').notNull(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.siteId, table.componentKey] }),
    deploymentIdx: index('idx_component_site_overrides_deployment').on(
      table.deploymentName,
      table.siteId,
    ),
  }),
);

/** Ephemeral Docker instance projection. Multiple rows may overlap one slot during a rollout. */
export const componentInstances = sqliteTable(
  'component_instances',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    slotKey: text('slot_key').notNull(),
    nodeId: text('node_id'),
    releaseDigest: text('release_digest').notNull(),
    configurationDigest: text('configuration_digest').notNull(),
    image: text('image').notNull(),
    containerId: text('container_id'),
    containerName: text('container_name').notNull(),
    status: text('status').notNull(),
    health: text('health').notNull().default('unknown'),
    replacementFor: text('replacement_for'),
    drainDeadline: integer('drain_deadline'),
    readyAt: integer('ready_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    appComponentIdx: index('idx_component_instances_app_component').on(
      table.appId,
      table.siteId,
      table.componentKey,
      table.status,
    ),
    slotIdx: index('idx_component_instances_slot').on(table.appId, table.siteId, table.slotKey),
    containerIdx: uniqueIndex('idx_component_instances_container').on(table.containerName),
  }),
);

/** Stable component interface identity and its atomically selected endpoint generation. */
export const componentServices = sqliteTable(
  'component_services',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    componentKey: text('component_key').notNull(),
    interfaceKey: text('interface_key').notNull(),
    protocol: text('protocol').notNull(),
    containerPort: integer('container_port').notNull(),
    published: integer('published', { mode: 'boolean' }).notNull().default(false),
    membershipGeneration: integer('membership_generation').notNull().default(0),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    appIdx: index('idx_component_services_app').on(table.appId, table.published),
    deploymentIdx: index('idx_component_services_deployment').on(table.deploymentName),
  }),
);

/** Health-gated endpoint membership; only the service's active generation is routable. */
export const serviceEndpoints = sqliteTable(
  'service_endpoints',
  {
    id: text('id').primaryKey(),
    serviceId: text('service_id').notNull(),
    instanceId: text('instance_id').notNull(),
    siteId: text('site_id').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    readiness: text('readiness').notNull(),
    releaseDigest: text('release_digest').notNull(),
    configurationDigest: text('configuration_digest').notNull(),
    admittedGeneration: integer('admitted_generation').notNull().default(0),
    drainDeadline: integer('drain_deadline'),
    lastHealthAt: integer('last_health_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    serviceGenerationIdx: index('idx_service_endpoints_generation').on(
      table.serviceId,
      table.admittedGeneration,
      table.readiness,
    ),
    instanceIdx: index('idx_service_endpoints_instance').on(table.instanceId),
  }),
);

/** Site-local exactly-once evidence for lifecycle jobs. */
export const componentJobExecutions = sqliteTable(
  'component_job_executions',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    releaseDigest: text('release_digest').notNull(),
    configurationDigest: text('configuration_digest').notNull(),
    jobKey: text('job_key').notNull(),
    componentKey: text('component_key').notNull(),
    scope: text('scope').notNull(),
    instanceId: text('instance_id'),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    containerId: text('container_id'),
    exitCode: integer('exit_code'),
    output: text('output'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: integer('lease_expires_at'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    appStatusIdx: index('idx_component_jobs_app_status').on(
      table.appId,
      table.siteId,
      table.status,
    ),
  }),
);

/** Actual instance-to-provider attachment evidence, distinct from the manifest contract. */
export const actualVolumeAttachments = sqliteTable(
  'actual_volume_attachments',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    resourceKey: text('resource_key').notNull(),
    componentKey: text('component_key').notNull(),
    instanceId: text('instance_id').notNull(),
    providerVolume: text('provider_volume').notNull(),
    mountPath: text('mount_path').notNull(),
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    instanceIdx: index('idx_actual_volume_attachments_instance').on(table.instanceId),
    resourceIdx: index('idx_actual_volume_attachments_resource').on(
      table.appId,
      table.siteId,
      table.resourceKey,
    ),
  }),
);

/** Durable evidence and result for profile-owned health, backup, restore, and upgrade commands. */
export const componentProfileOperations = sqliteTable(
  'component_profile_operations',
  {
    id: text('id').primaryKey(),
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    instanceId: text('instance_id'),
    profile: text('profile').notNull(),
    operation: text('operation').notNull(),
    command: text('command').notNull(),
    status: text('status').notNull(),
    artifactPath: text('artifact_path'),
    artifactDigest: text('artifact_digest'),
    artifactMediaType: text('artifact_media_type'),
    sourceSpecDigest: text('source_spec_digest'),
    targetSpecDigest: text('target_spec_digest'),
    sourceVolume: text('source_volume'),
    targetVolume: text('target_volume'),
    rollbackVolume: text('rollback_volume'),
    evidence: text('evidence').notNull().default('{}'),
    verification: text('verification'),
    exitCode: integer('exit_code'),
    output: text('output'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    appOperationIdx: index('idx_component_profile_operations_app').on(
      table.appId,
      table.siteId,
      table.componentKey,
      table.operation,
    ),
  }),
);

/** Active and rollback provider volumes selected by a profile-owned verified transition. */
export const componentProfileVolumeBindings = sqliteTable(
  'component_profile_volume_bindings',
  {
    appId: text('app_id').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    resourceKey: text('resource_key').notNull(),
    activeProviderVolume: text('active_provider_volume').notNull(),
    rollbackProviderVolume: text('rollback_provider_volume'),
    activeOperationId: text('active_operation_id').notNull(),
    rollbackOperationId: text('rollback_operation_id'),
    activeSpecDigest: text('active_spec_digest').notNull(),
    rollbackSpecDigest: text('rollback_spec_digest'),
    artifactDigest: text('artifact_digest'),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({
      columns: [table.appId, table.siteId, table.componentKey, table.resourceKey],
    }),
  }),
);

/** Encrypted server-generated profile values such as a PostgreSQL password. */
export const componentProfileValues = sqliteTable(
  'component_profile_values',
  {
    appId: text('app_id').notNull(),
    deploymentName: text('deployment_name').notNull(),
    siteId: text('site_id').notNull(),
    componentKey: text('component_key').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
    valueDigest: text('value_digest').notNull(),
    secret: integer('secret', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.siteId, table.componentKey, table.key] }),
    deploymentIdx: index('idx_component_profile_values_deployment').on(table.deploymentName),
  }),
);

export const nodes = sqliteTable(
  'nodes',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    kind: text('kind').notNull().default('agent'),
    platform: text('platform'),
    architecture: text('architecture'),
    agentVersion: text('agent_version'),
    address: text('address'),
    capabilities: text('capabilities'),
    credentialHash: text('credential_hash'),
    enrolledAt: text('enrolled_at').notNull(),
    lastSeenAt: integer('last_seen_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => ({
    lastSeenIdx: index('idx_nodes_last_seen').on(table.lastSeenAt),
  }),
);

export const nodeEnrollments = sqliteTable(
  'node_enrollments',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    codeHash: text('code_hash').notNull().unique(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => ({
    expiresIdx: index('idx_node_enrollments_expires').on(table.expiresAt),
  }),
);

export const agentJobs = sqliteTable(
  'agent_jobs',
  {
    id: text('id').primaryKey(),
    nodeId: text('node_id').notNull(),
    type: text('type').notNull(),
    deploymentName: text('deployment_name').notNull(),
    artifactPath: text('artifact_path'),
    payload: text('payload').notNull(),
    status: text('status').notNull().default('queued'),
    result: text('result'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
    claimedAt: integer('claimed_at'),
    completedAt: integer('completed_at'),
  },
  (table) => ({
    nodeStatusIdx: index('idx_agent_jobs_node_status').on(
      table.nodeId,
      table.status,
      table.createdAt,
    ),
  }),
);

export const history = sqliteTable(
  'history',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    action: text('action').notNull(),
    username: text('username'),
    type: text('type'),
    port: integer('port'),
    containerId: text('container_id'),
    buildLogId: integer('build_log_id'),
    durationMs: integer('duration_ms'),
    source: text('source'),
    timestamp: text('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_history_deployment').on(table.deploymentName),
  }),
);

export const requestLogs = sqliteTable(
  'request_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    duration: integer('duration').notNull(),
    timestamp: integer('timestamp').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    referrer: text('referrer'),
    requestSize: integer('request_size'),
    responseSize: integer('response_size'),
    queryParams: text('query_params'),
    username: text('username'),
    /** Points at `.deploy-data/captures/<app>/<id>.json` for 5xx rows. */
    captureId: text('capture_id'),
  },
  (table) => ({
    deploymentIdx: index('idx_request_logs_deployment').on(table.deploymentName),
    timestampIdx: index('idx_request_logs_timestamp').on(table.deploymentName, table.timestamp),
    // Fleet-wide queries (dashboard aggregate every 5s, fleet series) filter on
    // timestamp alone — the composite (deployment_name, timestamp) index can't
    // serve those, so without this they full-scan the table.
    tsOnlyIdx: index('idx_request_logs_ts').on(table.timestamp),
  }),
);

// 1-minute rollups of request_logs, upserted by the log-flush transaction.
// Fleet-wide and long-range chart queries read these instead of scanning raw
// per-request rows; raw rows are kept (90d) for per-path detail and exact
// percentiles.
export const requestLogs1m = sqliteTable(
  'request_logs_1m',
  {
    deploymentName: text('deployment_name').notNull(),
    /** Epoch ms floored to the minute. */
    bucketMs: integer('bucket_ms').notNull(),
    count: integer('count').notNull().default(0),
    errors4xx: integer('errors_4xx').notNull().default(0),
    errors5xx: integer('errors_5xx').notNull().default(0),
    durationSum: integer('duration_sum').notNull().default(0),
    durationMin: integer('duration_min').notNull().default(0),
    durationMax: integer('duration_max').notNull().default(0),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.deploymentName, table.bucketMs] }),
    bucketIdx: index('idx_request_logs_1m_bucket').on(table.bucketMs),
  }),
);

export const resourceMetrics = sqliteTable(
  'resource_metrics',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    cpuPercent: real('cpu_percent').notNull(),
    memUsageBytes: integer('mem_usage_bytes').notNull(),
    memLimitBytes: integer('mem_limit_bytes').notNull(),
    memPercent: real('mem_percent').notNull(),
    netRxBytes: integer('net_rx_bytes').notNull(),
    netTxBytes: integer('net_tx_bytes').notNull(),
    blockReadBytes: integer('block_read_bytes').notNull(),
    blockWriteBytes: integer('block_write_bytes').notNull(),
    pids: integer('pids').notNull(),
    timestamp: integer('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_resource_metrics_deployment').on(table.deploymentName),
    timestampIdx: index('idx_resource_metrics_timestamp').on(table.deploymentName, table.timestamp),
    // Latest-per-app subqueries (dashboard aggregate, getLatestMetricsAll)
    // filter on timestamp alone before grouping.
    tsOnlyIdx: index('idx_resource_metrics_ts').on(table.timestamp),
  }),
);

export const backups = sqliteTable(
  'backups',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    filename: text('filename').notNull(),
    label: text('label'),
    sizeBytes: integer('size_bytes').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
    volumePaths: text('volume_paths').notNull(),
    relatedBuildLogId: integer('related_build_log_id'),
    auto: integer('auto', { mode: 'boolean' }).default(false),
  },
  (table) => ({
    deploymentIdx: index('idx_backups_deployment').on(table.deploymentName),
    createdIdx: index('idx_backups_created').on(table.deploymentName, table.createdAt),
  }),
);

export const buildLogs = sqliteTable(
  'build_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    deploymentName: text('deployment_name').notNull(),
    output: text('output').notNull(),
    success: integer('success', { mode: 'boolean' }),
    duration: integer('duration'),
    status: text('status').notNull().default('complete'),
    runtimeLogs: text('runtime_logs'),
    timestamp: text('timestamp').notNull(),
  },
  (table) => ({
    deploymentIdx: index('idx_build_logs_deployment').on(table.deploymentName),
    timestampIdx: index('idx_build_logs_timestamp').on(table.deploymentName, table.timestamp),
  }),
);

export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});
