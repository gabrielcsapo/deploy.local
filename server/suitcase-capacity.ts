import { getBuildCacheSize } from './docker.ts';
import { parseStoredApplicationSpec, type ApplicationSpec } from './application-spec.ts';
import type { CapacityQuantity, SuitcaseCapacityInput } from './portability.ts';
import { getSqlite } from './store.ts';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const OBSERVATION_WINDOW_DAYS = 30;

export interface CapacitySelectionRequest {
  selectedAppIds: string[];
  tripHorizonDays: number;
  offlineBuilds: boolean;
  projectedDailyGrowthBytes?: number;
  retainedBackupCopies?: number;
  targetSiteId?: string;
  observationWindowDays?: number;
}

interface DeploymentEvidence {
  name: string;
  appId: string;
  memoryLimit: string | null;
  sourceArtifactDigest: string | null;
  imageArtifactDigest: string | null;
  snapshotArtifactDigest: string | null;
  spec: ApplicationSpec;
}

interface MetricRow {
  deployment_name: string;
  mem_usage_bytes: number;
  timestamp: number;
}

function parseMemory(value: string | null): number | null {
  if (!value) return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([bkmgt])$/i);
  if (!match) return null;
  const factor = { b: 1, k: 1024, m: MIB, g: GIB, t: 1024 ** 4 }[
    match[2]!.toLowerCase() as 'b' | 'k' | 'm' | 'g' | 't'
  ];
  return Math.round(Number(match[1]) * factor);
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function artifactInventory(digests: Iterable<string | null | undefined>): {
  bytes: number;
  found: number;
  requested: number;
  architectures: string[];
} {
  const unique = [...new Set([...digests].filter((digest): digest is string => Boolean(digest)))];
  if (unique.length === 0) return { bytes: 0, found: 0, requested: 0, architectures: [] };
  const sqlite = getSqlite()!;
  let bytes = 0;
  let found = 0;
  const architectures = new Set<string>();
  for (const digest of unique) {
    const artifact = sqlite
      .prepare('SELECT byte_size, architecture FROM artifacts WHERE digest = ?')
      .get(digest) as { byte_size: number; architecture: string | null } | undefined;
    if (!artifact) continue;
    bytes += Number(artifact.byte_size);
    found += 1;
    if (artifact.architecture) architectures.add(artifact.architecture);
  }
  return { bytes, found, requested: unique.length, architectures: [...architectures].sort() };
}

function concurrentRuntimeEvidence(deploymentNames: string[], windowDays: number) {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const placeholders = deploymentNames.map(() => '?').join(', ');
  const rows = getSqlite()!
    .prepare(
      `SELECT deployment_name, mem_usage_bytes, timestamp
         FROM resource_metrics
        WHERE deployment_name IN (${placeholders}) AND timestamp >= ?
        ORDER BY timestamp`,
    )
    .all(...deploymentNames, cutoff) as MetricRow[];
  const buckets = new Map<number, Map<string, number>>();
  for (const row of rows) {
    const bucket = Math.floor(Number(row.timestamp) / 60_000) * 60_000;
    const byDeployment = buckets.get(bucket) ?? new Map<string, number>();
    byDeployment.set(
      row.deployment_name,
      Math.max(byDeployment.get(row.deployment_name) || 0, Number(row.mem_usage_bytes)),
    );
    buckets.set(bucket, byDeployment);
  }
  let peakAt: number | null = null;
  let peakBytes = -1;
  let peakByDeployment = new Map<string, number>();
  for (const [bucket, byDeployment] of buckets) {
    const total = [...byDeployment.values()].reduce((sum, bytes) => sum + bytes, 0);
    if (total <= peakBytes) continue;
    peakBytes = total;
    peakAt = bucket;
    peakByDeployment = byDeployment;
  }
  return {
    rows,
    peakByDeployment,
    window: {
      startAt: rows.length ? new Date(rows[0]!.timestamp).toISOString() : null,
      endAt: rows.length ? new Date(rows.at(-1)!.timestamp).toISOString() : null,
      sampleCount: rows.length,
      peakAt: peakAt === null ? null : new Date(peakAt).toISOString(),
    },
  };
}

