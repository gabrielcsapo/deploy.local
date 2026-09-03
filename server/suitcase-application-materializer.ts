import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { SuitcaseMembership } from '../lib/suitcase-sync-client.ts';
import {
  resolveApplicationConfiguration,
  setDeclaredConfigurationValue,
} from './application-configuration.ts';
import { assertSuitcaseDataModeAllowedBySpec } from './application-data-contract.ts';
import {
  ApplicationGraphExecutor,
  offlineBuildProofInputDigest,
  type GraphExecutorContext,
  type GraphOfflineBuildProof,
  type GraphRecoveryArtifact,
} from './application-graph-executor.ts';
import { applicationWriterSiteId } from './application-authority.ts';
import {
  buildApplicationGraphRuntime,
  type ResolvedApplicationGraphRuntime,
} from './application-runtime.ts';
import { parseStoredApplicationSpec, type ApplicationSpec } from './application-spec.ts';
import { getArtifact, verifyArtifact } from './content-store.ts';
import { deployDataPath } from './data-directory.ts';
import {
  evaluateReplicaReadiness,
  updateMaterialization,
  type MaterializationUpdate,
} from './fleet-release.ts';
import { PORTABILITY_ANALYZER_VERSION } from './portability.ts';
import { appendLocalFleetEvent } from './multisite.ts';
import { currentSuitcaseClientAccess } from './suitcase-access-readiness.ts';
import {
  completeReplicaDataPolicyTransition,
  failReplicaDataPolicyTransition,
  recordReplicaDataPolicyTransitionBackup,
  recordReplicaDataPolicyTransitionPrepared,
  type PolicyTransitionBackupEvidence,
} from './data-policy-transitions.ts';
import {
  getApplicationSpecRevision,
  getSqlite,
  recordMaterializedApplicationRuntime,
  retainApplicationRevisionArtifact,
  updateDeploymentStatus,
} from './store.ts';
import { inspectUploadArchive } from './upload-archive.ts';
import {
  captureSuitcaseDataBranch,
  createInitialSuitcaseCheckpoint,
  restoreSuitcaseCheckpoint,
} from './suitcase-data-bridge.ts';
import {
  activeOpaqueVolumeAuthorityTransfer,
  captureOpaqueVolumeSnapshot,
  restoreOpaqueVolumeSnapshot,
} from './volume-sync.ts';

const execFileAsync = promisify(execFile);

interface SelectedReplica {
  appId: string;
  siteId: string;
  deploymentName: string;
  desiredSpecDigest: string | null;
  activeSpecDigest: string | null;
  desiredReleaseDigest: string | null;
  sourceArtifactDigest: string | null;
  syncPolicy: 'automatic' | 'manual' | 'none';
  dataMode: string;
  baseCheckpointId: string | null;
  profileVersion: string | null;
  releaseGeneration: number;
  memoryLimit: string | null;
  cpuLimit: string | null;
}

function suitcaseContractMode(
  dataMode: string,
): 'syncs-across-sites' | 'follows-one-site' | 'site-local' | null {
  if (dataMode === 'replicated') return 'syncs-across-sites';
  if (dataMode.startsWith('follows-one-site')) return 'follows-one-site';
  if (dataMode === 'site-local' || dataMode === 'single-site') return 'site-local';
  return null;
}

export interface SuitcaseApplicationMaterializationResult {
  appId: string;
  deploymentName: string;
  status: 'ready' | 'blocked' | 'failed';
  specDigest: string | null;
  activeSpecDigest: string | null;
  blockers: string[];
}

type SuitcaseExecutor = Pick<
  ApplicationGraphExecutor,
  'converge' | 'createRecoveryPoint' | 'restoreRecoveryPoint' | 'remove'
> &
  Partial<Pick<ApplicationGraphExecutor, 'proveOfflineBuild'>>;

export interface SuitcaseApplicationMaterializerOptions {
  executor?: SuitcaseExecutor;
  /** Proves the local control surface is listening; inject a host-level probe in tests/appliances. */
  accessProbe?: () => Promise<{ ready: boolean; evidence: string }>;
  healthTimeoutMs?: number;
  drainTimeoutMs?: number;
}

export interface SuitcaseBranchCaptureOptions {
  executor?: SuitcaseExecutor;
  explicitManual?: boolean;
  /** Limit an explicit control request to its selected application. */
  applicationIds?: ReadonlySet<string>;
}

/**
 * Turn authenticated, projected fleet intent into a physical graph on the local Suitcase.
 * Desired and active remain distinct: a failed rollout leaves the prior active digest and endpoint
 * generation untouched, while materialization records explain why the desired digest is blocked.
 */
export async function reconcileSuitcaseApplications(
  membership: Pick<
    SuitcaseMembership,
    'siteId' | 'credential' | 'publicKey' | 'accessMode' | 'mode'
  >,
  options: SuitcaseApplicationMaterializerOptions = {},
): Promise<SuitcaseApplicationMaterializationResult[]> {
  const executor = options.executor ?? new ApplicationGraphExecutor();
  const access = await (
    options.accessProbe ?? (() => probeLocalControlSurface(membership.siteId))
  )();
  await materializeCatalogRecoveryRequests(membership, executor);
  await materializeCatalogRemovals(membership, executor);
  await materializeDataPolicyTransitionRequests(membership, executor);
  const replicas = selectedReplicas(membership.siteId);
  const results: SuitcaseApplicationMaterializationResult[] = [];

  for (const replica of replicas) {
    const result = await reconcileReplica(
      replica,
      membership,
      executor,
      access,
      options.healthTimeoutMs,
      options.drainTimeoutMs,
    );
    results.push(result);
    emitCatalogOperationCompletion(replica, result);
  }
  return results;
}

/** Capture changed automatic branches (or explicit manual branches) before transport upload. */
export async function captureSuitcaseApplicationBranches(
  membership: Pick<SuitcaseMembership, 'siteId' | 'mode'>,
  options: SuitcaseBranchCaptureOptions = {},
) {
  const executor = options.executor ?? new ApplicationGraphExecutor();
  const results: Array<{
    appId: string;
    deploymentName: string;
    status: 'unchanged' | 'pending' | 'captured' | 'blocked';
    changesetId?: string;
    blockers?: string[];
  }> = [];
  for (const replica of selectedReplicas(membership.siteId)) {
    if (options.applicationIds && !options.applicationIds.has(replica.appId)) continue;
    if (replica.dataMode === 'follows-one-site-recovery') continue;
    if (replica.dataMode === 'follows-one-site-writer') {
      if (replica.syncPolicy === 'manual' && !options.explicitManual) continue;
      if (
        !options.explicitManual &&
        membership.mode !== 'rejoining' &&
        !opaqueCaptureDue(replica.appId, replica.siteId)
      )
        continue;
      try {
        const prepared = prepareReplicaGraph(replica);
        const projectDirectoryPath = await materializeProjectDirectory(
          replica,
          prepared.spec,
          prepared.revisionDigest,
        );
        const captured = await captureOpaqueVolumeSnapshot({
          applicationId: replica.appId,
          context: graphContext(replica, prepared.runtime, projectDirectoryPath),
          executor,
          actor: `system@${replica.siteId}`,
        });
        results.push({
          appId: replica.appId,
          deploymentName: replica.deploymentName,
          status: 'captured',
          changesetId: captured.id,
        });
      } catch (error) {
        results.push({
          appId: replica.appId,
          deploymentName: replica.deploymentName,
          status: 'blocked',
          blockers: [error instanceof Error ? error.message : String(error)],
        });
      }
      continue;
    }
    if (replica.syncPolicy === 'none') continue;
    if (replica.syncPolicy === 'manual' && !options.explicitManual) continue;
    if (!replica.baseCheckpointId || !replica.desiredSpecDigest) {
      results.push({
        appId: replica.appId,
        deploymentName: replica.deploymentName,
        status: 'blocked',
        blockers: ['shared branch capture requires a base checkpoint and desired revision'],
      });
      continue;
    }
    try {
      const prepared = prepareReplicaGraph(replica);
      const projectDirectoryPath = await materializeProjectDirectory(
        replica,
        prepared.spec,
        prepared.revisionDigest,
      );
      const context = graphContext(replica, prepared.runtime, projectDirectoryPath, undefined);
      const captured = await captureSuitcaseDataBranch({
        applicationId: replica.appId,
        siteId: replica.siteId,
        baseCheckpointId: replica.baseCheckpointId,
        profileVersion: replica.profileVersion,
        context,
        executor,
        explicitManual: options.explicitManual,
      });
      results.push({
        appId: replica.appId,
        deploymentName: replica.deploymentName,
        status: captured.status,
        changesetId: captured.changesetId,
      });
    } catch (error) {
      results.push({
        appId: replica.appId,
        deploymentName: replica.deploymentName,
        status: 'blocked',
        blockers: [error instanceof Error ? error.message : String(error)],
      });
    }
  }
  return results;
}

