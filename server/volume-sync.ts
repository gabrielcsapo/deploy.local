import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
  type GraphMaterializationResult,
  type GraphRecoveryArtifact,
  type GraphRecoveryPointOptions,
} from './application-graph-executor.ts';
import { resolveApplicationConfiguration } from './application-configuration.ts';
import { assertApplicationSuitcaseDataMode } from './application-data-contract.ts';
import { buildApplicationGraphRuntime } from './application-runtime.ts';
import { parseStoredApplicationSpec } from './application-spec.ts';
import { getArtifact, putArtifactBytes, putArtifactFile } from './content-store.ts';
import { deployDataPath } from './data-directory.ts';
import { updateMaterialization } from './fleet-release.ts';
import {
  appendLocalFleetEvent,
  ensureFleetIdentity,
  resolveLocalSiteId,
  sortableId,
} from './multisite.ts';
import { getApplicationSpecRevision, getSqlite } from './store.ts';

const DIGEST = /^sha256:[a-f0-9]{64}$/;

interface ColdRecoveryManifest {
  version: 1;
  applicationId: string;
  siteId: string;
  specDigest: string;
  configurationDigest: string;
  resources: Array<{
    resource: string;
    archive: string;
    digest: `sha256:${string}`;
    bytes: number;
  }>;
}

export interface PortableVolumeSnapshotManifest {
  kind: 'deploy.local/opaque-volume-snapshot';
  version: 1;
  snapshotId: string;
  applicationId: string;
  authoritySiteId: string;
  authorityEpoch: number;
  dataSequence: number;
  parentSnapshotId: string | null;
  specDigest: string;
  configurationDigest: string;
  consistencyMode: 'cold-quiesced';
  resources: Array<{
    resource: string;
    archiveArtifactDigest: `sha256:${string}`;
    bytes: number;
  }>;
  logicalBytes: number;
  createdAt: string;
}

export interface OpaqueVolumeSnapshot {
  id: string;
  manifestArtifactDigest: `sha256:${string}`;
  archiveArtifactDigests: `sha256:${string}`[];
  authoritySiteId: string;
  authorityEpoch: number;
  dataSequence: number;
  parentSnapshotId: string | null;
  logicalBytes: number;
  uniqueBytes: number;
}

export interface OpaqueVolumeExecutor {
  createRecoveryPoint(
    context: GraphExecutorContext,
    destinationDirectory: string,
    options?: GraphRecoveryPointOptions,
  ): Promise<GraphRecoveryArtifact>;
  restoreRecoveryPoint(
    context: GraphExecutorContext,
    artifact: Pick<GraphRecoveryArtifact, 'artifactReference' | 'artifactDigest'>,
  ): Promise<void>;
  converge(context: GraphExecutorContext): Promise<GraphMaterializationResult>;
  stop(context: Pick<GraphExecutorContext, 'applicationId' | 'siteId'>): Promise<void>;
}

interface SnapshotRow {
  id: string;
  authority_site_id: string;
  authority_epoch: number;
  data_sequence: number;
  manifest_artifact_digest: string;
}

export type VolumeAuthorityTransferState =
  | 'requested'
  | 'source-capturing'
  | 'snapshot-ready'
  | 'target-restoring'
  | 'target-ready'
  | 'committed'
  | 'failed'
  | 'aborted';