function buildPeakFromOutput(output: string): number | null {
  const matches = [
    ...output.matchAll(
      /(?:buildPeakMemoryBytes|build[_ -]?peak[_ -]?memory(?:[_ -]?bytes)?)\s*[=:]\s*(\d+)/gi,
    ),
  ];
  if (matches.length === 0) return null;
  return Math.max(...matches.map((match) => Number(match[1])).filter(Number.isFinite));
}

function buildEvidence(deployment: DeploymentEvidence, defaultBytes: number): CapacityQuantity {
  const rows = getSqlite()!
    .prepare(
      `SELECT output, duration, success FROM build_logs
        WHERE deployment_name = ? AND status <> 'building'
        ORDER BY timestamp DESC LIMIT 50`,
    )
    .all(deployment.name) as Array<{
    output: string;
    duration: number | null;
    success: number | null;
  }>;
  const measured = rows
    .map((row) => buildPeakFromOutput(String(row.output || '')))
    .filter((bytes): bytes is number => bytes !== null);
  if (measured.length > 0) {
    return {
      bytes: Math.max(...measured),
      confidence: 'measured',
      source: `${measured.length} retained build memory observation(s)`,
    };
  }
  const completed = rows.filter((row) => row.success === 1);
  const durations = completed
    .map((row) => Number(row.duration))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  return {
    bytes: defaultBytes,
    confidence: 'default',
    source:
      completed.length > 0
        ? `${completed.length} retained successful build(s), ${durations.length ? `${Math.max(...durations)} ms longest duration, ` : ''}but no retained build RSS; conservative default`
        : 'no retained successful build memory probe; conservative default',
  };
}

function retainedReleaseDigests(deployments: DeploymentEvidence[]): Set<string> {
  const sqlite = getSqlite()!;
  const digests = new Set<string>();
  for (const deployment of deployments) {
    for (const digest of [deployment.sourceArtifactDigest, deployment.imageArtifactDigest]) {
      if (digest) digests.add(digest);
    }
    const candidates = sqlite
      .prepare(
        `SELECT artifact_digests FROM release_candidates
          WHERE app_id = ? AND state NOT IN ('discarded', 'superseded')`,
      )
      .all(deployment.appId) as Array<{ artifact_digests: string }>;
    for (const candidate of candidates) {
      for (const digest of stringArray(candidate.artifact_digests)) digests.add(digest);
    }
    const releases = sqlite
      .prepare(
        `SELECT artifact_digests FROM fleet_events
          WHERE app_id = ? AND operation = 'application.revision.activated'
          ORDER BY created_at DESC LIMIT 2`,
      )
      .all(deployment.appId) as Array<{ artifact_digests: string }>;
    for (const release of releases) {
      for (const digest of stringArray(release.artifact_digests)) digests.add(digest);
    }
  }
  return digests;
}

function checkpointAndConflictDigests(appIds: string[]): Set<string> {
  const sqlite = getSqlite()!;
  const digests = new Set<string>();
  for (const appId of appIds) {
    const checkpoints = sqlite
      .prepare(
        `SELECT database_artifact_digest, filesystem_artifact_digest,
                manifest_artifact_digest FROM data_checkpoints WHERE app_id = ?`,
      )
      .all(appId) as Array<Record<string, string | null>>;
    const changesets = sqlite
      .prepare(
        `SELECT branch_manifest_digest, database_artifact_digest,
                file_delta_artifact_digest FROM data_changesets WHERE app_id = ?`,
      )
      .all(appId) as Array<Record<string, string | null>>;
    const blobs = sqlite
      .prepare('SELECT digest FROM blob_references WHERE app_id = ? AND digest IS NOT NULL')
      .all(appId) as Array<{ digest: string }>;
    for (const row of [...checkpoints, ...changesets]) {
      for (const value of Object.values(row)) if (value) digests.add(value);
    }
    for (const blob of blobs) digests.add(blob.digest);
  }
  return digests;
}