async function reconcileReplica(
  replica: SelectedReplica,
  membership: Pick<SuitcaseMembership, 'siteId' | 'credential' | 'publicKey' | 'accessMode'>,
  executor: SuitcaseExecutor,
  access: { ready: boolean; evidence: string },
  healthTimeoutMs?: number,
  drainTimeoutMs?: number,
): Promise<SuitcaseApplicationMaterializationResult> {
  const authorityTransfer = activeOpaqueVolumeAuthorityTransfer(replica.appId);
  if (
    authorityTransfer &&
    (authorityTransfer.sourceSiteId === replica.siteId ||
      authorityTransfer.targetSiteId === replica.siteId)
  ) {
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'runtime',
      desiredDigest: replica.desiredSpecDigest || undefined,
      state: 'blocked',
      blockers: [
        `Writer handoff ${authorityTransfer.id} is ${authorityTransfer.state}; runtime remains quiesced until commit or source resume`,
      ],
      evidence: [{ transferId: authorityTransfer.id, state: authorityTransfer.state }],
    });
    return {
      appId: replica.appId,
      deploymentName: replica.deploymentName,
      status: 'blocked',
      specDigest: replica.desiredSpecDigest,
      activeSpecDigest: replica.activeSpecDigest,
      blockers: [`Writer handoff ${authorityTransfer.id} is ${authorityTransfer.state}`],
    };
  }
  const priorRuntime = runtimeMaterialization(replica.appId, replica.siteId);
  const priorHealthyDigest = priorRuntime?.state === 'ready' ? priorRuntime.availableDigest : null;
  const hasPriorHealthyRuntime = Boolean(
    priorHealthyDigest || readyInstanceCount(replica.appId, replica.siteId) > 0,
  );
  updateIdentityMaterialization(replica, membership);
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'access',
    state: access.ready ? 'ready' : 'blocked',
    blockers: access.ready ? [] : [access.evidence],
    evidence: [{ source: 'local-control-surface', detail: access.evidence }],
  });

  if (isFollowsOneSite(replica) && replica.dataMode !== 'follows-one-site-writer') {
    const snapshot = latestOpaqueSnapshot(replica.appId);
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'data',
      desiredDigest: snapshot?.id,
      availableDigest: snapshot?.id,
      state: snapshot ? 'ready' : 'missing',
      blockers: snapshot ? [] : ['no verified opaque recovery snapshot is materialized'],
      evidence: snapshot
        ? [{ source: 'opaque-volume-snapshot', detail: `${snapshot.id}; recovery-only` }]
        : [],
    });
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'runtime',
      desiredDigest: replica.desiredSpecDigest || undefined,
      state: 'blocked',
      blockers: ['Follows one site permits runtime only on the current writer site'],
    });
    updateReplicaRuntimeStatus(replica, 'recovery-only');
    return {
      appId: replica.appId,
      deploymentName: replica.deploymentName,
      status: 'blocked',
      specDigest: replica.desiredSpecDigest,
      activeSpecDigest: replica.activeSpecDigest,
      blockers: ['Follows one site permits runtime only on the current writer site'],
    };
  }

  if (!replica.desiredSpecDigest) {
    return blockReplica(replica, null, priorHealthyDigest, [
      'desired application revision is missing',
    ]);
  }
  const revision = getApplicationSpecRevision(replica.deploymentName, replica.desiredSpecDigest);
  if (!revision) {
    return blockReplica(replica, replica.desiredSpecDigest, priorHealthyDigest, [
      'desired immutable application revision is not materialized',
    ]);
  }
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const contractMode = suitcaseContractMode(replica.dataMode);
  if (!contractMode) {
    return blockReplica(replica, revision.digest, priorHealthyDigest, [
      `replica has unsupported Suitcase data mode ${JSON.stringify(replica.dataMode)}`,
    ]);
  }
  try {
    assertSuitcaseDataModeAllowedBySpec(replica.appId, replica.deploymentName, spec, contractMode);
  } catch (error) {
    return blockReplica(replica, revision.digest, priorHealthyDigest, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  const configuration = resolveApplicationConfiguration({
    deploymentName: replica.deploymentName,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId: replica.siteId,
  });
  if (!configuration.ready) {
    return blockReplica(replica, revision.digest, priorHealthyDigest, [
      `site configuration is missing: ${configuration.missing.join(', ')}`,
    ]);
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId: replica.appId,
    specDigest: revision.digest,
    spec,
    configuration,
    siteId: replica.siteId,
  });
  if (!runtime.ready) {
    return blockReplica(
      replica,
      revision.digest,
      priorHealthyDigest,
      runtime.execution.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message),
      runtime.execution.placementEvidence,
    );
  }

  const dataBlockers = dataReadinessBlockers(replica);
  if (dataBlockers.length > 0) {
    return blockReplica(replica, revision.digest, priorHealthyDigest, dataBlockers);
  }

  let projectDirectoryPath: string;
  try {
    projectDirectoryPath = await materializeProjectDirectory(replica, spec, revision.digest);
  } catch (error) {
    return blockReplica(replica, revision.digest, priorHealthyDigest, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  const context = graphContext(
    replica,
    runtime,
    projectDirectoryPath,
    healthTimeoutMs,
    drainTimeoutMs,
  );
  let offlineBuildProof: GraphOfflineBuildProof | null = null;
  if (hasBuildComponents(spec)) {
    let desiredBuildDigest = replica.sourceArtifactDigest || revision.digest;
    try {
      if (!replica.sourceArtifactDigest) {
        throw new Error('offline build proof requires a verified source artifact');
      }
      desiredBuildDigest = offlineBuildProofInputDigest(
        context,
        replica.sourceArtifactDigest as `sha256:${string}`,
      );
      if (!executor.proveOfflineBuild) {
        throw new Error('target executor does not support no-network build validation');
      }
      offlineBuildProof = await executor.proveOfflineBuild(
        context,
        replica.sourceArtifactDigest as `sha256:${string}`,
      );
      if (offlineBuildProof.inputDigest !== desiredBuildDigest) {
        throw new Error('target returned offline build evidence for different immutable inputs');
      }
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'build',
        desiredDigest: desiredBuildDigest,
        availableDigest: offlineBuildProof.inputDigest,
        state: 'ready',
        verifiedAt: offlineBuildProof.verifiedAt,
        evidence: [
          {
            source: 'target-no-network-build',
            detail: `Docker built ${offlineBuildProof.components.map((item) => item.component).join(', ')} with --network none from exact source ${offlineBuildProof.sourceArtifactDigest} and spec ${offlineBuildProof.specDigest}`,
            inputDigest: offlineBuildProof.inputDigest,
            sourceArtifactDigest: offlineBuildProof.sourceArtifactDigest,
            specDigest: offlineBuildProof.specDigest,
            networkMode: offlineBuildProof.networkMode,
          },
        ],
      });
    } catch (error) {
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'build',
        desiredDigest: desiredBuildDigest,
        state: 'blocked',
        blockers: [
          `exact no-network build proof failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      });
    }
  }
  const catalogOperation = pendingCatalogRevision(replica.appId, replica.siteId);
  if (catalogOperation?.recoveryArtifactReference || catalogOperation?.recoveryArtifactDigest) {
    if (!catalogOperation.recoveryArtifactReference || !catalogOperation.recoveryArtifactDigest) {
      return blockReplica(replica, revision.digest, priorHealthyDigest, [
        'rollback intent requires both a recovery artifact reference and digest',
      ]);
    }
    if (replica.syncPolicy !== 'none') {
      return blockReplica(replica, revision.digest, priorHealthyDigest, [
        'catalog recovery restore cannot be combined with shared-data checkpoint restore',
      ]);
    }
    try {
      await executor.restoreRecoveryPoint(context, {
        artifactReference: catalogOperation.recoveryArtifactReference,
        artifactDigest: catalogOperation.recoveryArtifactDigest as `sha256:${string}`,
      });
    } catch (error) {
      return blockReplica(replica, revision.digest, priorHealthyDigest, [
        `catalog recovery restore failed: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }
  if (replica.dataMode === 'follows-one-site-writer') {
    try {
      const snapshot = latestOpaqueSnapshot(replica.appId);
      if (!snapshot || snapshot.authoritySiteId !== replica.siteId) {
        throw new Error('current site does not own a verified opaque volume snapshot');
      }
      const currentData = materialization(replica.appId, replica.siteId, 'data');
      if (currentData?.availableDigest !== snapshot.id || currentData.state !== 'ready') {
        await restoreOpaqueVolumeSnapshot({
          applicationId: replica.appId,
          snapshotId: snapshot.id,
          context,
          executor,
        });
      }
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'data',
        desiredDigest: snapshot.id,
        availableDigest: snapshot.id,
        state: 'ready',
        evidence: [
          {
            source: 'opaque-volume-snapshot',
            detail: `${snapshot.id}; authority ${snapshot.authoritySiteId}`,
          },
        ],
      });
    } catch (error) {
      return blockReplica(replica, revision.digest, priorHealthyDigest, [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  } else if (replica.syncPolicy !== 'none') {
    try {
      const restored = await restoreSuitcaseCheckpoint({
        applicationId: replica.appId,
        siteId: replica.siteId,
        checkpointId: replica.baseCheckpointId!,
        profileVersion: replica.profileVersion,
        spec,
        context,
        executor,
      });
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'data',
        desiredDigest: restored.checkpointId,
        availableDigest: restored.checkpointId,
        state: 'ready',
        evidence: [
          {
            source: 'cold-checkpoint-restore',
            detail: `${restored.resources.length} named volume(s); manifest ${restored.manifestArtifactDigest}`,
          },
        ],
      });
    } catch (error) {
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'data',
        desiredDigest: replica.baseCheckpointId!,
        state: 'blocked',
        blockers: [error instanceof Error ? error.message : String(error)],
      });
      return blockReplica(replica, revision.digest, priorHealthyDigest, [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }

  const desiredReleaseDigest = replica.desiredReleaseDigest || revision.digest;
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'release',
    desiredDigest: desiredReleaseDigest,
    availableDigest: priorHealthyDigest || undefined,
    desiredGeneration: replica.releaseGeneration,
    state: 'syncing',
    evidence: [{ source: 'application-revision', detail: revision.digest }],
  });
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'runtime',
    desiredDigest: revision.digest,
    availableDigest: priorHealthyDigest || undefined,
    desiredGeneration: replica.releaseGeneration,
    state: 'syncing',
  });

  try {
    const materialized = await executor.converge(context);
    recordMaterializedApplicationRuntime({
      deploymentName: replica.deploymentName,
      specDigest: revision.digest,
      siteId: replica.siteId,
      projectDirectory: projectDirectoryPath,
      primaryPort: materialized.primaryPort,
      primaryContainerId: materialized.primaryContainerId,
      primaryContainerName: materialized.primaryContainerName,
    });
    updateReplicaRuntimeStatus(replica, 'running');
    if (replica.syncPolicy === 'none') {
      updateMaterialization({
        appId: replica.appId,
        siteId: replica.siteId,
        capability: 'data',
        state: 'ready',
        evidence: [
          {
            source: 'site-local-volume',
            detail: 'Executor initialized an independent Suitcase data namespace',
          },
        ],
      });
    }
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'release',
      desiredDigest: desiredReleaseDigest,
      availableDigest: desiredReleaseDigest,
      desiredGeneration: replica.releaseGeneration,
      availableGeneration: replica.releaseGeneration,
      state: 'ready',
      evidence: [{ source: 'healthy-graph', detail: revision.digest }],
    });
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'runtime',
      desiredDigest: revision.digest,
      availableDigest: revision.digest,
      desiredGeneration: replica.releaseGeneration,
      availableGeneration: replica.releaseGeneration,
      state: 'ready',
      evidence: [
        {
          source: 'application-graph-executor',
          detail: `${materialized.instances.length} healthy fixed-slot instance(s)`,
        },
      ],
    });
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'rollback',
      desiredDigest: revision.digest,
      availableDigest: priorHealthyDigest || revision.digest,
      state: hasPriorHealthyRuntime ? 'ready' : 'unknown',
      blockers: hasPriorHealthyRuntime ? [] : ['no prior healthy release exists on this site'],
      evidence: hasPriorHealthyRuntime
        ? [
            {
              source: 'endpoint-generation',
              detail: `Prior healthy release ${priorHealthyDigest || replica.activeSpecDigest} retained until admission`,
            },
          ]
        : [],
    });
    const blockers = issueReadiness(replica, revision.digest, hasBuildComponents(spec));
    return {
      appId: replica.appId,
      deploymentName: replica.deploymentName,
      status: blockers.length ? 'blocked' : 'ready',
      specDigest: revision.digest,
      activeSpecDigest: revision.digest,
      blockers,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateMaterialization({
      appId: replica.appId,
      siteId: replica.siteId,
      capability: 'runtime',
      desiredDigest: revision.digest,
      availableDigest: priorHealthyDigest || undefined,
      desiredGeneration: replica.releaseGeneration,
      availableGeneration: hasPriorHealthyRuntime
        ? (priorRuntime?.availableGeneration ?? undefined)
        : undefined,
      state: 'blocked',
      blockers: [`desired release failed health admission: ${message}`],
      evidence: hasPriorHealthyRuntime
        ? [{ source: 'rollback', detail: 'Prior endpoint generation remains active' }]
        : [],
    });
    updateReplicaRuntimeStatus(replica, hasPriorHealthyRuntime ? 'running' : 'failed');
    updateDeploymentStatus(replica.deploymentName, hasPriorHealthyRuntime ? 'running' : 'failed');
    const readiness = issueReadiness(replica, revision.digest, hasBuildComponents(spec));
    return {
      appId: replica.appId,
      deploymentName: replica.deploymentName,
      status: 'failed',
      specDigest: revision.digest,
      activeSpecDigest: replica.activeSpecDigest,
      blockers: [...new Set([message, ...readiness])],
    };
  }
}

