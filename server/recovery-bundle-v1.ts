// Format v1 compatibility only. Never pass the live database here: these queries read the
// database extracted from a historical bundle. Preserve its canonical inventory verbatim.
import type { Database } from './kernel/db/sqlite.ts';

const LEGACY_INVENTORY_TABLES = [
  'deployments',
  'application_spec_revisions',
  'application_spec_transitions',
  'application_configuration_values',
  'fleets',
  'sites',
  'application_aliases',
  'fleet_events',
  'site_sync_cursors',
  'data_sync_policies',
  'data_checkpoints',
  'data_conflicts',
  'artifacts',
  'release_candidates',
] as const;

export interface LegacyRecoveryInventory {
  fleetId: string;
  homeSiteId: string;
  counts: Record<string, number>;
  authority: Array<{
    appId: string;
    epoch: number;
    generation: number;
    desiredRelease: string | null;
  }>;
  sites: Array<{ id: string; status: string; revokedAt: string | null }>;
  cursors: Array<{ local: string; remote: string; stream: string; sequence: number }>;
  checkpoints: Array<{
    id: string;
    appId: string;
    parentId: string | null;
    manifestDigest: string;
  }>;
  artifacts: Array<{ digest: string; type: string; verification: string; retention: string }>;
}

function tableCount(database: Database, table: string): number {
  if (!(LEGACY_INVENTORY_TABLES as readonly string[]).includes(table)) {
    throw new Error('Unsupported recovery inventory table');
  }
  return Number(
    (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
  );
}

export function buildLegacyRecoveryInventory(sqlite: Database): LegacyRecoveryInventory {
  const fleet = sqlite
    .prepare('SELECT id, home_site_id FROM fleets ORDER BY created_at LIMIT 1')
    .get() as { id: string; home_site_id: string } | undefined;
  if (!fleet) throw new Error('Recovery inventory requires a fleet identity');
  return {
    fleetId: fleet.id,
    homeSiteId: fleet.home_site_id,
    counts: Object.fromEntries(
      LEGACY_INVENTORY_TABLES.map((table) => [table, tableCount(sqlite, table)]),
    ),
    authority: (
      sqlite
        .prepare(
          `SELECT app_id, release_authority_epoch, release_generation, desired_release_digest
             FROM deployments WHERE app_id IS NOT NULL ORDER BY app_id`,
        )
        .all() as Array<{
        app_id: string;
        release_authority_epoch: number;
        release_generation: number;
        desired_release_digest: string | null;
      }>
    ).map((row) => ({
      appId: row.app_id,
      epoch: row.release_authority_epoch,
      generation: row.release_generation,
      desiredRelease: row.desired_release_digest,
    })),
    sites: (
      sqlite
        .prepare('SELECT id, credential_status, revoked_at FROM sites ORDER BY id')
        .all() as Array<{ id: string; credential_status: string; revoked_at: string | null }>
    ).map((row) => ({ id: row.id, status: row.credential_status, revokedAt: row.revoked_at })),
    cursors: (
      sqlite
        .prepare(
          `SELECT local_site_id, remote_site_id, stream, last_accepted_sequence
             FROM site_sync_cursors ORDER BY local_site_id, remote_site_id, stream`,
        )
        .all() as Array<{
        local_site_id: string;
        remote_site_id: string;
        stream: string;
        last_accepted_sequence: number;
      }>
    ).map((row) => ({
      local: row.local_site_id,
      remote: row.remote_site_id,
      stream: row.stream,
      sequence: row.last_accepted_sequence,
    })),
    checkpoints: (
      sqlite
        .prepare(
          `SELECT id, app_id, parent_id, manifest_artifact_digest
             FROM data_checkpoints ORDER BY app_id, sequence`,
        )
        .all() as Array<{
        id: string;
        app_id: string;
        parent_id: string | null;
        manifest_artifact_digest: string;
      }>
    ).map((row) => ({
      id: row.id,
      appId: row.app_id,
      parentId: row.parent_id,
      manifestDigest: row.manifest_artifact_digest,
    })),
    artifacts: (
      sqlite
        .prepare(
          `SELECT digest, type, verification_status, retention_class
             FROM artifacts ORDER BY digest`,
        )
        .all() as Array<{
        digest: string;
        type: string;
        verification_status: string;
        retention_class: string;
      }>
    ).map((row) => ({
      digest: row.digest,
      type: row.type,
      verification: row.verification_status,
      retention: row.retention_class,
    })),
  };
}

export function auditLegacyPortableLineage(database: Database) {
  const applicationIds = new Set(
    (
      database.prepare('SELECT app_id FROM deployments WHERE app_id IS NOT NULL').all() as Array<{
        app_id: string;
      }>
    )
      .map((row) => row.app_id)
      .filter(Boolean),
  );
  const siteIds = new Set(
    (database.prepare('SELECT id FROM sites').all() as Array<{ id: string }>).map((row) => row.id),
  );
  const policies = database
    .prepare(
      'SELECT app_id, site_id, policy, conflict_policy, acknowledged_risks, revision FROM data_sync_policies',
    )
    .all() as Array<{
    app_id: string;
    site_id: string;
    policy: string;
    conflict_policy: string;
    acknowledged_risks: string;
    revision: number;
  }>;
  for (const policy of policies) {
    if (
      !applicationIds.has(policy.app_id) ||
      (policy.site_id && !siteIds.has(policy.site_id)) ||
      !['automatic', 'manual', 'none'].includes(policy.policy) ||
      !['collect', 'prefer-home', 'prefer-suitcase'].includes(policy.conflict_policy) ||
      !Number.isSafeInteger(policy.revision) ||
      policy.revision < 1
    ) {
      throw new Error('Recovered data sync policy has an invalid app, site, mode, or revision');
    }
    const risks = JSON.parse(policy.acknowledged_risks) as unknown;
    if (!Array.isArray(risks) || risks.some((risk) => typeof risk !== 'string')) {
      throw new Error('Recovered data sync policy has invalid risk acknowledgements');
    }
  }

  const checkpoints = database
    .prepare(
      `SELECT id, app_id, parent_id, origin_site_id, sequence, manifest_artifact_digest
         FROM data_checkpoints`,
    )
    .all() as Array<{
    id: string;
    app_id: string;
    parent_id: string | null;
    origin_site_id: string;
    sequence: number;
    manifest_artifact_digest: string;
  }>;
  const checkpointMap = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  for (const checkpoint of checkpoints) {
    const parent = checkpoint.parent_id ? checkpointMap.get(checkpoint.parent_id) : undefined;
    if (
      !applicationIds.has(checkpoint.app_id) ||
      !siteIds.has(checkpoint.origin_site_id) ||
      !Number.isSafeInteger(checkpoint.sequence) ||
      checkpoint.sequence < 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(checkpoint.manifest_artifact_digest) ||
      (checkpoint.parent_id &&
        (!parent || parent.app_id !== checkpoint.app_id || parent.sequence >= checkpoint.sequence))
    ) {
      throw new Error('Recovered checkpoint has an invalid app, site, sequence, digest, or parent');
    }
    const seen = new Set<string>();
    let cursor: typeof checkpoint | undefined = checkpoint;
    while (cursor) {
      if (seen.has(cursor.id)) throw new Error('Recovered checkpoint lineage contains a cycle');
      seen.add(cursor.id);
      cursor = cursor.parent_id ? checkpointMap.get(cursor.parent_id) : undefined;
    }
  }
  const replicaCheckpoints = database
    .prepare(
      `SELECT app_id, base_checkpoint_id, branch_checkpoint_id FROM app_replicas
        WHERE base_checkpoint_id IS NOT NULL OR branch_checkpoint_id IS NOT NULL`,
    )
    .all() as Array<{
    app_id: string;
    base_checkpoint_id: string | null;
    branch_checkpoint_id: string | null;
  }>;
  for (const replica of replicaCheckpoints) {
    for (const checkpointId of [replica.base_checkpoint_id, replica.branch_checkpoint_id]) {
      if (checkpointId && checkpointMap.get(checkpointId)?.app_id !== replica.app_id) {
        throw new Error('Recovered replica references a missing or foreign checkpoint');
      }
    }
  }
  return { dataPolicies: policies.length, checkpoints: checkpoints.length };
}

export function auditLegacySites(database: Database, fleetId: string, homeSiteId: string): number {
  const sites = database.prepare('SELECT id, fleet_id, kind FROM sites').all() as Array<{
    id: string;
    fleet_id: string;
    kind: string;
  }>;
  if (
    new Set(sites.map((site) => site.id)).size !== sites.length ||
    sites.some((site) => site.fleet_id !== fleetId) ||
    sites.filter((site) => site.kind === 'home').length !== 1 ||
    !sites.some((site) => site.id === homeSiteId && site.kind === 'home')
  ) {
    throw new Error('Rehearsed database contains duplicate, foreign, or ambiguous site identity');
  }
  return sites.length;
}