function currentDataEvidence(deployments: DeploymentEvidence[]): CapacityQuantity {
  const sqlite = getSqlite()!;
  let bytes = 0;
  const missing: string[] = [];
  for (const deployment of deployments) {
    const durable = Object.values(deployment.spec.resources).some(
      (resource) => resource.durability === 'durable',
    );
    if (!durable) continue;
    const snapshot = sqlite
      .prepare(
        `SELECT logical_bytes FROM volume_snapshots
          WHERE app_id = ? AND verification_status = 'verified'
          ORDER BY authority_epoch DESC, data_sequence DESC LIMIT 1`,
      )
      .get(deployment.appId) as { logical_bytes: number } | undefined;
    if (snapshot) {
      bytes += Number(snapshot.logical_bytes);
      continue;
    }
    const checkpoint = sqlite
      .prepare(
        `SELECT database_artifact_digest FROM data_checkpoints
          WHERE app_id = ? AND verification_status = 'verified'
          ORDER BY sequence DESC LIMIT 1`,
      )
      .get(deployment.appId) as { database_artifact_digest: string | null } | undefined;
    const blobBytes = Number(
      (
        sqlite
          .prepare(
            `SELECT COALESCE(SUM(CAST(json_extract(metadata, '$.byteSize') AS INTEGER)), 0) AS bytes
               FROM blob_references WHERE app_id = ? AND checkpoint_id = (
                 SELECT id FROM data_checkpoints WHERE app_id = ?
                  AND verification_status = 'verified' ORDER BY sequence DESC LIMIT 1
               )`,
          )
          .get(deployment.appId, deployment.appId) as { bytes: number }
      ).bytes,
    );
    const databaseBytes = checkpoint?.database_artifact_digest
      ? artifactInventory([checkpoint.database_artifact_digest]).bytes
      : 0;
    if (!checkpoint && blobBytes === 0) missing.push(deployment.name);
    bytes += databaseBytes + blobBytes;
  }
  return {
    bytes,
    confidence: missing.length > 0 ? 'unknown' : 'measured',
    source:
      missing.length > 0
        ? `no verified data size for ${missing.join(', ')}`
        : 'latest verified volume snapshots/checkpoints',
  };
}

function rollbackEvidence(deployments: DeploymentEvidence[]): CapacityQuantity {
  const sqlite = getSqlite()!;
  const digests = new Set<string>();
  for (const deployment of deployments) {
    if (deployment.snapshotArtifactDigest) digests.add(deployment.snapshotArtifactDigest);
    const rows = sqlite
      .prepare(
        `SELECT artifact_digest FROM catalog_recovery_points
          WHERE application_name = ? AND status = 'verified' AND artifact_digest IS NOT NULL`,
      )
      .all(deployment.name) as Array<{ artifact_digest: string }>;
    for (const row of rows) digests.add(row.artifact_digest);
  }
  const inventory = artifactInventory(digests);
  return {
    bytes: inventory.bytes,
    confidence: inventory.found === inventory.requested ? 'measured' : 'unknown',
    source:
      inventory.requested === 0
        ? 'no retained rollback artifacts'
        : `${inventory.found}/${inventory.requested} rollback artifacts measured`,
  };
}