function blockReplica(
  replica: SelectedReplica,
  specDigest: string | null,
  priorHealthyDigest: string | null,
  blockers: string[],
  evidence: readonly unknown[] = [],
): SuitcaseApplicationMaterializationResult {
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'release',
    desiredDigest: replica.desiredReleaseDigest || specDigest || undefined,
    availableDigest: priorHealthyDigest || undefined,
    desiredGeneration: replica.releaseGeneration,
    state: 'missing',
    blockers,
  });
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'runtime',
    desiredDigest: specDigest || undefined,
    availableDigest: priorHealthyDigest || undefined,
    desiredGeneration: replica.releaseGeneration,
    state: 'blocked',
    blockers,
    evidence: [...evidence],
  });
  updateReplicaRuntimeStatus(replica, priorHealthyDigest ? 'running' : 'blocked');
  const readiness = specDigest ? issueReadiness(replica, specDigest, false) : blockers;
  return {
    appId: replica.appId,
    deploymentName: replica.deploymentName,
    status: 'blocked',
    specDigest,
    activeSpecDigest: replica.activeSpecDigest,
    blockers: [...new Set([...blockers, ...readiness])],
  };
}

function updateIdentityMaterialization(
  replica: SelectedReplica,
  membership: Pick<SuitcaseMembership, 'siteId' | 'credential' | 'publicKey'>,
): void {
  const sqlite = getSqlite()!;
  const site = sqlite
    .prepare(
      `SELECT public_key, credential_status, revoked_at FROM sites
        WHERE id = ? AND kind = 'suitcase'`,
    )
    .get(replica.siteId) as
    | { public_key: string; credential_status: string; revoked_at: string | null }
    | undefined;
  const administrators = Number(
    (
      sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin'").get() as {
        count: number;
      }
    ).count,
  );
  const ready = Boolean(
    membership.siteId === replica.siteId &&
    membership.credential &&
    membership.publicKey === site?.public_key &&
    site.credential_status === 'active' &&
    !site.revoked_at &&
    administrators > 0,
  );
  updateMaterialization({
    appId: replica.appId,
    siteId: replica.siteId,
    capability: 'identity',
    state: ready ? 'ready' : 'blocked',
    blockers: ready ? [] : ['site identity or offline administrator projection is incomplete'],
    evidence: ready
      ? [
          { source: 'site-membership', detail: 'Active site key and credential are installed' },
          {
            source: 'offline-auth',
            detail: `${administrators} offline administrator verifier(s) installed`,
          },
        ]
      : [],
  });
}