export interface VolumeAuthorityTransfer {
  id: string;
  appId: string;
  sourceSiteId: string;
  targetSiteId: string;
  state: VolumeAuthorityTransferState;
  expectedSnapshotId: string | null;
  expectedAuthorityEpoch: number;
  expectedDataSequence: number;
  snapshotId: string | null;
  snapshotAuthorityEpoch: number | null;
  snapshotDataSequence: number | null;
  manifestArtifactDigest: string | null;
  requestedBy: string;
  sourceResumed: boolean;
  attempts: number;
  version: number;
  error: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface TransferRow {
  id: string;
  app_id: string;
  source_site_id: string;
  target_site_id: string;
  state: VolumeAuthorityTransferState;
  expected_snapshot_id: string | null;
  expected_authority_epoch: number;
  expected_data_sequence: number;
  snapshot_id: string | null;
  snapshot_authority_epoch: number | null;
  snapshot_data_sequence: number | null;
  manifest_artifact_digest: string | null;
  requested_by: string;
  request_event_id: string | null;
  snapshot_event_id: string | null;
  target_ready_event_id: string | null;
  commit_event_id: string | null;
  terminal_event_id: string | null;
  source_resumed: number;
  attempts: number;
  version: number;
  error: string | null;
  requested_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface VolumeAuthorityTransferPlan {
  applicationId: string;
  sourceSiteId: string;
  targetSiteId: string;
  expectedSnapshotId: string | null;
  expectedAuthorityEpoch: number;
  expectedDataSequence: number;
  consequence: string;
}

export interface VolumeAuthorityTransferWorkerOptions {
  localSiteId?: string;
  transferId?: string;
  executor?: OpaqueVolumeExecutor;
  contextResolver?: (applicationId: string, siteId: string) => GraphExecutorContext;
}

/**
 * Capture an opaque graph while writes are quiesced and convert its local
 * recovery archive into site-neutral content-store artifacts. This is a
 * recovery fast-forward, never a filesystem merge.
 */
export async function captureOpaqueVolumeSnapshot(input: {
  applicationId: string;
  context: GraphExecutorContext;
  executor: Pick<OpaqueVolumeExecutor, 'createRecoveryPoint'>;
  actor: string;
  resume?: boolean;
  retentionClass?: 'checkpoint' | 'recovery';
  transferId?: string;
}): Promise<OpaqueVolumeSnapshot> {
  if (input.context.applicationId !== input.applicationId)
    throw new Error('Opaque snapshot context belongs to another application');
  const activeTransfer = activeTransferRow(input.applicationId);
  if (activeTransfer && activeTransfer.id !== input.transferId) {
    throw new Error(`Opaque volume authority transfer ${activeTransfer.id} owns the capture lock`);
  }
  const previous = latestSnapshot(input.applicationId);
  if (previous && previous.authority_site_id !== input.context.siteId) {
    throw new Error(
      `Opaque volume authority belongs to ${previous.authority_site_id}; generic multi-writer capture is forbidden`,
    );
  }
  const directory = deployDataPath('volume-snapshot-capture');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(directory, `${safeSegment(input.applicationId)}-`));
  try {
    const recovery = await input.executor.createRecoveryPoint(
      input.context,
      resolve(root, 'cold'),
      { resume: input.resume !== false },
    );
    const cold = parseColdManifest(recovery, input.context);
    const resources: PortableVolumeSnapshotManifest['resources'] = [];
    let logicalBytes = 0;
    let uniqueBytes = 0;
    for (const resource of cold.resources) {
      const archive = containedPath(dirname(recovery.artifactReference), resource.archive);
      if (!existsSync(archive) || statSync(archive).size !== resource.bytes)
        throw new Error(`Opaque archive for ${resource.resource} is missing or changed`);
      if (fileDigest(archive) !== resource.digest)
        throw new Error(`Opaque archive digest mismatch for ${resource.resource}`);
      const existed = Boolean(getArtifact(resource.digest));
      const stored = await putArtifactFile(archive, {
        type: 'opaque-volume-chunk',
        mediaType: 'application/gzip',
        retentionClass: input.retentionClass ?? 'recovery',
      });
      if (stored.digest !== resource.digest)
        throw new Error(`Opaque archive ${resource.resource} changed during ingestion`);
      resources.push({
        resource: resource.resource,
        archiveArtifactDigest: stored.digest as `sha256:${string}`,
        bytes: resource.bytes,
      });
      logicalBytes += resource.bytes;
      if (!existed) uniqueBytes += resource.bytes;
    }
    resources.sort((left, right) => left.resource.localeCompare(right.resource));
    const snapshotId = sortableId('volume');
    const authorityEpoch = previous?.authority_epoch ?? 1;
    const dataSequence = (previous?.data_sequence ?? 0) + 1;
    const manifest: PortableVolumeSnapshotManifest = {
      kind: 'deploy.local/opaque-volume-snapshot',
      version: 1,
      snapshotId,
      applicationId: input.applicationId,
      authoritySiteId: input.context.siteId,
      authorityEpoch,
      dataSequence,
      parentSnapshotId: previous?.id ?? null,
      specDigest: input.context.runtime.execution.specDigest,
      configurationDigest: input.context.runtime.configurationDigest,
      consistencyMode: 'cold-quiesced',
      resources,
      logicalBytes,
      createdAt: new Date().toISOString(),
    };
    const manifestArtifact = putArtifactBytes(Buffer.from(canonical(manifest)), {
      type: 'opaque-volume-manifest',
      mediaType: 'application/vnd.deploy.opaque-volume-snapshot+json',
      retentionClass: input.retentionClass ?? 'recovery',
    });
    recordVerifiedSnapshot(manifest, manifestArtifact.digest, uniqueBytes, {
      latestHomeRecovery: process.env.DEPLOY_SUITCASE !== '1',
    });
    appendLocalFleetEvent({
      originSiteId: input.context.siteId,
      appId: input.applicationId,
      actor: input.actor,
      operation: 'data.volume.snapshot.created',
      authorityEpoch,
      payload: {
        transferId: input.transferId || null,
        snapshotId,
        authoritySiteId: manifest.authoritySiteId,
        authorityEpoch,
        dataSequence,
        parentSnapshotId: manifest.parentSnapshotId,
        manifestArtifactDigest: manifestArtifact.digest,
        consistencyMode: manifest.consistencyMode,
        logicalBytes,
        uniqueBytes,
      },
      artifactDigests: [
        manifestArtifact.digest,
        ...resources.map((item) => item.archiveArtifactDigest),
      ],
    });
    return {
      id: snapshotId,
      manifestArtifactDigest: manifestArtifact.digest as `sha256:${string}`,
      archiveArtifactDigests: resources.map((resource) => resource.archiveArtifactDigest),
      authoritySiteId: manifest.authoritySiteId,
      authorityEpoch,
      dataSequence,
      parentSnapshotId: manifest.parentSnapshotId,
      logicalBytes,
      uniqueBytes,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Restore a verified opaque snapshot into staging volumes; caller health-gates convergence. */
export async function restoreOpaqueVolumeSnapshot(input: {
  applicationId: string;
  snapshotId: string;
  context: GraphExecutorContext;
  executor: Pick<OpaqueVolumeExecutor, 'restoreRecoveryPoint'>;
}): Promise<PortableVolumeSnapshotManifest> {
  const row = getSqlite()!
    .prepare(
      `SELECT manifest_artifact_digest FROM volume_snapshots
        WHERE id = ? AND app_id = ? AND verification_status = 'verified'`,
    )
    .get(input.snapshotId, input.applicationId) as { manifest_artifact_digest: string } | undefined;
  if (!row) throw new Error('Verified opaque volume snapshot not found');
  const manifest = loadPortableManifest(row.manifest_artifact_digest);
  if (manifest.applicationId !== input.applicationId)
    throw new Error('Opaque volume manifest belongs to another application');
  if (
    manifest.specDigest !== input.context.runtime.execution.specDigest ||
    manifest.configurationDigest !== input.context.runtime.configurationDigest
  ) {
    throw new Error(
      'Opaque volume snapshot does not match the target graph revision/configuration',
    );
  }
  const directory = deployDataPath('volume-snapshot-restore');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(resolve(directory, `${safeSegment(input.applicationId)}-`));
  try {
    const resources: ColdRecoveryManifest['resources'] = [];
    for (const [index, resource] of manifest.resources.entries()) {
      const artifact = getArtifact(resource.archiveArtifactDigest);
      if (!artifact || fileDigest(artifact.localPath) !== resource.archiveArtifactDigest) {
        throw new Error(`Opaque volume artifact ${resource.archiveArtifactDigest} is unavailable`);
      }
      const archive = `${String(index).padStart(4, '0')}.tar.gz`;
      copyFileSync(artifact.localPath, resolve(root, archive));
      resources.push({
        resource: resource.resource,
        archive,
        digest: resource.archiveArtifactDigest,
        bytes: resource.bytes,
      });
    }
    const cold: ColdRecoveryManifest = {
      version: 1,
      applicationId: input.applicationId,
      siteId: input.context.siteId,
      specDigest: manifest.specDigest,
      configurationDigest: manifest.configurationDigest,
      resources,
    };
    const content = Buffer.from(`${JSON.stringify(cold, null, 2)}\n`);
    const manifestPath = resolve(root, 'recovery-manifest.json');
    writeFileSync(manifestPath, content, { mode: 0o600 });
    await input.executor.restoreRecoveryPoint(input.context, {
      artifactReference: manifestPath,
      artifactDigest: digestBytes(content),
    });
    return manifest;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Read-only CAS plan. Starting requires the caller to present this exact boundary. */
export function planOpaqueVolumeAuthorityTransfer(input: {
  applicationId: string;
  targetSiteId: string;
}): VolumeAuthorityTransferPlan {
  const sqlite = getSqlite()!;
  const deployment = sqlite
    .prepare('SELECT name FROM deployments WHERE app_id = ?')
    .get(input.applicationId) as { name: string } | undefined;
  if (!deployment) throw new Error('Application not found');
  assertApplicationSuitcaseDataMode(input.applicationId, 'follows-one-site');
  if (activeTransferRow(input.applicationId)) {
    throw new Error('An opaque volume authority transfer is already active for this application');
  }
  const target = sqlite
    .prepare(
      `SELECT r.data_mode, s.revoked_at
         FROM app_replicas r JOIN sites s ON s.id = r.site_id
        WHERE r.app_id = ? AND r.site_id = ? AND r.removed_at IS NULL`,
    )
    .get(input.applicationId, input.targetSiteId) as
    | { data_mode: string; revoked_at: string | null }
    | undefined;
  if (!target || target.revoked_at) throw new Error('Active target application replica not found');
  if (!target.data_mode.startsWith('follows-one-site')) {
    throw new Error('Writer transfer requires a Follows one site application replica');
  }
  const boundary = currentAuthorityBoundary(input.applicationId);
  if (boundary.sourceSiteId === input.targetSiteId) {
    throw new Error('Target site already owns opaque volume authority');
  }
  return {
    applicationId: input.applicationId,
    sourceSiteId: boundary.sourceSiteId,
    targetSiteId: input.targetSiteId,
    expectedSnapshotId: boundary.snapshotId,
    expectedAuthorityEpoch: boundary.authorityEpoch,
    expectedDataSequence: boundary.dataSequence,
    consequence:
      `The ${boundary.sourceSiteId} graph will be quiesced until ${input.targetSiteId} ` +
      'restores and health-checks the verified cold snapshot. Authority commits only afterward.',
  };
}

export function startOpaqueVolumeAuthorityTransfer(input: {
  applicationId: string;
  targetSiteId: string;
  expectedSnapshotId?: string | null;
  expectedAuthorityEpoch: number;
  expectedDataSequence: number;
  actor: string;
}): VolumeAuthorityTransfer {
  const plan = planOpaqueVolumeAuthorityTransfer(input);
  if (
    plan.expectedSnapshotId !== (input.expectedSnapshotId || null) ||
    plan.expectedAuthorityEpoch !== input.expectedAuthorityEpoch ||
    plan.expectedDataSequence !== input.expectedDataSequence
  ) {
    throw new Error('Opaque volume authority CAS is stale; plan the move again');
  }
  const sqlite = getSqlite()!;
  const id = sortableId('handoff');
  const now = new Date().toISOString();
  const create = sqlite.transaction(() => {
    const current = currentAuthorityBoundary(input.applicationId);
    if (
      activeTransferRow(input.applicationId) ||
      current.sourceSiteId !== plan.sourceSiteId ||
      current.snapshotId !== plan.expectedSnapshotId ||
      current.authorityEpoch !== plan.expectedAuthorityEpoch ||
      current.dataSequence !== plan.expectedDataSequence
    ) {
      throw new Error('Opaque volume authority CAS changed while starting; plan the move again');
    }
    sqlite
      .prepare(
        `INSERT INTO volume_authority_transfers
          (id, app_id, source_site_id, target_site_id, state, expected_snapshot_id,
           expected_authority_epoch, expected_data_sequence, requested_by,
           requested_at, updated_at)
         VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.applicationId,
        plan.sourceSiteId,
        plan.targetSiteId,
        plan.expectedSnapshotId,
        plan.expectedAuthorityEpoch,
        plan.expectedDataSequence,
        input.actor,
        now,
        now,
      );
  });
  create.immediate();
  ensureRequestedEvent(transferRow(id)!);
  return getOpaqueVolumeAuthorityTransfer(id);
}

export function getOpaqueVolumeAuthorityTransfer(transferId: string): VolumeAuthorityTransfer {
  const row = transferRow(transferId);
  if (!row) throw new Error('Opaque volume authority transfer not found');
  return publicTransfer(row);
}

export function listOpaqueVolumeAuthorityTransfers(
  applicationId?: string,
): VolumeAuthorityTransfer[] {
  const rows = (
    applicationId
      ? getSqlite()!
          .prepare(
            'SELECT * FROM volume_authority_transfers WHERE app_id = ? ORDER BY requested_at DESC',
          )
          .all(applicationId)
      : getSqlite()!
          .prepare('SELECT * FROM volume_authority_transfers ORDER BY requested_at DESC')
          .all()
  ) as TransferRow[];
  return rows.map(publicTransfer);
}

export function abortOpaqueVolumeAuthorityTransfer(input: {
  transferId: string;
  actor: string;
  reason?: string;
}): VolumeAuthorityTransfer {
  const row = transferRow(input.transferId);
  if (!row) throw new Error('Opaque volume authority transfer not found');
  if (row.state === 'committed') throw new Error('Committed authority cannot be aborted');
  if (row.state === 'aborted') return publicTransfer(row);
  const now = new Date().toISOString();
  const result = getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET state = 'aborted', error = ?, source_resumed = 0,
              version = version + 1, updated_at = ?, completed_at = ?
        WHERE id = ? AND state != 'committed' AND version = ?`,
    )
    .run(input.reason || 'Aborted by administrator', now, now, row.id, row.version);
  if (result.changes !== 1)
    throw new Error('Authority transfer changed; inspect it before aborting');
  const aborted = transferRow(row.id)!;
  const event = appendTransferEvent(
    aborted,
    'data.volume.authority.transfer.aborted',
    input.actor,
    {
      reason: aborted.error,
    },
  );
  getSqlite()!
    .prepare(
      'UPDATE volume_authority_transfers SET terminal_event_id = ?, updated_at = ? WHERE id = ?',
    )
    .run(event.eventId, event.createdAt, row.id);
  return getOpaqueVolumeAuthorityTransfer(row.id);
}

/**
 * Advance only work owned by the local site. Every cross-site boundary is an
 * authenticated fleet event, so restart simply scans the durable rows again.
 */
export async function processLocalOpaqueVolumeAuthorityTransfers(
  options: VolumeAuthorityTransferWorkerOptions = {},
): Promise<VolumeAuthorityTransfer[]> {
  const localSiteId = options.localSiteId || resolveLocalSiteId();
  const homeSiteId = ensureFleetIdentity().homeSiteId;
  const executor = options.executor || new ApplicationGraphExecutor();
  const contextResolver = options.contextResolver || resolveOpaqueVolumeGraphContext;
  const touched = new Set<string>();

  for (let pass = 0; pass < 8; pass += 1) {
    const rows = (
      getSqlite()!
        .prepare(
          `SELECT * FROM volume_authority_transfers
          WHERE (source_site_id = ? AND state IN ('requested', 'source-capturing', 'snapshot-ready', 'failed', 'aborted', 'committed'))
             OR (target_site_id = ? AND state IN ('snapshot-ready', 'target-restoring', 'target-ready', 'failed', 'aborted', 'committed'))
             OR (? = ? AND state IN ('target-ready', 'committed'))
          ORDER BY requested_at, id`,
        )
        .all(localSiteId, localSiteId, localSiteId, homeSiteId) as TransferRow[]
    ).filter((row) => !options.transferId || row.id === options.transferId);
    let progressed = false;
    for (const initial of rows) {
      const before = transferRow(initial.id)!;
      touched.add(before.id);
      if (!['committed', 'failed', 'aborted'].includes(before.state)) {
        try {
          assertApplicationSuitcaseDataMode(before.app_id, 'follows-one-site');
        } catch (error) {
          failTransfer(before.id, error, false);
          progressed = true;
          continue;
        }
      }
      if (
        (before.state === 'failed' || before.state === 'aborted') &&
        before.target_site_id === localSiteId
      ) {
        await executor.stop({ applicationId: before.app_id, siteId: localSiteId }).catch(() => {});
      }
      if (
        (before.state === 'failed' || before.state === 'aborted') &&
        before.source_site_id === localSiteId &&
        !before.source_resumed
      ) {
        try {
          await resumeTransferSource(before, executor, contextResolver);
          progressed = true;
        } catch (error) {
          setTransferError(
            before.id,
            `Source authority resume is retrying: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      if (before.state === 'requested' && before.source_site_id === localSiteId) {
        ensureRequestedEvent(before);
        progressed = casTransferState(before, ['requested'], 'source-capturing');
        continue;
      }
      if (before.state === 'source-capturing' && before.source_site_id === localSiteId) {
        await captureTransferSource(before, executor, contextResolver);
        progressed = true;
        continue;
      }
      if (before.state === 'snapshot-ready') {
        if (before.source_site_id === localSiteId) ensureSnapshotReadyEvent(before);
        if (before.target_site_id === localSiteId) {
          progressed =
            casTransferState(before, ['snapshot-ready'], 'target-restoring') || progressed;
        }
        continue;
      }
      if (before.state === 'target-restoring' && before.target_site_id === localSiteId) {
        await restoreTransferTarget(before, executor, contextResolver);
        progressed = true;
        continue;
      }
      if (before.state === 'target-ready') {
        if (before.target_site_id === localSiteId) ensureTargetReadyEvent(before);
        if (localSiteId === homeSiteId) {
          commitTransferAuthority(before);
          progressed = true;
        }
        continue;
      }
      if (before.state === 'committed') {
        if (localSiteId === homeSiteId) ensureCommittedEvent(before);
        if (before.target_site_id === localSiteId) {
          try {
            await executor.converge({
              ...contextResolver(before.app_id, localSiteId),
              writerSiteId: localSiteId,
            });
            updateTransferMaterialization(before, 'ready', []);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setTransferError(before.id, `Committed target activation is retrying: ${message}`);
            updateTransferMaterialization(before, 'blocked', [message]);
          }
        }
        if (before.source_site_id === localSiteId) {
          await executor
            .stop({ applicationId: before.app_id, siteId: localSiteId })
            .catch(() => {});
        }
      }
    }
    if (!progressed) break;
  }
  return [...touched].map(getOpaqueVolumeAuthorityTransfer);
}

/**
 * Coordinated same-control-plane authority move. The source remains stopped
 * after final capture; destination becomes authoritative only after restore
 * and graph health admission. Failure resumes the original source.
 */
export async function transferOpaqueVolumeAuthority(input: {
  applicationId: string;
  sourceContext: GraphExecutorContext;
  targetContext: GraphExecutorContext;
  sourceExecutor: OpaqueVolumeExecutor;
  targetExecutor: OpaqueVolumeExecutor;
  actor: string;
  eventOriginSiteId?: string;
}): Promise<OpaqueVolumeSnapshot> {
  if (input.sourceContext.siteId === input.targetContext.siteId)
    throw new Error('Opaque volume authority transfer requires two distinct sites');
  assertApplicationSuitcaseDataMode(input.applicationId, 'follows-one-site');
  const source = await captureOpaqueVolumeSnapshot({
    applicationId: input.applicationId,
    context: input.sourceContext,
    executor: input.sourceExecutor,
    actor: input.actor,
    resume: false,
  });
  try {
    await restoreOpaqueVolumeSnapshot({
      applicationId: input.applicationId,
      snapshotId: source.id,
      context: input.targetContext,
      executor: input.targetExecutor,
    });
    await input.targetExecutor.converge({
      ...input.targetContext,
      writerSiteId: input.targetContext.siteId,
    });
  } catch (error) {
    await input.targetExecutor.stop(input.targetContext).catch(() => {});
    await input.sourceExecutor.converge({
      ...input.sourceContext,
      writerSiteId: input.sourceContext.siteId,
    });
    throw new Error(
      `Opaque volume handoff failed; original writer resumed: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const sourceManifest = loadPortableManifest(source.manifestArtifactDigest);
  const adopted: PortableVolumeSnapshotManifest = {
    ...sourceManifest,
    snapshotId: sortableId('volume'),
    authoritySiteId: input.targetContext.siteId,
    authorityEpoch: source.authorityEpoch + 1,
    dataSequence: source.dataSequence + 1,
    parentSnapshotId: source.id,
    createdAt: new Date().toISOString(),
  };
  const manifestArtifact = putArtifactBytes(Buffer.from(canonical(adopted)), {
    type: 'opaque-volume-manifest',
    mediaType: 'application/vnd.deploy.opaque-volume-snapshot+json',
    retentionClass: 'recovery',
  });
  assertApplicationSuitcaseDataMode(input.applicationId, 'follows-one-site');
  recordVerifiedSnapshot(adopted, manifestArtifact.digest, 0, { latestHomeRecovery: true });
  const sqlite = getSqlite()!;
  const now = new Date().toISOString();
  const commit = sqlite.transaction(() => {
    sqlite
      .prepare(
        "UPDATE deployments SET data_mode = 'follows-one-site', updated_at = ? WHERE app_id = ?",
      )
      .run(now, input.applicationId);
    sqlite
      .prepare(
        `UPDATE app_replicas
            SET data_mode = CASE WHEN site_id = ? THEN 'follows-one-site-writer'
                                 ELSE 'follows-one-site-recovery' END,
                runtime_status = CASE WHEN site_id = ? THEN 'running' ELSE 'recovery-only' END,
                updated_at = ?
          WHERE app_id = ? AND removed_at IS NULL`,
      )
      .run(input.targetContext.siteId, input.targetContext.siteId, now, input.applicationId);
  });
  commit.immediate();
  const fleet = ensureFleetIdentity();
  appendLocalFleetEvent({
    originSiteId: input.eventOriginSiteId ?? fleet.homeSiteId,
    appId: input.applicationId,
    actor: input.actor,
    operation: 'data.volume.authority.committed',
    authorityEpoch: adopted.authorityEpoch,
    payload: {
      snapshotId: adopted.snapshotId,
      previousSnapshotId: source.id,
      authoritySiteId: adopted.authoritySiteId,
      authorityEpoch: adopted.authorityEpoch,
      dataSequence: adopted.dataSequence,
      manifestArtifactDigest: manifestArtifact.digest,
    },
    artifactDigests: [
      manifestArtifact.digest,
      ...adopted.resources.map((resource) => resource.archiveArtifactDigest),
    ],
  });
  return {
    id: adopted.snapshotId,
    manifestArtifactDigest: manifestArtifact.digest as `sha256:${string}`,
    archiveArtifactDigests: adopted.resources.map((resource) => resource.archiveArtifactDigest),
    authoritySiteId: adopted.authoritySiteId,
    authorityEpoch: adopted.authorityEpoch,
    dataSequence: adopted.dataSequence,
    parentSnapshotId: adopted.parentSnapshotId,
    logicalBytes: adopted.logicalBytes,
    uniqueBytes: 0,
  };
}

function activeTransferRow(appId: string): TransferRow | undefined {
  return getSqlite()!
    .prepare(
      `SELECT * FROM volume_authority_transfers
        WHERE app_id = ? AND state IN
          ('requested', 'source-capturing', 'snapshot-ready', 'target-restoring', 'target-ready')
        ORDER BY requested_at LIMIT 1`,
    )
    .get(appId) as TransferRow | undefined;
}

export function activeOpaqueVolumeAuthorityTransfer(
  applicationId: string,
): VolumeAuthorityTransfer | null {
  const row = activeTransferRow(applicationId);
  return row ? publicTransfer(row) : null;
}

function transferRow(transferId: string): TransferRow | undefined {
  return getSqlite()!
    .prepare('SELECT * FROM volume_authority_transfers WHERE id = ?')
    .get(transferId) as TransferRow | undefined;
}

function publicTransfer(row: TransferRow): VolumeAuthorityTransfer {
  return {
    id: row.id,
    appId: row.app_id,
    sourceSiteId: row.source_site_id,
    targetSiteId: row.target_site_id,
    state: row.state,
    expectedSnapshotId: row.expected_snapshot_id,
    expectedAuthorityEpoch: Number(row.expected_authority_epoch),
    expectedDataSequence: Number(row.expected_data_sequence),
    snapshotId: row.snapshot_id,
    snapshotAuthorityEpoch:
      row.snapshot_authority_epoch === null ? null : Number(row.snapshot_authority_epoch),
    snapshotDataSequence:
      row.snapshot_data_sequence === null ? null : Number(row.snapshot_data_sequence),
    manifestArtifactDigest: row.manifest_artifact_digest,
    requestedBy: row.requested_by,
    sourceResumed: Boolean(row.source_resumed),
    attempts: Number(row.attempts),
    version: Number(row.version),
    error: row.error,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function currentAuthorityBoundary(appId: string): {
  sourceSiteId: string;
  snapshotId: string | null;
  authorityEpoch: number;
  dataSequence: number;
} {
  const latest = latestSnapshot(appId);
  if (latest) {
    return {
      sourceSiteId: latest.authority_site_id,
      snapshotId: latest.id,
      authorityEpoch: Number(latest.authority_epoch),
      dataSequence: Number(latest.data_sequence),
    };
  }
  const writer = getSqlite()!
    .prepare(
      `SELECT site_id FROM app_replicas
        WHERE app_id = ? AND data_mode = 'follows-one-site-writer' AND removed_at IS NULL
        ORDER BY created_at LIMIT 1`,
    )
    .get(appId) as { site_id: string } | undefined;
  return {
    sourceSiteId: writer?.site_id || ensureFleetIdentity().homeSiteId,
    snapshotId: null,
    authorityEpoch: 1,
    dataSequence: 0,
  };
}

function assertBoundary(row: TransferRow): void {
  const boundary = currentAuthorityBoundary(row.app_id);
  if (
    boundary.sourceSiteId !== row.source_site_id ||
    boundary.snapshotId !== row.expected_snapshot_id ||
    boundary.authorityEpoch !== Number(row.expected_authority_epoch) ||
    boundary.dataSequence !== Number(row.expected_data_sequence)
  ) {
    throw new Error('Opaque volume authority CAS changed before the source capture');
  }
}

function casTransferState(
  row: TransferRow,
  from: VolumeAuthorityTransferState[],
  state: VolumeAuthorityTransferState,
): boolean {
  const placeholders = from.map(() => '?').join(', ');
  const result = getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET state = ?, version = version + 1, attempts = attempts + 1,
              error = NULL, updated_at = ?
        WHERE id = ? AND version = ? AND state IN (${placeholders})`,
    )
    .run(state, new Date().toISOString(), row.id, row.version, ...from);
  return result.changes === 1;
}

function appendTransferEvent(
  row: TransferRow,
  operation: string,
  actor: string,
  extra: Record<string, unknown> = {},
  artifactDigests: string[] = [],
  originSiteId = resolveLocalSiteId(),
) {
  return appendLocalFleetEvent({
    originSiteId,
    appId: row.app_id,
    actor,
    operation,
    authorityEpoch: row.snapshot_authority_epoch ?? row.expected_authority_epoch,
    payload: {
      transferId: row.id,
      applicationId: row.app_id,
      sourceSiteId: row.source_site_id,
      targetSiteId: row.target_site_id,
      expectedSnapshotId: row.expected_snapshot_id,
      expectedAuthorityEpoch: row.expected_authority_epoch,
      expectedDataSequence: row.expected_data_sequence,
      ...extra,
    },
    artifactDigests,
  });
}

function ensureRequestedEvent(row: TransferRow): void {
  if (row.request_event_id) return;
  const event = appendTransferEvent(
    row,
    'data.volume.authority.transfer.requested',
    row.requested_by,
    {},
    [],
    ensureFleetIdentity().homeSiteId,
  );
  getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET request_event_id = ?, updated_at = ? WHERE id = ? AND request_event_id IS NULL`,
    )
    .run(event.eventId, event.createdAt, row.id);
}

function ensureSnapshotReadyEvent(row: TransferRow): void {
  const current = transferRow(row.id)!;
  if (current.snapshot_event_id) return;
  if (!current.snapshot_id || !current.manifest_artifact_digest) {
    throw new Error('Snapshot-ready transfer is missing its verified snapshot evidence');
  }
  const manifest = loadPortableVolumeSnapshot(current.snapshot_id);
  const event = appendTransferEvent(
    current,
    'data.volume.authority.transfer.snapshot-ready',
    `system@${current.source_site_id}`,
    {
      snapshotId: manifest.snapshotId,
      authoritySiteId: manifest.authoritySiteId,
      authorityEpoch: manifest.authorityEpoch,
      dataSequence: manifest.dataSequence,
      parentSnapshotId: manifest.parentSnapshotId,
      manifestArtifactDigest: current.manifest_artifact_digest,
      logicalBytes: manifest.logicalBytes,
      uniqueBytes: 0,
    },
    [
      current.manifest_artifact_digest,
      ...manifest.resources.map((resource) => resource.archiveArtifactDigest),
    ],
    current.source_site_id,
  );
  getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET snapshot_event_id = ?, updated_at = ? WHERE id = ? AND snapshot_event_id IS NULL`,
    )
    .run(event.eventId, event.createdAt, current.id);
}

function ensureTargetReadyEvent(row: TransferRow): void {
  const current = transferRow(row.id)!;
  if (current.target_ready_event_id) return;
  const event = appendTransferEvent(
    current,
    'data.volume.authority.transfer.target-ready',
    `system@${current.target_site_id}`,
    {
      snapshotId: current.snapshot_id,
      snapshotAuthorityEpoch: current.snapshot_authority_epoch,
      snapshotDataSequence: current.snapshot_data_sequence,
      verification: 'restored-health-checked-and-quiesced',
    },
    [],
    current.target_site_id,
  );
  getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET target_ready_event_id = ?, updated_at = ?
        WHERE id = ? AND target_ready_event_id IS NULL`,
    )
    .run(event.eventId, event.createdAt, current.id);
}

function ensureCommittedEvent(row: TransferRow): void {
  const current = transferRow(row.id)!;
  if (current.commit_event_id) return;
  if (!current.snapshot_id || !current.manifest_artifact_digest) {
    throw new Error('Committed transfer is missing its adopted snapshot');
  }
  const manifest = loadPortableVolumeSnapshot(current.snapshot_id);
  const event = appendTransferEvent(
    current,
    'data.volume.authority.transfer.committed',
    current.requested_by,
    {
      snapshotId: manifest.snapshotId,
      previousSnapshotId: manifest.parentSnapshotId,
      authoritySiteId: manifest.authoritySiteId,
      authorityEpoch: manifest.authorityEpoch,
      dataSequence: manifest.dataSequence,
      manifestArtifactDigest: current.manifest_artifact_digest,
      logicalBytes: manifest.logicalBytes,
      uniqueBytes: 0,
    },
    [
      current.manifest_artifact_digest,
      ...manifest.resources.map((resource) => resource.archiveArtifactDigest),
    ],
    ensureFleetIdentity().homeSiteId,
  );
  getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET commit_event_id = ?, updated_at = ? WHERE id = ? AND commit_event_id IS NULL`,
    )
    .run(event.eventId, event.createdAt, current.id);
}

async function captureTransferSource(
  row: TransferRow,
  executor: OpaqueVolumeExecutor,
  contextResolver: (applicationId: string, siteId: string) => GraphExecutorContext,
): Promise<void> {
  try {
    const latest = latestSnapshot(row.app_id);
    let snapshot: OpaqueVolumeSnapshot;
    if (
      latest &&
      latest.authority_site_id === row.source_site_id &&
      Number(latest.authority_epoch) === row.expected_authority_epoch &&
      Number(latest.data_sequence) === row.expected_data_sequence + 1 &&
      loadPortableVolumeSnapshot(latest.id).parentSnapshotId === row.expected_snapshot_id
    ) {
      await executor.stop({ applicationId: row.app_id, siteId: row.source_site_id });
      const manifest = loadPortableVolumeSnapshot(latest.id);
      snapshot = {
        id: manifest.snapshotId,
        manifestArtifactDigest: latest.manifest_artifact_digest as `sha256:${string}`,
        archiveArtifactDigests: manifest.resources.map(
          (resource) => resource.archiveArtifactDigest,
        ),
        authoritySiteId: manifest.authoritySiteId,
        authorityEpoch: manifest.authorityEpoch,
        dataSequence: manifest.dataSequence,
        parentSnapshotId: manifest.parentSnapshotId,
        logicalBytes: manifest.logicalBytes,
        uniqueBytes: 0,
      };
    } else {
      assertBoundary(row);
      snapshot = await captureOpaqueVolumeSnapshot({
        applicationId: row.app_id,
        context: contextResolver(row.app_id, row.source_site_id),
        executor,
        actor: `system@${row.source_site_id}`,
        resume: false,
        transferId: row.id,
      });
    }
    const now = new Date().toISOString();
    const result = getSqlite()!
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = 'snapshot-ready', snapshot_id = ?, snapshot_authority_epoch = ?,
                snapshot_data_sequence = ?, manifest_artifact_digest = ?, error = NULL,
                version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'source-capturing' AND version = ?`,
      )
      .run(
        snapshot.id,
        snapshot.authorityEpoch,
        snapshot.dataSequence,
        snapshot.manifestArtifactDigest,
        now,
        row.id,
        row.version,
      );
    if (result.changes !== 1) throw new Error('Authority transfer changed during source capture');
    ensureSnapshotReadyEvent(transferRow(row.id)!);
  } catch (error) {
    let sourceResumed = false;
    try {
      await executor.converge({
        ...contextResolver(row.app_id, row.source_site_id),
        writerSiteId: row.source_site_id,
      });
      sourceResumed = true;
    } catch {
      // The failed state remains explicit and the restart worker keeps
      // retrying source convergence until it can prove authority is serving.
    }
    failTransfer(row.id, error, sourceResumed, row.source_site_id);
  }
}

async function restoreTransferTarget(
  row: TransferRow,
  executor: OpaqueVolumeExecutor,
  contextResolver: (applicationId: string, siteId: string) => GraphExecutorContext,
): Promise<void> {
  try {
    if (!row.snapshot_id) throw new Error('Target restore is missing the source snapshot');
    const context = contextResolver(row.app_id, row.target_site_id);
    await restoreOpaqueVolumeSnapshot({
      applicationId: row.app_id,
      snapshotId: row.snapshot_id,
      context,
      executor,
    });
    await executor.converge({ ...context, writerSiteId: row.target_site_id });
    // Health has been proven, but production writes cannot begin before Home
    // commits the new authority epoch. Keep the provisional target cold.
    await executor.stop(context);
    const now = new Date().toISOString();
    const result = getSqlite()!
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = 'target-ready', error = NULL, version = version + 1, updated_at = ?
          WHERE id = ? AND state = 'target-restoring' AND version = ?`,
      )
      .run(now, row.id, row.version);
    if (result.changes !== 1) throw new Error('Authority transfer changed during target restore');
    ensureTargetReadyEvent(transferRow(row.id)!);
  } catch (error) {
    await executor.stop({ applicationId: row.app_id, siteId: row.target_site_id }).catch(() => {});
    failTransfer(row.id, error, false, row.target_site_id);
  }
}

function commitTransferAuthority(row: TransferRow): void {
  const current = transferRow(row.id)!;
  if (current.state === 'committed') return;
  if (current.state !== 'target-ready' || !current.snapshot_id) return;
  try {
    assertApplicationSuitcaseDataMode(current.app_id, 'follows-one-site');
  } catch (error) {
    failTransfer(current.id, error, false);
    return;
  }
  const source = loadPortableVolumeSnapshot(current.snapshot_id);
  const latest = latestSnapshot(current.app_id);
  if (
    !latest ||
    latest.id !== source.snapshotId ||
    latest.authority_site_id !== current.source_site_id ||
    Number(latest.authority_epoch) !== current.snapshot_authority_epoch ||
    Number(latest.data_sequence) !== current.snapshot_data_sequence
  ) {
    failTransfer(current.id, new Error('Opaque volume authority CAS changed before commit'), false);
    return;
  }
  const adopted: PortableVolumeSnapshotManifest = {
    ...source,
    snapshotId: sortableId('volume'),
    authoritySiteId: current.target_site_id,
    authorityEpoch: source.authorityEpoch + 1,
    dataSequence: source.dataSequence + 1,
    parentSnapshotId: source.snapshotId,
    createdAt: new Date().toISOString(),
  };
  const manifestArtifact = putArtifactBytes(Buffer.from(canonical(adopted)), {
    type: 'opaque-volume-manifest',
    mediaType: 'application/vnd.deploy.opaque-volume-snapshot+json',
    retentionClass: 'recovery',
  });
  const sqlite = getSqlite()!;
  const commit = sqlite.transaction(() => {
    const check = latestSnapshot(current.app_id);
    if (!check || check.id !== source.snapshotId) {
      throw new Error('Opaque volume authority CAS changed while committing');
    }
    recordVerifiedSnapshot(adopted, manifestArtifact.digest, 0, { latestHomeRecovery: true });
    const now = new Date().toISOString();
    const updated = sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = 'committed', snapshot_id = ?, snapshot_authority_epoch = ?,
                snapshot_data_sequence = ?, manifest_artifact_digest = ?, error = NULL,
                source_resumed = 0, version = version + 1, updated_at = ?, completed_at = ?
          WHERE id = ? AND state = 'target-ready' AND version = ?`,
      )
      .run(
        adopted.snapshotId,
        adopted.authorityEpoch,
        adopted.dataSequence,
        manifestArtifact.digest,
        now,
        now,
        current.id,
        current.version,
      );
    if (updated.changes !== 1) throw new Error('Authority transfer changed while committing');
    sqlite
      .prepare(
        "UPDATE deployments SET data_mode = 'follows-one-site', updated_at = ? WHERE app_id = ?",
      )
      .run(now, current.app_id);
    sqlite
      .prepare(
        `UPDATE app_replicas
            SET data_mode = CASE WHEN site_id = ? THEN 'follows-one-site-writer'
                                 ELSE 'follows-one-site-recovery' END,
                runtime_status = CASE WHEN site_id = ? THEN 'pending' ELSE 'recovery-only' END,
                updated_at = ?
          WHERE app_id = ? AND removed_at IS NULL`,
      )
      .run(current.target_site_id, current.target_site_id, now, current.app_id);
  });
  try {
    commit.immediate();
    ensureCommittedEvent(transferRow(current.id)!);
  } catch (error) {
    failTransfer(current.id, error, false);
  }
}

function failTransfer(
  transferId: string,
  error: unknown,
  sourceResumed: boolean,
  eventSiteId?: string,
): void {
  const row = transferRow(transferId);
  if (!row || row.state === 'committed' || row.state === 'aborted') return;
  const message = error instanceof Error ? error.message : String(error);
  const now = new Date().toISOString();
  const result = getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET state = 'failed', error = ?, source_resumed = ?, version = version + 1,
              updated_at = ?, completed_at = ?
        WHERE id = ? AND state != 'committed'`,
    )
    .run(message, sourceResumed ? 1 : 0, now, now, row.id);
  if (result.changes === 0) return;
  const failed = transferRow(row.id)!;
  const event = appendTransferEvent(
    failed,
    'data.volume.authority.transfer.failed',
    `system@${eventSiteId || resolveLocalSiteId()}`,
    { error: message, sourceResumed },
    [],
    eventSiteId || resolveLocalSiteId(),
  );
  getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET terminal_event_id = ?, updated_at = ? WHERE id = ?`,
    )
    .run(event.eventId, event.createdAt, row.id);
}

async function resumeTransferSource(
  row: TransferRow,
  executor: OpaqueVolumeExecutor,
  contextResolver: (applicationId: string, siteId: string) => GraphExecutorContext,
): Promise<void> {
  await executor.converge({
    ...contextResolver(row.app_id, row.source_site_id),
    writerSiteId: row.source_site_id,
  });
  const now = new Date().toISOString();
  const result = getSqlite()!
    .prepare(
      `UPDATE volume_authority_transfers
          SET source_resumed = 1, version = version + 1, updated_at = ?
        WHERE id = ? AND source_resumed = 0 AND state IN ('failed', 'aborted')`,
    )
    .run(now, row.id);
  if (result.changes === 0) return;
  appendTransferEvent(
    transferRow(row.id)!,
    'data.volume.authority.transfer.source-resumed',
    `system@${row.source_site_id}`,
    { resumedAt: now },
    [],
    row.source_site_id,
  );
}

function setTransferError(transferId: string, message: string): void {
  getSqlite()!
    .prepare('UPDATE volume_authority_transfers SET error = ?, updated_at = ? WHERE id = ?')
    .run(message, new Date().toISOString(), transferId);
}

function updateTransferMaterialization(
  row: TransferRow,
  state: 'ready' | 'blocked',
  blockers: string[],
): void {
  updateMaterialization({
    appId: row.app_id,
    siteId: row.target_site_id,
    capability: 'data',
    desiredDigest: row.snapshot_id || undefined,
    availableDigest: state === 'ready' ? row.snapshot_id || undefined : undefined,
    state,
    blockers,
    evidence: [{ transferId: row.id, authorityEpoch: row.snapshot_authority_epoch }],
  });
}

export function resolveOpaqueVolumeGraphContext(
  applicationId: string,
  siteId: string,
): GraphExecutorContext {
  const row = getSqlite()!
    .prepare(
      `SELECT d.name, d.active_spec_digest, d.desired_spec_digest, d.directory,
              d.memory_limit, d.cpu_limit
         FROM deployments d JOIN app_replicas r ON r.app_id = d.app_id
        WHERE d.app_id = ? AND r.site_id = ? AND r.removed_at IS NULL`,
    )
    .get(applicationId, siteId) as
    | {
        name: string;
        active_spec_digest: string | null;
        desired_spec_digest: string | null;
        directory: string | null;
        memory_limit: string | null;
        cpu_limit: string | null;
      }
    | undefined;
  if (!row) throw new Error('Local Follows one site application replica not found');
  const specDigest = row.active_spec_digest || row.desired_spec_digest;
  const revision = specDigest ? getApplicationSpecRevision(row.name, specDigest) : undefined;
  if (!revision) throw new Error('Local writer replica has no active immutable graph');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const configuration = resolveApplicationConfiguration({
    deploymentName: row.name,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId,
  });
  if (!configuration.ready) {
    throw new Error(`Local writer configuration is missing: ${configuration.missing.join(', ')}`);
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId,
    specDigest: revision.digest,
    spec,
    configuration,
  });
  if (!runtime.ready) {
    throw new Error(
      runtime.execution.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message)
        .join('; ') || 'Local writer graph is not admissible',
    );
  }
  return {
    deploymentName: row.name,
    applicationId,
    siteId,
    nodeId: 'coordinator',
    projectDirectory: row.directory || process.cwd(),
    runtime,
    memoryLimit: row.memory_limit || '4g',
    cpuLimit: row.cpu_limit || undefined,
    writerSiteId: siteId,
  };
}

/** Apply an authenticated snapshot event after all referenced artifacts arrived. */
export function projectOpaqueVolumeSnapshotEvent(
  event: {
    appId: string | null;
    payload: Record<string, unknown>;
    artifactDigests: string[];
  },
  options: { allowDetachedParent?: boolean } = {},
): void {
  if (!event.appId) throw new Error('Opaque volume snapshot event requires an application id');
  const digest = requiredDigest(event.payload.manifestArtifactDigest, 'manifestArtifactDigest');
  if (!event.artifactDigests.includes(digest))
    throw new Error('Opaque volume event does not authenticate its manifest artifact');
  const manifest = loadPortableManifest(digest);
  if (manifest.applicationId !== event.appId)
    throw new Error('Opaque volume event application does not match its manifest');
  if (
    event.payload.snapshotId !== manifest.snapshotId ||
    event.payload.authoritySiteId !== manifest.authoritySiteId ||
    Number(event.payload.authorityEpoch) !== manifest.authorityEpoch ||
    Number(event.payload.dataSequence) !== manifest.dataSequence
  ) {
    throw new Error('Opaque volume event metadata does not match its immutable manifest');
  }
  for (const resource of manifest.resources) {
    if (!event.artifactDigests.includes(resource.archiveArtifactDigest))
      throw new Error('Opaque volume event does not authenticate every archive artifact');
    if (!getArtifact(resource.archiveArtifactDigest))
      throw new Error(`Opaque volume archive ${resource.archiveArtifactDigest} is missing`);
  }
  recordVerifiedSnapshot(manifest, digest, Number(event.payload.uniqueBytes || 0), {
    latestHomeRecovery: true,
    allowDetachedParent: options.allowDetachedParent,
  });
}

/** Project one authenticated distributed handoff event into the local durable state machine. */
export function projectOpaqueVolumeAuthorityTransferEvent(event: {
  id: string;
  appId: string | null;
  operation: string;
  actor: string;
  createdAt: string;
  payload: Record<string, unknown>;
  artifactDigests: string[];
}): void {
  if (!event.appId) throw new Error('Opaque volume authority event requires an application id');
  if (
    event.operation !== 'data.volume.authority.transfer.failed' &&
    event.operation !== 'data.volume.authority.transfer.aborted'
  ) {
    assertApplicationSuitcaseDataMode(event.appId, 'follows-one-site');
  }
  const transferId = requiredText(event.payload.transferId, 'transferId');
  const sourceSiteId = requiredText(event.payload.sourceSiteId, 'sourceSiteId');
  const targetSiteId = requiredText(event.payload.targetSiteId, 'targetSiteId');
  const expectedSnapshotId = optionalText(event.payload.expectedSnapshotId);
  const expectedAuthorityEpoch = requiredInteger(
    event.payload.expectedAuthorityEpoch,
    'expectedAuthorityEpoch',
  );
  const expectedDataSequence = requiredInteger(
    event.payload.expectedDataSequence,
    'expectedDataSequence',
  );
  const sqlite = getSqlite()!;
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO volume_authority_transfers
        (id, app_id, source_site_id, target_site_id, state, expected_snapshot_id,
         expected_authority_epoch, expected_data_sequence, requested_by,
         request_event_id, requested_at, updated_at)
       VALUES (?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      transferId,
      event.appId,
      sourceSiteId,
      targetSiteId,
      expectedSnapshotId,
      expectedAuthorityEpoch,
      expectedDataSequence,
      event.actor,
      event.operation.endsWith('.requested') ? event.id : null,
      event.createdAt,
      event.createdAt,
    );
  const row = transferRow(transferId)!;
  if (
    row.app_id !== event.appId ||
    row.source_site_id !== sourceSiteId ||
    row.target_site_id !== targetSiteId ||
    row.expected_snapshot_id !== expectedSnapshotId ||
    Number(row.expected_authority_epoch) !== expectedAuthorityEpoch ||
    Number(row.expected_data_sequence) !== expectedDataSequence
  ) {
    throw new Error('Opaque volume authority event conflicts with its durable CAS request');
  }

  if (event.operation === 'data.volume.authority.transfer.requested') {
    sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET request_event_id = COALESCE(request_event_id, ?), updated_at = ? WHERE id = ?`,
      )
      .run(event.id, event.createdAt, transferId);
    return;
  }
  if (event.operation === 'data.volume.authority.transfer.snapshot-ready') {
    projectOpaqueVolumeSnapshotEvent(event, { allowDetachedParent: true });
    const snapshotId = requiredText(event.payload.snapshotId, 'snapshotId');
    const epoch = requiredInteger(event.payload.authorityEpoch, 'authorityEpoch');
    const sequence = requiredInteger(event.payload.dataSequence, 'dataSequence');
    if (
      String(event.payload.authoritySiteId) !== sourceSiteId ||
      epoch !== expectedAuthorityEpoch ||
      sequence !== expectedDataSequence + 1
    ) {
      throw new Error('Snapshot-ready event does not fast-forward the requested source boundary');
    }
    sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = CASE WHEN state IN ('requested', 'source-capturing')
                             THEN 'snapshot-ready' ELSE state END,
                snapshot_id = ?, snapshot_authority_epoch = ?, snapshot_data_sequence = ?,
                manifest_artifact_digest = ?, snapshot_event_id = COALESCE(snapshot_event_id, ?),
                version = version + 1, updated_at = ?
          WHERE id = ? AND state NOT IN ('committed', 'failed', 'aborted')`,
      )
      .run(
        snapshotId,
        epoch,
        sequence,
        requiredDigest(event.payload.manifestArtifactDigest, 'manifestArtifactDigest'),
        event.id,
        event.createdAt,
        transferId,
      );
    return;
  }
  if (event.operation === 'data.volume.authority.transfer.target-ready') {
    if (
      row.snapshot_id !== requiredText(event.payload.snapshotId, 'snapshotId') ||
      Number(row.snapshot_authority_epoch) !==
        requiredInteger(event.payload.snapshotAuthorityEpoch, 'snapshotAuthorityEpoch') ||
      Number(row.snapshot_data_sequence) !==
        requiredInteger(event.payload.snapshotDataSequence, 'snapshotDataSequence')
    ) {
      throw new Error('Target-ready event does not match the verified source snapshot');
    }
    sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = CASE WHEN state IN ('snapshot-ready', 'target-restoring')
                             THEN 'target-ready' ELSE state END,
                target_ready_event_id = COALESCE(target_ready_event_id, ?),
                version = version + 1, updated_at = ?
          WHERE id = ? AND state NOT IN ('committed', 'failed', 'aborted')`,
      )
      .run(event.id, event.createdAt, transferId);
    return;
  }
  if (event.operation === 'data.volume.authority.transfer.committed') {
    projectOpaqueVolumeSnapshotEvent(event);
    const authoritySiteId = requiredText(event.payload.authoritySiteId, 'authoritySiteId');
    const epoch = requiredInteger(event.payload.authorityEpoch, 'authorityEpoch');
    const sequence = requiredInteger(event.payload.dataSequence, 'dataSequence');
    if (
      authoritySiteId !== targetSiteId ||
      epoch !== Number(row.snapshot_authority_epoch) + 1 ||
      sequence !== Number(row.snapshot_data_sequence) + 1
    ) {
      throw new Error('Committed authority event does not advance the target epoch and sequence');
    }
    const now = event.createdAt;
    const apply = sqlite.transaction(() => {
      sqlite
        .prepare(
          `UPDATE volume_authority_transfers
              SET state = 'committed', snapshot_id = ?, snapshot_authority_epoch = ?,
                  snapshot_data_sequence = ?, manifest_artifact_digest = ?, commit_event_id = ?,
                  source_resumed = 0, version = version + 1, error = NULL,
                  updated_at = ?, completed_at = ?
            WHERE id = ? AND state NOT IN ('failed', 'aborted')`,
        )
        .run(
          requiredText(event.payload.snapshotId, 'snapshotId'),
          epoch,
          sequence,
          requiredDigest(event.payload.manifestArtifactDigest, 'manifestArtifactDigest'),
          event.id,
          now,
          now,
          transferId,
        );
      sqlite
        .prepare(
          "UPDATE deployments SET data_mode = 'follows-one-site', updated_at = ? WHERE app_id = ?",
        )
        .run(now, event.appId);
      sqlite
        .prepare(
          `UPDATE app_replicas
              SET data_mode = CASE WHEN site_id = ? THEN 'follows-one-site-writer'
                                   ELSE 'follows-one-site-recovery' END,
                  runtime_status = CASE WHEN site_id = ? THEN 'pending' ELSE 'recovery-only' END,
                  updated_at = ?
            WHERE app_id = ? AND removed_at IS NULL`,
        )
        .run(targetSiteId, targetSiteId, now, event.appId);
    });
    apply.immediate();
    return;
  }
  if (
    event.operation === 'data.volume.authority.transfer.failed' ||
    event.operation === 'data.volume.authority.transfer.aborted'
  ) {
    const state = event.operation.endsWith('.failed') ? 'failed' : 'aborted';
    sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET state = ?, error = ?, source_resumed = ?, terminal_event_id = ?,
                version = version + 1, updated_at = ?, completed_at = ?
          WHERE id = ? AND state != 'committed'`,
      )
      .run(
        state,
        optionalText(event.payload.error) || optionalText(event.payload.reason),
        event.payload.sourceResumed === true ? 1 : 0,
        event.id,
        event.createdAt,
        event.createdAt,
        transferId,
      );
    return;
  }
  if (event.operation === 'data.volume.authority.transfer.source-resumed') {
    sqlite
      .prepare(
        `UPDATE volume_authority_transfers
            SET source_resumed = 1, version = version + 1, updated_at = ?
          WHERE id = ? AND state IN ('failed', 'aborted')`,
      )
      .run(event.createdAt, transferId);
    return;
  }
  throw new Error(`Unsupported opaque volume authority event ${event.operation}`);
}

export function loadPortableVolumeSnapshot(snapshotId: string): PortableVolumeSnapshotManifest {
  const row = getSqlite()!
    .prepare(
      "SELECT manifest_artifact_digest FROM volume_snapshots WHERE id = ? AND verification_status = 'verified'",
    )
    .get(snapshotId) as { manifest_artifact_digest: string } | undefined;
  if (!row) throw new Error('Verified opaque volume snapshot not found');
  return loadPortableManifest(row.manifest_artifact_digest);
}

function latestSnapshot(appId: string): SnapshotRow | undefined {
  return getSqlite()!
    .prepare(
      `SELECT id, authority_site_id, authority_epoch, data_sequence, manifest_artifact_digest
         FROM volume_snapshots WHERE app_id = ? AND verification_status = 'verified'
        ORDER BY authority_epoch DESC, data_sequence DESC LIMIT 1`,
    )
    .get(appId) as SnapshotRow | undefined;
}

function recordVerifiedSnapshot(
  manifest: PortableVolumeSnapshotManifest,
  manifestDigest: string,
  uniqueBytes: number,
  options: { latestHomeRecovery: boolean; allowDetachedParent?: boolean },
): void {
  const sqlite = getSqlite()!;
  const record = sqlite.transaction(() => {
    const previous = latestSnapshot(manifest.applicationId);
    if (previous) {
      const monotonic =
        manifest.authorityEpoch > previous.authority_epoch ||
        (manifest.authorityEpoch === previous.authority_epoch &&
          manifest.dataSequence > previous.data_sequence);
      if (!monotonic && previous.id !== manifest.snapshotId) {
        throw new Error('Opaque volume snapshot does not advance authority epoch/data sequence');
      }
      if (manifest.parentSnapshotId !== previous.id && previous.id !== manifest.snapshotId) {
        throw new Error('Opaque volume snapshot is not a fast-forward of the retained lineage');
      }
    } else if (manifest.parentSnapshotId && !options.allowDetachedParent) {
      throw new Error('Opaque volume snapshot parent is unavailable');
    }
    if (options.latestHomeRecovery) {
      sqlite
        .prepare('UPDATE volume_snapshots SET latest_home_recovery = 0 WHERE app_id = ?')
        .run(manifest.applicationId);
    }
    sqlite
      .prepare(
        `INSERT INTO volume_snapshots
          (id, app_id, authority_site_id, authority_epoch, data_sequence,
           parent_snapshot_id, manifest_artifact_digest, consistency_mode,
           logical_bytes, unique_bytes, verification_status, release_generation,
           retention_class, latest_home_recovery, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified',
                 (SELECT release_generation FROM deployments WHERE app_id = ?),
                 'recovery', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           verification_status = CASE
             WHEN manifest_artifact_digest = excluded.manifest_artifact_digest THEN 'verified'
             ELSE 'quarantined'
           END,
           latest_home_recovery = MAX(latest_home_recovery, excluded.latest_home_recovery)`,
      )
      .run(
        manifest.snapshotId,
        manifest.applicationId,
        manifest.authoritySiteId,
        manifest.authorityEpoch,
        manifest.dataSequence,
        manifest.parentSnapshotId,
        manifestDigest,
        manifest.consistencyMode,
        manifest.logicalBytes,
        uniqueBytes,
        manifest.applicationId,
        options.latestHomeRecovery ? 1 : 0,
        manifest.createdAt,
      );
  });
  record.immediate();
}

function parseColdManifest(
  recovery: GraphRecoveryArtifact,
  context: GraphExecutorContext,
): ColdRecoveryManifest {
  const content = readFileSync(recovery.artifactReference);
  if (digestBytes(content) !== recovery.artifactDigest)
    throw new Error('Cold volume manifest changed after graph capture');
  const parsed = JSON.parse(content.toString('utf8')) as Partial<ColdRecoveryManifest>;
  if (
    parsed.version !== 1 ||
    parsed.applicationId !== context.applicationId ||
    parsed.siteId !== context.siteId ||
    parsed.specDigest !== context.runtime.execution.specDigest ||
    parsed.configurationDigest !== context.runtime.configurationDigest ||
    !Array.isArray(parsed.resources)
  ) {
    throw new Error('Cold volume manifest does not match the capturing graph');
  }
  const resources = parsed.resources.map((resource) => {
    if (
      !resource ||
      typeof resource.resource !== 'string' ||
      typeof resource.archive !== 'string' ||
      typeof resource.digest !== 'string' ||
      !DIGEST.test(resource.digest) ||
      !Number.isSafeInteger(resource.bytes) ||
      Number(resource.bytes) < 0
    ) {
      throw new Error('Cold volume manifest resource is invalid');
    }
    return resource as ColdRecoveryManifest['resources'][number];
  });
  if (new Set(resources.map((resource) => resource.resource)).size !== resources.length)
    throw new Error('Cold volume manifest contains duplicate resources');
  return { ...(parsed as ColdRecoveryManifest), resources };
}

function loadPortableManifest(digest: string): PortableVolumeSnapshotManifest {
  const artifact = getArtifact(digest);
  if (!artifact || fileDigest(artifact.localPath) !== digest)
    throw new Error(`Opaque volume manifest ${digest} is unavailable or corrupt`);
  const value = JSON.parse(
    readFileSync(artifact.localPath, 'utf8'),
  ) as Partial<PortableVolumeSnapshotManifest>;
  if (
    value.kind !== 'deploy.local/opaque-volume-snapshot' ||
    value.version !== 1 ||
    typeof value.snapshotId !== 'string' ||
    typeof value.applicationId !== 'string' ||
    typeof value.authoritySiteId !== 'string' ||
    !Number.isSafeInteger(value.authorityEpoch) ||
    Number(value.authorityEpoch) < 1 ||
    !Number.isSafeInteger(value.dataSequence) ||
    Number(value.dataSequence) < 1 ||
    (value.parentSnapshotId !== null && typeof value.parentSnapshotId !== 'string') ||
    typeof value.specDigest !== 'string' ||
    typeof value.configurationDigest !== 'string' ||
    value.consistencyMode !== 'cold-quiesced' ||
    !Array.isArray(value.resources) ||
    !Number.isSafeInteger(value.logicalBytes) ||
    Number(value.logicalBytes) < 0 ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Opaque volume manifest is invalid');
  }
  for (const resource of value.resources) {
    if (
      !resource ||
      typeof resource.resource !== 'string' ||
      typeof resource.archiveArtifactDigest !== 'string' ||
      !DIGEST.test(resource.archiveArtifactDigest) ||
      !Number.isSafeInteger(resource.bytes) ||
      Number(resource.bytes) < 0
    )
      throw new Error('Opaque volume manifest resource is invalid');
  }
  return value as PortableVolumeSnapshotManifest;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function requiredInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid`);
  return number;
}

function containedPath(root: string, child: string): string {
  const base = resolve(root);
  const path = resolve(base, child);
  if (path !== base && !path.startsWith(`${base}${sep}`))
    throw new Error('Opaque volume archive escapes its capture root');
  return path;
}

function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Unsafe opaque volume identifier');
  return safe;
}

function digestBytes(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function fileDigest(path: string): `sha256:${string}` {
  return digestBytes(readFileSync(path));
}