function targetProbe(siteId: string | undefined): SuitcaseCapacityInput['targetProbe'] {
  if (!siteId) return undefined;
  const site = getSqlite()!
    .prepare(
      `SELECT id, name, platform, architecture, capabilities, last_contact_at
         FROM sites WHERE id = ? AND kind = 'suitcase' AND removed_at IS NULL`,
    )
    .get(siteId) as
    | {
        id: string;
        name: string;
        platform: string | null;
        architecture: string | null;
        capabilities: string;
        last_contact_at: number | null;
      }
    | undefined;
  if (!site) throw new Error('Capacity target suitcase not found');
  const capabilities = parseObject(site.capabilities);
  const catalog = parseObject(capabilities.catalog);
  const number = (...values: unknown[]): number | null => {
    const value = values.find((candidate) => typeof candidate === 'number' && candidate >= 0);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const boolean = (...values: unknown[]): boolean | null => {
    const value = values.find((candidate) => typeof candidate === 'boolean');
    return typeof value === 'boolean' ? value : null;
  };
  return {
    siteId: site.id,
    siteName: site.name,
    memoryBytes: number(capabilities.memoryBytes, Number(catalog.memoryMiB) * MIB),
    freeStorageBytes: number(capabilities.freeStorageBytes, Number(catalog.storageMiB) * MIB),
    architecture: site.architecture,
    platform: site.platform,
    dockerAvailable: boolean(capabilities.dockerTarget, capabilities.docker),
    offlineBuildAvailable: boolean(catalog.catalogExecution, capabilities.dockerTarget),
    privilegedContainers: boolean(catalog.privilegedContainers),
    hostNetwork: boolean(catalog.hostNetwork),
    observedAt: site.last_contact_at ? new Date(site.last_contact_at).toISOString() : null,
  };
}

/** Build an explainable plan input from retained Home observations and policy. */
export function capacityInputFromSelection(input: CapacitySelectionRequest): SuitcaseCapacityInput {
  const sqlite = getSqlite()!;
  const fleet = sqlite.prepare('SELECT id FROM fleets ORDER BY created_at LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (!fleet) throw new Error('Fleet identity is unavailable');
  const appIds = [...new Set(input.selectedAppIds.filter(Boolean))];
  if (appIds.length === 0) throw new Error('Select at least one application');
  if (appIds.length > 100) throw new Error('At most 100 applications may be planned together');
  const placeholders = appIds.map(() => '?').join(', ');
  const rows = sqlite
    .prepare(
      `SELECT name, app_id, memory_limit, desired_spec_digest, active_spec_digest,
              source_artifact_digest, image_artifact_digest, snapshot_artifact_digest
         FROM deployments WHERE app_id IN (${placeholders}) ORDER BY name`,
    )
    .all(...appIds) as Array<Record<string, unknown>>;
  if (rows.length !== appIds.length) throw new Error('One or more applications were not found');
  const deployments: DeploymentEvidence[] = rows.map((row) => {
    const digest = String(row.desired_spec_digest || row.active_spec_digest || '');
    const revision = digest
      ? (sqlite
          .prepare(
            `SELECT normalized_spec FROM application_spec_revisions
              WHERE deployment_name = ? AND digest = ?`,
          )
          .get(row.name, digest) as { normalized_spec: string } | undefined)
      : undefined;
    if (!revision) throw new Error(`${row.name} has no immutable application graph`);
    return {
      name: String(row.name),
      appId: String(row.app_id),
      memoryLimit: row.memory_limit ? String(row.memory_limit) : null,
      sourceArtifactDigest: row.source_artifact_digest ? String(row.source_artifact_digest) : null,
      imageArtifactDigest: row.image_artifact_digest ? String(row.image_artifact_digest) : null,
      snapshotArtifactDigest: row.snapshot_artifact_digest
        ? String(row.snapshot_artifact_digest)
        : null,
      spec: parseStoredApplicationSpec(revision.normalized_spec),
    };
  });

  const observationDays = Math.max(
    1,
    Math.min(365, input.observationWindowDays ?? OBSERVATION_WINDOW_DAYS),
  );
  const runtimeEvidence = concurrentRuntimeEvidence(
    deployments.map((deployment) => deployment.name),
    observationDays,
  );
  const unknowns: string[] = [];
  const components: SuitcaseCapacityInput['components'] = [];
  let ephemeralStorageBytes = 0;
  let ephemeralDeclared = true;
  let requiresPrivileged = false;
  let requiresHostNetwork = false;
  for (const deployment of deployments) {
    const entries = Object.entries(deployment.spec.components);
    const primary =
      entries.find(([, component]) => component.role === 'web')?.[0] || entries[0]?.[0];
    const observedPrimary = runtimeEvidence.peakByDeployment.get(deployment.name);
    const deploymentLimit = parseMemory(deployment.memoryLimit);
    for (const [componentName, component] of entries) {
      const declared = component.capacity.memoryBytes || deploymentLimit;
      const runtimeWorkingSet: CapacityQuantity =
        componentName === primary && observedPrimary
          ? {
              bytes: observedPrimary,
              confidence: 'measured',
              source: `${observationDays}-day concurrent high-water bucket (${runtimeEvidence.window.peakAt})`,
            }
          : declared
            ? {
                bytes: declared,
                confidence: 'declared',
                source: component.capacity.memoryBytes
                  ? `${deployment.name}/${componentName} deploy.yaml capacity.memoryBytes`
                  : `${deployment.name} container memory limit`,
              }
            : {
                bytes: 512 * MIB,
                confidence: 'default',
                source: `${deployment.name}/${componentName} has no retained runtime high-water or memory declaration`,
              };
      if (runtimeWorkingSet.confidence === 'default') {
        unknowns.push(
          `${deployment.name}/${componentName} runtime peak is unmeasured; using a 512 MiB default`,
        );
      }
      const buildDefault = Math.max(runtimeWorkingSet.bytes * 2, GIB);
      const buildPeak =
        input.offlineBuilds && component.build
          ? component.capacity.buildMemoryBytes
            ? {
                bytes: component.capacity.buildMemoryBytes,
                confidence: 'declared' as const,
                source: `${deployment.name}/${componentName} deploy.yaml capacity.buildMemoryBytes`,
              }
            : buildEvidence(deployment, buildDefault)
          : undefined;
      if (buildPeak?.confidence === 'default') {
        unknowns.push(
          `${deployment.name}/${componentName} build RSS is unmeasured; ${buildPeak.source}`,
        );
      }
      components.push({
        appId: deployment.appId,
        component: componentName,
        instances: component.instances,
        runtimeWorkingSet,
        rollingSurgeInstances:
          component.rollout.strategy === 'rolling' ? component.rollout.maxSurge : 0,
        buildPeak,
      });
      if (component.capacity.ephemeralStorageBytes) {
        ephemeralStorageBytes += component.capacity.ephemeralStorageBytes * component.instances;
      } else {
        ephemeralDeclared = false;
      }
      requiresPrivileged ||= component.runtime.privileged || component.runtime.privilegedDocker;
      requiresHostNetwork ||= component.runtime.networkMode === 'host';
    }
  }
  if (components.length === 0)
    throw new Error('Selected applications contain no runnable components');
  if (runtimeEvidence.rows.length === 0) {
    unknowns.push(`No runtime memory samples exist in the ${observationDays}-day evidence window`);
  } else if (
    runtimeEvidence.rows.at(-1)!.timestamp - runtimeEvidence.rows[0]!.timestamp <
    60 * 60_000
  ) {
    unknowns.push('Runtime memory evidence spans less than one hour and may be unrepresentative');
  }

  const releaseDigests = retainedReleaseDigests(deployments);
  const releases = artifactInventory(releaseDigests);
  if (releases.architectures.length === 0) {
    unknowns.push('Retained application artifacts do not declare target architecture');
  }
  const checkpointInventory = artifactInventory(checkpointAndConflictDigests(appIds));
  const currentData = currentDataEvidence(deployments);
  if (currentData.confidence === 'unknown') unknowns.push(currentData.source);
  const actualCacheBytes = input.offlineBuilds
    ? deployments.reduce((sum, deployment) => sum + getBuildCacheSize(deployment.name), 0)
    : 0;
  const requestedCacheBudget = input.offlineBuilds ? 8 * GIB : 0;
  const backupRows = sqlite
    .prepare(
      `SELECT deployment_name, size_bytes FROM backups
        WHERE deployment_name IN (${deployments.map(() => '?').join(', ')})`,
    )
    .all(...deployments.map((deployment) => deployment.name)) as Array<{
    deployment_name: string;
    size_bytes: number;
  }>;
  const retainedBackupCopies = Math.max(0, Math.min(100, input.retainedBackupCopies ?? 2));
  const measuredBackupBytes = backupRows.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  const policyBackupBytes = currentData.bytes * retainedBackupCopies;
  const backupBytes = Math.max(measuredBackupBytes, policyBackupBytes);
  const syncFacts = sqlite
    .prepare(
      `SELECT COALESCE(SUM(pending_changesets + conflict_count), 0) AS pending
         FROM app_replicas WHERE app_id IN (${placeholders}) AND removed_at IS NULL`,
    )
    .get(...appIds) as { pending: number };
  const helperBytes = 512 * MIB + Math.min(GIB, Number(syncFacts.pending) * 64 * MIB);
  const projectedGrowthBytes =
    Math.max(0, input.projectedDailyGrowthBytes || 0) * input.tripHorizonDays;
  if (projectedGrowthBytes > 0) components[0]!.projectedGrowthBytes = projectedGrowthBytes;

  return {
    fleetId: fleet.id,
    components,
    tripHorizonDays: input.tripHorizonDays,
    offlineBuilds: input.offlineBuilds,
    syncMemoryPeak: {
      bytes: helperBytes,
      confidence: 'default',
      source: `512 MiB helper base plus ${Number(syncFacts.pending)} pending branch/conflict item(s)`,
    },
    currentDataBytes: currentData,
    imageAndSourceBytes: {
      bytes: releases.bytes,
      confidence: releases.found === releases.requested ? 'measured' : 'unknown',
      source:
        releases.requested === 0
          ? 'no source/image artifact inventory'
          : `${releases.found}/${releases.requested} current/rollback release artifacts measured`,
    },
    buildCacheBytes: {
      bytes: actualCacheBytes,
      confidence: 'measured',
      source: input.offlineBuilds
        ? 'selected applications persistent build-cache inventory'
        : 'offline builds disabled; build cache not selected',
    },
    buildCacheReserveBytes: {
      bytes: Math.max(0, requestedCacheBudget - actualCacheBytes),
      confidence: requestedCacheBudget > actualCacheBytes ? 'default' : 'measured',
      source:
        requestedCacheBudget > actualCacheBytes
          ? 'useful serialized offline-build cache budget'
          : 'current measured cache meets the build-cache budget',
    },
    checkpointAndConflictBytes: {
      bytes: checkpointInventory.bytes,
      confidence:
        checkpointInventory.found === checkpointInventory.requested ? 'measured' : 'unknown',
      source: `${checkpointInventory.found}/${checkpointInventory.requested} checkpoint, branch, and conflict artifacts measured`,
    },
    rollbackBytes: rollbackEvidence(deployments),
    backupBytes: {
      bytes: backupBytes,
      confidence:
        measuredBackupBytes >= policyBackupBytes
          ? 'measured'
          : currentData.confidence === 'measured'
            ? 'declared'
            : 'unknown',
      source: `${formatCount(backupRows.length, 'retained backup')} measured; policy reserves ${retainedBackupCopies} data cop${retainedBackupCopies === 1 ? 'y' : 'ies'}`,
    },
    ephemeralStorageBytes: {
      bytes: ephemeralStorageBytes,
      confidence: ephemeralDeclared ? 'declared' : 'unknown',
      source: ephemeralDeclared
        ? 'deploy.yaml component ephemeralStorageBytes declarations'
        : 'one or more components have no ephemeral-storage declaration',
    },
    evidenceUnknowns: [...new Set(unknowns)],
    evidenceWindow: runtimeEvidence.window,
    targetProbe: targetProbe(input.targetSiteId),
    targetRequirements: {
      architectures: releases.architectures,
      docker: true,
      offlineBuild: input.offlineBuilds,
      privilegedContainers: requiresPrivileged,
      hostNetwork: requiresHostNetwork,
    },
  };
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