function dataReadinessBlockers(replica: SelectedReplica): string[] {
  if (isFollowsOneSite(replica)) return [];
  if (replica.syncPolicy === 'none') return [];
  if (!replica.baseCheckpointId) return ['shared data policy requires an adopted base checkpoint'];
  const checkpoint = getSqlite()!
    .prepare(
      `SELECT database_artifact_digest, filesystem_artifact_digest,
              manifest_artifact_digest, verification_status
         FROM data_checkpoints WHERE id = ? AND app_id = ?`,
    )
    .get(replica.baseCheckpointId, replica.appId) as
    | {
        database_artifact_digest: string | null;
        filesystem_artifact_digest: string | null;
        manifest_artifact_digest: string;
        verification_status: string;
      }
    | undefined;
  if (!checkpoint || checkpoint.verification_status !== 'verified') {
    return ['shared base checkpoint is missing or unverified'];
  }
  const missing = [
    checkpoint.manifest_artifact_digest,
    checkpoint.database_artifact_digest,
    checkpoint.filesystem_artifact_digest,
  ]
    .filter((digest): digest is string => Boolean(digest))
    .filter((digest) => !getArtifact(digest));
  if (missing.length) return [`shared checkpoint artifacts are missing: ${missing.join(', ')}`];
  return [];
}

function isFollowsOneSite(replica: SelectedReplica): boolean {
  return replica.dataMode.startsWith('follows-one-site');
}

function latestOpaqueSnapshot(
  appId: string,
): { id: string; authoritySiteId: string; createdAt: string } | undefined {
  const row = getSqlite()!
    .prepare(
      `SELECT id, authority_site_id, created_at FROM volume_snapshots
        WHERE app_id = ? AND verification_status = 'verified'
        ORDER BY authority_epoch DESC, data_sequence DESC LIMIT 1`,
    )
    .get(appId) as { id: string; authority_site_id: string; created_at: string } | undefined;
  return row
    ? { id: row.id, authoritySiteId: row.authority_site_id, createdAt: row.created_at }
    : undefined;
}

function opaqueCaptureDue(appId: string, siteId: string): boolean {
  const latest = latestOpaqueSnapshot(appId);
  if (!latest || latest.authoritySiteId !== siteId) return true;
  const configured = Number(process.env.DEPLOY_OPAQUE_SNAPSHOT_INTERVAL_MS);
  const interval = Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
  const createdAt = Date.parse(latest.createdAt);
  return !Number.isFinite(createdAt) || Date.now() - createdAt >= interval;
}

async function materializeProjectDirectory(
  replica: SelectedReplica,
  spec: ApplicationSpec,
  specDigest: string,
): Promise<string> {
  const destination = projectDirectory(replica.appId, specDigest);
  if (!hasBuildComponents(spec)) {
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    return destination;
  }
  if (!replica.sourceArtifactDigest) {
    throw new Error('build-backed application is missing its verified source artifact');
  }
  const artifact = getArtifact(replica.sourceArtifactDigest);
  if (!artifact || !(await verifyArtifact(replica.sourceArtifactDigest))) {
    throw new Error(`source artifact ${replica.sourceArtifactDigest} is missing or corrupt`);
  }
  const marker = `${destination}.source-digest`;
  if (
    existsSync(destination) &&
    existsSync(marker) &&
    readFileSync(marker, 'utf8').trim() === replica.sourceArtifactDigest
  ) {
    return destination;
  }
  if (existsSync(destination)) {
    throw new Error(`source directory for ${specDigest} exists without matching digest evidence`);
  }
  await inspectUploadArchive(artifact.localPath);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(resolve(parent, '.extract-'));
  try {
    await execFileAsync('tar', ['-xzf', artifact.localPath, '-C', staging]);
    await rename(staging, destination);
    writeFileSync(marker, `${replica.sourceArtifactDigest}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return destination;
}

function projectDirectory(appId: string, specDigest: string): string {
  const safeApp = appId.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  const digest = specDigest.replace(/^sha256:/, '');
  return deployDataPath('suitcase-projects', safeApp, digest);
}

interface PendingCatalogRevision {
  catalogOperationId: string;
  catalogOperationAttempt: number;
  recoveryPointId?: string;
  recoveryArtifactReference?: string;
  recoveryArtifactDigest?: string;
}

function pendingCatalogRevision(appId: string, siteId: string): PendingCatalogRevision | undefined {
  const row = getSqlite()!
    .prepare(
      `SELECT desired.payload
         FROM fleet_events desired
        WHERE desired.app_id = ? AND desired.operation = 'application.revision.desired'
          AND json_extract(desired.payload, '$.siteId') = ?
          AND json_extract(desired.payload, '$.catalogOperationId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events complete
             WHERE complete.origin_site_id = ?
               AND complete.operation = 'catalog.operation.materialized'
               AND json_extract(complete.payload, '$.catalogOperationId') =
                   json_extract(desired.payload, '$.catalogOperationId')
               AND COALESCE(json_extract(complete.payload, '$.catalogOperationAttempt'), 1) =
                   COALESCE(json_extract(desired.payload, '$.catalogOperationAttempt'), 1)
          )
        ORDER BY desired.created_at DESC, desired.id DESC LIMIT 1`,
    )
    .get(appId, siteId, siteId) as { payload: string } | undefined;
  if (!row) return undefined;
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return {
    catalogOperationId: String(payload.catalogOperationId),
    catalogOperationAttempt: Number(payload.catalogOperationAttempt || 1),
    recoveryPointId:
      typeof payload.recoveryPointId === 'string' ? payload.recoveryPointId : undefined,
    recoveryArtifactReference:
      typeof payload.recoveryArtifactReference === 'string'
        ? payload.recoveryArtifactReference
        : undefined,
    recoveryArtifactDigest:
      typeof payload.recoveryArtifactDigest === 'string'
        ? payload.recoveryArtifactDigest
        : undefined,
  };
}

function emitCatalogOperationCompletion(
  replica: SelectedReplica,
  result: SuitcaseApplicationMaterializationResult,
): void {
  const operation = pendingCatalogRevision(replica.appId, replica.siteId);
  if (!operation) return;
  appendLocalFleetEvent({
    originSiteId: replica.siteId,
    appId: replica.appId,
    actor: `system@${replica.siteId}`,
    operation: 'catalog.operation.materialized',
    generation: replica.releaseGeneration,
    payload: {
      catalogOperationId: operation.catalogOperationId,
      catalogOperationAttempt: operation.catalogOperationAttempt,
      siteId: replica.siteId,
      appId: replica.appId,
      deploymentName: replica.deploymentName,
      status: result.status,
      specDigest: result.specDigest,
      activeSpecDigest: result.activeSpecDigest,
      blockers: result.blockers,
    },
  });
}

async function materializeCatalogRemovals(
  membership: Pick<SuitcaseMembership, 'siteId'>,
  executor: SuitcaseExecutor,
): Promise<void> {
  const rows = getSqlite()!
    .prepare(
      `SELECT removal.app_id, removal.payload, d.name
         FROM fleet_events removal
         JOIN deployments d ON d.app_id = removal.app_id
        WHERE removal.operation = 'application.replica.removed'
          AND json_extract(removal.payload, '$.siteId') = ?
          AND json_extract(removal.payload, '$.catalogOperationId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events complete
             WHERE complete.origin_site_id = ?
               AND complete.operation = 'catalog.operation.materialized'
               AND json_extract(complete.payload, '$.catalogOperationId') =
                   json_extract(removal.payload, '$.catalogOperationId')
               AND COALESCE(json_extract(complete.payload, '$.catalogOperationAttempt'), 1) =
                   COALESCE(json_extract(removal.payload, '$.catalogOperationAttempt'), 1)
          )
        ORDER BY removal.created_at, removal.id`,
    )
    .all(membership.siteId, membership.siteId) as Array<{
    app_id: string;
    payload: string;
    name: string;
  }>;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const catalogOperationId = String(payload.catalogOperationId);
    const catalogOperationAttempt = Number(payload.catalogOperationAttempt || 1);
    const resources = Array.isArray(payload.managedVolumeResources)
      ? payload.managedVolumeResources.filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        )
      : [];
    let status: 'removed' | 'failed' = 'removed';
    let blockers: string[] = [];
    try {
      await executor.remove({
        applicationId: row.app_id,
        siteId: membership.siteId,
        managedVolumeResources: payload.retainData === true ? [] : resources,
        removeInfrastructure: true,
      });
      const now = new Date().toISOString();
      getSqlite()!
        .prepare(
          `UPDATE app_replicas SET removed_at = ?, runtime_status = 'removed',
                  shared_lineage = 0, updated_at = ?
            WHERE app_id = ? AND site_id = ?`,
        )
        .run(now, now, row.app_id, membership.siteId);
      updateDeploymentStatus(row.name, 'stopped');
    } catch (error) {
      status = 'failed';
      blockers = [error instanceof Error ? error.message : String(error)];
    }
    appendLocalFleetEvent({
      originSiteId: membership.siteId,
      appId: row.app_id,
      actor: `system@${membership.siteId}`,
      operation: 'catalog.operation.materialized',
      payload: {
        catalogOperationId,
        catalogOperationAttempt,
        siteId: membership.siteId,
        appId: row.app_id,
        deploymentName: row.name,
        status,
        specDigest: null,
        activeSpecDigest: null,
        blockers,
      },
    });
  }
}

async function materializeCatalogRecoveryRequests(
  membership: Pick<SuitcaseMembership, 'siteId'>,
  executor: SuitcaseExecutor,
): Promise<void> {
  const rows = getSqlite()!
    .prepare(
      `SELECT request.app_id, request.payload, d.name, d.active_spec_digest,
              d.source_artifact_digest, d.memory_limit, d.cpu_limit, d.directory
         FROM fleet_events request
         JOIN deployments d ON d.app_id = request.app_id
        WHERE request.operation = 'catalog.recovery.requested'
          AND json_extract(request.payload, '$.siteId') = ?
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events complete
             WHERE complete.origin_site_id = ?
               AND complete.operation = 'catalog.recovery.materialized'
               AND json_extract(complete.payload, '$.recoveryPointId') =
                   json_extract(request.payload, '$.recoveryPointId')
          )
        ORDER BY request.created_at, request.id`,
    )
    .all(membership.siteId, membership.siteId) as Array<{
    app_id: string;
    payload: string;
    name: string;
    active_spec_digest: string | null;
    source_artifact_digest: string | null;
    memory_limit: string | null;
    cpu_limit: string | null;
    directory: string | null;
  }>;
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const recoveryPointId = String(payload.recoveryPointId);
    let completion: Record<string, unknown>;
    try {
      if (!row.active_spec_digest) throw new Error('Active application revision is missing');
      const replica: SelectedReplica = {
        appId: row.app_id,
        siteId: membership.siteId,
        deploymentName: row.name,
        desiredSpecDigest: row.active_spec_digest,
        activeSpecDigest: row.active_spec_digest,
        desiredReleaseDigest: row.active_spec_digest,
        sourceArtifactDigest: row.source_artifact_digest,
        syncPolicy: 'none',
        dataMode: 'site-local',
        baseCheckpointId: null,
        profileVersion: null,
        releaseGeneration: 0,
        memoryLimit: row.memory_limit,
        cpuLimit: row.cpu_limit,
      };
      const prepared = prepareReplicaGraph(replica);
      const directory =
        row.directory ||
        (await materializeProjectDirectory(replica, prepared.spec, prepared.revisionDigest));
      const context = graphContext(replica, prepared.runtime, directory);
      const artifact = await executor.createRecoveryPoint(
        context,
        deployDataPath('catalog-recovery', safePathSegment(recoveryPointId)),
      );
      completion = {
        siteId: membership.siteId,
        recoveryPointId,
        status: 'verified',
        specDigest: prepared.revisionDigest,
        artifactReference: artifact.artifactReference,
        artifactDigest: artifact.artifactDigest,
        verification: artifact.verification,
        blockers: [],
      };
    } catch (error) {
      completion = {
        siteId: membership.siteId,
        recoveryPointId,
        status: 'failed',
        specDigest: row.active_spec_digest,
        blockers: [error instanceof Error ? error.message : String(error)],
      };
    }
    appendLocalFleetEvent({
      originSiteId: membership.siteId,
      appId: row.app_id,
      actor: `system@${membership.siteId}`,
      operation: 'catalog.recovery.materialized',
      payload: completion,
    });
  }
}

interface PolicyTransitionRequest {
  id: string;
  appId: string;
  policy: 'automatic' | 'manual';
  choice:
    | 'replace-site-from-shared'
    | 'replace-shared-from-site'
    | 'import-site-as-new-application';
  proposedSharedCheckpointId: string | null;
  importedApplicationId: string | null;
  importedApplicationName: string | null;
}

function pendingPolicyTransitionRequests(siteId: string): PolicyTransitionRequest[] {
  const rows = getSqlite()!
    .prepare(
      `SELECT request.id, request.app_id, request.payload
         FROM fleet_events request
        WHERE request.operation = 'application.data.policy.transition.requested'
          AND json_extract(request.payload, '$.siteId') = ?
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events terminal
             WHERE terminal.operation IN ('application.data.policy.transition.completed',
                                          'application.data.policy.transition.failed',
                                          'application.data.policy.transition.prepared')
               AND json_extract(terminal.payload, '$.requestEventId') = request.id
          )
        ORDER BY request.created_at, request.id`,
    )
    .all(siteId) as Array<{ id: string; app_id: string; payload: string }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const policy = String(payload.policy);
    const choice = String(payload.rejoinChoice);
    if (policy !== 'automatic' && policy !== 'manual') {
      throw new Error(`Policy transition ${row.id} has an invalid target policy`);
    }
    if (
      choice !== 'replace-site-from-shared' &&
      choice !== 'replace-shared-from-site' &&
      choice !== 'import-site-as-new-application'
    ) {
      throw new Error(`Policy transition ${row.id} has an invalid rejoin choice`);
    }
    return {
      id: row.id,
      appId: row.app_id,
      policy,
      choice,
      proposedSharedCheckpointId:
        typeof payload.proposedSharedCheckpointId === 'string'
          ? payload.proposedSharedCheckpointId
          : null,
      importedApplicationId:
        typeof payload.importedApplicationId === 'string' ? payload.importedApplicationId : null,
      importedApplicationName:
        typeof payload.importedApplicationName === 'string'
          ? payload.importedApplicationName
          : null,
    };
  });
}

async function materializeDataPolicyTransitionRequests(
  membership: Pick<SuitcaseMembership, 'siteId'>,
  executor: SuitcaseExecutor,
): Promise<void> {
  for (const request of pendingPolicyTransitionRequests(membership.siteId)) {
    const backupEventIds: string[] = [];
    try {
      const replica = selectedReplicas(membership.siteId).find(
        (candidate) => candidate.appId === request.appId,
      );
      if (!replica) throw new Error('Active target application replica is unavailable');
      if (replica.syncPolicy !== 'none' || replica.dataMode !== 'site-local') {
        throw new Error('Target replica no longer owns the requested site-local namespace');
      }
      if (!replica.profileVersion) {
        throw new Error('Target replica has no persisted reconciliation profile');
      }
      const prepared = prepareReplicaGraph(replica);
      const projectDirectoryPath = await materializeProjectDirectory(
        replica,
        prepared.spec,
        prepared.revisionDigest,
      );
      const context = graphContext(replica, prepared.runtime, projectDirectoryPath);
      const backup = await ensurePolicyTransitionBackup({
        request,
        siteId: membership.siteId,
        scope: 'site-local-namespace',
        context,
        executor,
      });
      backupEventIds.push(backup.eventId);

      if (request.choice === 'replace-shared-from-site') {
        const checkpoint = await createInitialSuitcaseCheckpoint({
          applicationId: request.appId,
          originSiteId: membership.siteId,
          profileVersion: replica.profileVersion,
          context,
          executor,
          actor: `system@${membership.siteId}`,
        });
        updateMaterialization({
          appId: request.appId,
          siteId: membership.siteId,
          capability: 'data',
          desiredDigest: checkpoint.id,
          availableDigest: checkpoint.id,
          state: 'ready',
          blockers: [],
          evidence: [{ source: 'policy-transition-preparation', requestEventId: request.id }],
        });
        recordReplicaDataPolicyTransitionPrepared({
          requestEventId: request.id,
          siteId: membership.siteId,
          replacementCheckpointId: checkpoint.id,
          backupEventId: backup.eventId,
          actor: `system@${membership.siteId}`,
        });
        continue;
      }

      if (!request.proposedSharedCheckpointId) {
        throw new Error('Verified shared checkpoint is unavailable on the target');
      }
      let imported: { appId: string; name: string } | undefined;
      if (request.choice === 'import-site-as-new-application') {
        imported = await materializeImportedPolicyNamespace({
          request,
          replica,
          prepared,
          projectDirectoryPath,
          backup,
          executor,
        });
      }
      const restored = await restoreSuitcaseCheckpoint({
        applicationId: request.appId,
        siteId: membership.siteId,
        checkpointId: request.proposedSharedCheckpointId,
        profileVersion: replica.profileVersion,
        spec: prepared.spec,
        context,
        executor,
      });
      updateMaterialization({
        appId: request.appId,
        siteId: membership.siteId,
        capability: 'data',
        desiredDigest: restored.checkpointId,
        availableDigest: restored.checkpointId,
        state: 'ready',
        blockers: [],
        evidence: [
          {
            source: 'policy-transition-restore',
            requestEventId: request.id,
            backupEventId: backup.eventId,
            reused: restored.reused,
          },
        ],
      });
      completeReplicaDataPolicyTransition({
        requestEventId: request.id,
        completedBySiteId: membership.siteId,
        baseCheckpointId: restored.checkpointId,
        backupEventIds,
        importedApplicationId: imported?.appId,
        importedApplicationName: imported?.name,
        actor: `system@${membership.siteId}`,
      });
    } catch (error) {
      failReplicaDataPolicyTransition({
        requestEventId: request.id,
        failedBySiteId: membership.siteId,
        backupEventIds,
        error: error instanceof Error ? error.message : String(error),
        actor: `system@${membership.siteId}`,
      });
    }
  }
}

async function ensurePolicyTransitionBackup(input: {
  request: PolicyTransitionRequest;
  siteId: string;
  scope: PolicyTransitionBackupEvidence['scope'];
  context: GraphExecutorContext;
  executor: SuitcaseExecutor;
}): Promise<PolicyTransitionBackupEvidence> {
  const existing = getSqlite()!
    .prepare(
      `SELECT id, payload FROM fleet_events
        WHERE operation = 'application.data.policy.transition.backup.created'
          AND json_extract(payload, '$.requestEventId') = ?
          AND json_extract(payload, '$.siteId') = ?
          AND json_extract(payload, '$.scope') = ?
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(input.request.id, input.siteId, input.scope) as
    | { id: string; payload: string }
    | undefined;
  if (existing) {
    const payload = JSON.parse(existing.payload) as Record<string, unknown>;
    const evidence: PolicyTransitionBackupEvidence = {
      eventId: existing.id,
      siteId: String(payload.siteId),
      artifactReference: String(payload.artifactReference),
      artifactDigest: String(payload.artifactDigest),
      verification: String(payload.verification),
      scope: String(payload.scope) as PolicyTransitionBackupEvidence['scope'],
    };
    await verifyPolicyTransitionBackup(evidence);
    return evidence;
  }
  const artifact = await input.executor.createRecoveryPoint(
    input.context,
    deployDataPath('policy-transition-backups', safePathSegment(input.request.id), input.scope),
  );
  await verifyPolicyTransitionBackup({
    artifactReference: artifact.artifactReference,
    artifactDigest: artifact.artifactDigest,
    verification: artifact.verification,
  });
  return recordReplicaDataPolicyTransitionBackup({
    requestEventId: input.request.id,
    siteId: input.siteId,
    scope: input.scope,
    artifactReference: artifact.artifactReference,
    artifactDigest: artifact.artifactDigest,
    verification: artifact.verification,
    actor: `system@${input.siteId}`,
  });
}

interface PolicyRecoveryManifest {
  version: number;
  applicationId: string;
  siteId: string;
  specDigest: string;
  configurationDigest: string;
  resources: Array<{ resource: string; archive: string; digest: string; bytes: number }>;
}

async function verifyPolicyTransitionBackup(
  evidence: Pick<
    PolicyTransitionBackupEvidence,
    'artifactReference' | 'artifactDigest' | 'verification'
  >,
): Promise<PolicyRecoveryManifest> {
  const manifestPath = resolve(evidence.artifactReference);
  const content = readFileSync(manifestPath);
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (digest !== evidence.artifactDigest || !evidence.verification) {
    throw new Error('Policy transition backup manifest failed digest verification');
  }
  const manifest = JSON.parse(content.toString('utf8')) as PolicyRecoveryManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.resources)) {
    throw new Error('Policy transition backup manifest format is invalid');
  }
  const root = dirname(manifestPath);
  for (const resource of manifest.resources) {
    const archive = resolve(root, resource.archive);
    if (archive !== root && !archive.startsWith(`${root}${sep}`)) {
      throw new Error('Policy transition backup archive escapes its durable directory');
    }
    const archiveDigest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
    if (archiveDigest !== resource.digest) {
      throw new Error(`Policy transition backup archive is corrupt: ${resource.resource}`);
    }
    await inspectUploadArchive(archive);
  }
  return manifest;
}

async function materializeImportedPolicyNamespace(input: {
  request: PolicyTransitionRequest;
  replica: SelectedReplica;
  prepared: {
    revisionDigest: string;
    spec: ApplicationSpec;
    runtime: ResolvedApplicationGraphRuntime;
  };
  projectDirectoryPath: string;
  backup: PolicyTransitionBackupEvidence;
  executor: SuitcaseExecutor;
}): Promise<{ appId: string; name: string }> {
  const appId = input.request.importedApplicationId;
  const name = input.request.importedApplicationName;
  if (!appId || !name) throw new Error('Import transition has no reserved application identity');
  const sqlite = getSqlite()!;
  const source = sqlite
    .prepare(
      `SELECT d.*, revision.api_version, revision.source AS revision_source,
              revision.manifest_format, revision.normalized_spec,
              revision.parent_digest, revision.created_by,
              revision.original_artifact_digest
         FROM deployments d
         JOIN application_spec_revisions revision
           ON revision.deployment_name = d.name AND revision.digest = ?
        WHERE d.app_id = ?`,
    )
    .get(input.prepared.revisionDigest, input.replica.appId) as Record<string, unknown> | undefined;
  if (!source) throw new Error('Source application revision is unavailable for import');
  const existing = sqlite.prepare('SELECT app_id FROM deployments WHERE name = ?').get(name) as
    | { app_id: string }
    | undefined;
  if (existing && existing.app_id !== appId) {
    throw new Error(`Reserved imported application name is already used: ${name}`);
  }
  const profileId = `profile_${appId}`;
  const now = new Date().toISOString();
  const normalizedArtifactDigest = retainApplicationRevisionArtifact(
    String(source.normalized_spec),
    'application-spec-normalized',
    'application/vnd.deploy.local.application+json',
  );
  const create = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO deployments
          (name, type, username, status, directory, memory_limit, cpu_limit,
           desired_node_id, desired_spec_digest, active_spec_digest, configuration_digest,
           spec_source, app_id, data_mode, reconciliation_profile_version,
           release_authority_epoch, release_generation, desired_release_digest,
           source_artifact_digest, image_artifact_digest, snapshot_artifact_digest,
           created_at, updated_at)
         VALUES (?, 'application-graph', ?, 'stopped', ?, ?, ?, ?, ?, ?, NULL,
                 'policy-transition-import', ?, 'site-local', ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        String(source.username || 'admin'),
        source.directory ? String(source.directory) : input.projectDirectoryPath,
        source.memory_limit ? String(source.memory_limit) : null,
        source.cpu_limit ? String(source.cpu_limit) : null,
        input.replica.siteId,
        input.prepared.revisionDigest,
        input.prepared.revisionDigest,
        appId,
        profileId,
        input.replica.desiredReleaseDigest || input.prepared.revisionDigest,
        source.source_artifact_digest ? String(source.source_artifact_digest) : null,
        source.image_artifact_digest ? String(source.image_artifact_digest) : null,
        source.snapshot_artifact_digest ? String(source.snapshot_artifact_digest) : null,
        now,
        now,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO application_spec_revisions
          (digest, deployment_name, parent_digest, api_version, source, manifest_format,
           normalized_spec, original_artifact_digest, normalized_artifact_digest,
           created_by, created_at)
         VALUES (?, ?, ?, ?, 'policy-transition-import', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.prepared.revisionDigest,
        name,
        source.parent_digest ? String(source.parent_digest) : null,
        String(source.api_version),
        String(source.manifest_format),
        String(source.normalized_spec),
        source.original_artifact_digest ? String(source.original_artifact_digest) : null,
        normalizedArtifactDigest,
        String(source.created_by || 'admin'),
        now,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO data_reconciliation_profiles
          (id, app_id, version, analyzer_version, schema_fingerprint, sqlite_files,
           eligible_tables, excluded_tables, upload_paths, opaque_paths, conflict_policy,
           compatibility_digest, findings, created_at)
         SELECT ?, ?, version, analyzer_version, schema_fingerprint, sqlite_files,
                eligible_tables, excluded_tables, upload_paths, opaque_paths, conflict_policy,
                compatibility_digest, findings, ?
           FROM data_reconciliation_profiles
          WHERE app_id = ? AND (id = ? OR version = ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .run(
        profileId,
        appId,
        now,
        input.replica.appId,
        input.replica.profileVersion,
        input.replica.profileVersion,
      );
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO app_replicas
          (id, app_id, site_id, active_release_digest, desired_release_digest,
           runtime_status, data_mode, sync_policy, shared_lineage, profile_version,
           readiness, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 'site-local', 'none', 0, ?, '{}', ?, ?)`,
      )
      .run(
        `replica_${appId}`,
        appId,
        input.replica.siteId,
        input.prepared.revisionDigest,
        input.replica.desiredReleaseDigest || input.prepared.revisionDigest,
        profileId,
        now,
        now,
      );
    const fleet = sqlite.prepare('SELECT id FROM fleets ORDER BY created_at LIMIT 1').get() as {
      id: string;
    };
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO application_aliases
          (fleet_id, alias, app_id, origin_site_id, state, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(fleet.id, name, appId, input.replica.siteId, now);
  });
  create.immediate();

  const sourceConfiguration = resolveApplicationConfiguration({
    deploymentName: input.replica.deploymentName,
    specDigest: input.prepared.revisionDigest,
    declarations: input.prepared.spec.configuration,
    siteId: input.replica.siteId,
  });
  for (const [key, declaration] of Object.entries(input.prepared.spec.configuration)) {
    if (!Object.hasOwn(sourceConfiguration.values, key)) continue;
    setDeclaredConfigurationValue({
      deploymentName: name,
      specDigest: input.prepared.revisionDigest,
      declarations: input.prepared.spec.configuration,
      key,
      value: sourceConfiguration.values[key],
      siteId: declaration.scope === 'site' ? input.replica.siteId : undefined,
      updatedBy: `system@${input.replica.siteId}`,
    });
  }
  const importedConfiguration = resolveApplicationConfiguration({
    deploymentName: name,
    specDigest: input.prepared.revisionDigest,
    declarations: input.prepared.spec.configuration,
    siteId: input.replica.siteId,
  });
  if (!importedConfiguration.ready) {
    throw new Error(
      `Imported application configuration is missing: ${importedConfiguration.missing.join(', ')}`,
    );
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId: appId,
    specDigest: input.prepared.revisionDigest,
    spec: input.prepared.spec,
    configuration: importedConfiguration,
    siteId: input.replica.siteId,
  });
  if (!runtime.ready) throw new Error('Imported application graph is not admissible');
  const context: GraphExecutorContext = {
    ...graphContext(input.replica, runtime, input.projectDirectoryPath),
    deploymentName: name,
    applicationId: appId,
  };
  const importedArtifact = await importedRecoveryArtifact(input.backup, context);
  await input.executor.restoreRecoveryPoint(context, importedArtifact);
  const checkpoint = await createInitialSuitcaseCheckpoint({
    applicationId: appId,
    originSiteId: input.replica.siteId,
    profileVersion: profileId,
    context,
    executor: input.executor,
    actor: `system@${input.replica.siteId}`,
  });
  sqlite
    .prepare(
      `UPDATE deployments SET status = 'running', active_spec_digest = ?, updated_at = ?
        WHERE app_id = ?`,
    )
    .run(input.prepared.revisionDigest, new Date().toISOString(), appId);
  sqlite
    .prepare(
      `UPDATE app_replicas SET runtime_status = 'running', base_checkpoint_id = ?,
              updated_at = ? WHERE app_id = ? AND site_id = ?`,
    )
    .run(checkpoint.id, new Date().toISOString(), appId, input.replica.siteId);
  updateMaterialization({
    appId,
    siteId: input.replica.siteId,
    capability: 'data',
    desiredDigest: checkpoint.id,
    availableDigest: checkpoint.id,
    state: 'ready',
    evidence: [{ source: 'policy-transition-import', requestEventId: input.request.id }],
  });
  appendLocalFleetEvent({
    originSiteId: input.replica.siteId,
    appId,
    actor: `system@${input.replica.siteId}`,
    operation: 'application.offline.release.candidate',
    payload: {
      name,
      appId,
      specDigest: input.prepared.revisionDigest,
      parentDigest: source.parent_digest || null,
      apiVersion: source.api_version,
      manifestFormat: source.manifest_format,
      normalizedSpec: source.normalized_spec,
      configurationDigest: importedConfiguration.digest,
      source: 'policy-transition-import',
      sourceArtifactDigest: source.source_artifact_digest || null,
      imageArtifactDigest: source.image_artifact_digest || null,
      snapshotArtifactDigest: source.snapshot_artifact_digest || null,
      baseAuthorityEpoch: 1,
      baseGeneration: 0,
      candidateKind: 'site-local-namespace-import',
      policyTransitionRequestId: input.request.id,
      importedCheckpointId: checkpoint.id,
    },
    artifactDigests: [
      source.source_artifact_digest,
      source.image_artifact_digest,
      source.snapshot_artifact_digest,
    ]
      .filter((value): value is string => typeof value === 'string')
      .filter((digest) => Boolean(getArtifact(digest))),
  });
  return { appId, name };
}

async function importedRecoveryArtifact(
  backup: PolicyTransitionBackupEvidence,
  context: GraphExecutorContext,
): Promise<GraphRecoveryArtifact> {
  const source = await verifyPolicyTransitionBackup(backup);
  const imported: PolicyRecoveryManifest = {
    ...source,
    applicationId: context.applicationId,
    siteId: context.siteId,
    specDigest: context.runtime.execution.specDigest,
    configurationDigest: context.runtime.configurationDigest,
  };
  const path = resolve(dirname(backup.artifactReference), 'import-recovery-manifest.json');
  const content = `${JSON.stringify(imported, null, 2)}\n`;
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  return {
    artifactReference: path,
    artifactDigest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    verification: `policy-transition-import:${backup.eventId}`,
  };
}

function safePathSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Unsafe catalog recovery id');
  return safe;
}

function graphContext(
  replica: SelectedReplica,
  runtime: ResolvedApplicationGraphRuntime,
  projectDirectoryPath: string,
  healthTimeoutMs?: number,
  drainTimeoutMs?: number,
): GraphExecutorContext {
  return {
    deploymentName: replica.deploymentName,
    applicationId: replica.appId,
    siteId: replica.siteId,
    nodeId: replica.siteId,
    projectDirectory: projectDirectoryPath,
    runtime,
    memoryLimit: replica.memoryLimit || '4g',
    cpuLimit: replica.cpuLimit || undefined,
    writerSiteId: applicationWriterSiteId(replica.appId),
    healthTimeoutMs,
    drainTimeoutMs,
  };
}

function prepareReplicaGraph(replica: SelectedReplica): {
  revisionDigest: string;
  spec: ApplicationSpec;
  runtime: ResolvedApplicationGraphRuntime;
} {
  const revision = replica.desiredSpecDigest
    ? getApplicationSpecRevision(replica.deploymentName, replica.desiredSpecDigest)
    : undefined;
  if (!revision) throw new Error('Desired immutable application revision is not materialized');
  const spec = parseStoredApplicationSpec(revision.normalizedSpec);
  const configuration = resolveApplicationConfiguration({
    deploymentName: replica.deploymentName,
    specDigest: revision.digest,
    declarations: spec.configuration,
    siteId: replica.siteId,
  });
  if (!configuration.ready) {
    throw new Error(`Site configuration is missing: ${configuration.missing.join(', ')}`);
  }
  const runtime = buildApplicationGraphRuntime({
    applicationId: replica.appId,
    specDigest: revision.digest,
    spec,
    configuration,
    siteId: replica.siteId,
  });
  if (!runtime.ready) {
    throw new Error(
      runtime.execution.findings
        .filter((finding) => finding.severity === 'error')
        .map((finding) => finding.message)
        .join('; ') || 'Application graph admission is blocked',
    );
  }
  return { revisionDigest: revision.digest, spec, runtime };
}

function selectedReplicas(siteId: string): SelectedReplica[] {
  return (
    getSqlite()!
      .prepare(
        `SELECT r.app_id, r.site_id, r.sync_policy, r.base_checkpoint_id,
                d.name, d.desired_spec_digest, d.active_spec_digest,
                d.desired_release_digest, d.source_artifact_digest,
                r.profile_version, r.data_mode, d.release_generation, d.memory_limit, d.cpu_limit
           FROM app_replicas r
           JOIN deployments d ON d.app_id = r.app_id
          WHERE r.site_id = ? AND r.removed_at IS NULL
          ORDER BY d.name`,
      )
      .all(siteId) as Array<Record<string, unknown>>
  ).map((row) => ({
    appId: String(row.app_id),
    siteId: String(row.site_id),
    deploymentName: String(row.name),
    desiredSpecDigest: row.desired_spec_digest ? String(row.desired_spec_digest) : null,
    activeSpecDigest: row.active_spec_digest ? String(row.active_spec_digest) : null,
    desiredReleaseDigest: row.desired_release_digest ? String(row.desired_release_digest) : null,
    sourceArtifactDigest: row.source_artifact_digest ? String(row.source_artifact_digest) : null,
    syncPolicy: String(row.sync_policy) as SelectedReplica['syncPolicy'],
    baseCheckpointId: row.base_checkpoint_id ? String(row.base_checkpoint_id) : null,
    profileVersion: row.profile_version ? String(row.profile_version) : null,
    dataMode: row.data_mode ? String(row.data_mode) : 'site-local',
    releaseGeneration: Number(row.release_generation || 0),
    memoryLimit: row.memory_limit ? String(row.memory_limit) : null,
    cpuLimit: row.cpu_limit ? String(row.cpu_limit) : null,
  }));
}

function updateReplicaRuntimeStatus(replica: SelectedReplica, status: string): void {
  getSqlite()!
    .prepare(
      'UPDATE app_replicas SET runtime_status = ?, updated_at = ? WHERE app_id = ? AND site_id = ?',
    )
    .run(status, new Date().toISOString(), replica.appId, replica.siteId);
}

function issueReadiness(
  replica: SelectedReplica,
  specDigest: string,
  requireBuild: boolean,
): string[] {
  const analyzer = getSqlite()!
    .prepare(
      `SELECT analyzer_version FROM portability_reports
        WHERE app_id = ? AND site_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(replica.appId, replica.siteId) as { analyzer_version: string } | undefined;
  return evaluateReplicaReadiness({
    appId: replica.appId,
    siteId: replica.siteId,
    specDigest,
    checkpointId: replica.baseCheckpointId || undefined,
    analyzerVersion: analyzer?.analyzer_version || PORTABILITY_ANALYZER_VERSION,
    requireBuild,
  }).blockers;
}

function materialization(appId: string, siteId: string, capability: string) {
  return getSqlite()!
    .prepare(
      `SELECT state,
              desired_digest AS desiredDigest,
              available_digest AS availableDigest,
              desired_generation AS desiredGeneration,
              available_generation AS availableGeneration,
              blockers
         FROM app_materialization WHERE app_id = ? AND site_id = ? AND capability = ?`,
    )
    .get(appId, siteId, capability) as
    | {
        state: MaterializationUpdate['state'];
        desiredDigest: string | null;
        availableDigest: string | null;
        desiredGeneration: number | null;
        availableGeneration: number | null;
        blockers: string;
      }
    | undefined;
}

function runtimeMaterialization(appId: string, siteId: string) {
  return materialization(appId, siteId, 'runtime');
}

function readyInstanceCount(appId: string, siteId: string): number {
  return Number(
    (
      getSqlite()!
        .prepare(
          `SELECT COUNT(*) AS count FROM component_instances
            WHERE app_id = ? AND site_id = ? AND status = 'ready' AND health = 'healthy'`,
        )
        .get(appId, siteId) as { count: number }
    ).count,
  );
}

function hasBuildComponents(spec: ApplicationSpec): boolean {
  return Object.values(spec.components).some((component) => Boolean(component.build));
}

function probeLocalControlSurface(siteId: string): Promise<{ ready: boolean; evidence: string }> {
  const port = Number(process.env.PORT || 80);
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ready: boolean, evidence: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe({ ready, evidence });
    };
    socket.setTimeout(1_000);
    socket.once('connect', () => {
      const client = currentSuitcaseClientAccess(siteId);
      done(
        client.ready,
        client.ready
          ? `local admin listener accepted TCP on port ${port}; ${client.evidence}`
          : client.evidence,
      );
    });
    socket.once('timeout', () => done(false, `local admin listener timed out on port ${port}`));
    socket.once('error', (error) =>
      done(false, `local admin listener is unavailable on port ${port}: ${error.message}`),
    );
  });
}
