import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyDataChangeset,
  getDataSyncPolicy,
  resolveDataConflict,
  type ConflictPolicy,
} from './data-reconciliation.ts';
import { deployDataPath } from './data-directory.ts';
import { updateMaterialization } from './fleet-release.ts';
import {
  captureHomeDataBranch,
  restoreHomeDataCheckpoint,
  type SuitcaseDataExecutor,
} from './suitcase-data-bridge.ts';
import { getSqlite } from './store.ts';

let coordinatorTail: Promise<void> = Promise.resolve();

interface PendingChangeset {
  id: string;
  app_id: string;
  origin_site_id: string;
  database_artifact_digest: string | null;
  file_delta_artifact_digest: string | null;
}

export interface ReconciliationResult {
  changesetId: string;
  status: string;
  checkpointId?: string;
}

function latestVerifiedCheckpoint(appId: string): string | undefined {
  return (
    getSqlite()!
      .prepare(
        `SELECT id FROM data_checkpoints
          WHERE app_id = ? AND verification_status = 'verified'
          ORDER BY sequence DESC, created_at DESC LIMIT 1`,
      )
      .get(appId) as { id: string } | undefined
  )?.id;
}

function pendingForOrigin(originSiteId: string, appIds?: ReadonlySet<string>): PendingChangeset[] {
  const rows = getSqlite()!
    .prepare(
      `SELECT id, app_id, origin_site_id, database_artifact_digest,
              file_delta_artifact_digest
         FROM data_changesets
        WHERE origin_site_id = ? AND status = 'pending' ORDER BY created_at, id`,
    )
    .all(originSiteId) as PendingChangeset[];
  return appIds ? rows.filter((row) => appIds.has(row.app_id)) : rows;
}

function homeSiteIdIfPresent(): string | undefined {
  return (
    getSqlite()!
      .prepare("SELECT id FROM sites WHERE kind = 'home' ORDER BY created_at LIMIT 1")
      .get() as { id: string } | undefined
  )?.id;
}

function homeSiteId(): string {
  const siteId = homeSiteIdIfPresent();
  if (!siteId) throw new Error('Home site identity is unavailable for reconciliation');
  return siteId;
}

async function applyPending(
  changesets: readonly PendingChangeset[],
  explicitManual: boolean,
): Promise<ReconciliationResult[]> {
  const results: ReconciliationResult[] = [];
  for (const changeset of changesets) {
    const policy = getDataSyncPolicy(changeset.app_id, changeset.origin_site_id);
    if (policy.policy === 'none') continue;
    if (policy.policy === 'manual' && !explicitManual) continue;
    const currentCheckpointId = latestVerifiedCheckpoint(changeset.app_id);
    if (!currentCheckpointId) {
      results.push({ changesetId: changeset.id, status: 'waiting-for-checkpoint' });
      continue;
    }
    const stagingRoot = deployDataPath('reconciliation-staging', changeset.id);
    // This path is a fixed child of DEPLOY_DATA_DIR and contains only disposable staging state.
    rmSync(stagingRoot, { recursive: true, force: true });
    mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
    try {
      const result = await applyDataChangeset({
        changesetId: changeset.id,
        currentCheckpointId,
        coordinatorSiteId: homeSiteId(),
        stagingDatabasePath: changeset.database_artifact_digest
          ? join(stagingRoot, 'database.sqlite')
          : undefined,
        stagingFilesPath: changeset.file_delta_artifact_digest
          ? join(stagingRoot, 'files')
          : undefined,
        conflictPolicy: policy.conflictPolicy as ConflictPolicy,
      });
      results.push({
        changesetId: changeset.id,
        status: result.status,
        checkpointId: result.status === 'merged' ? result.checkpointId : undefined,
      });
      updateMaterialization({
        appId: changeset.app_id,
        siteId: changeset.origin_site_id,
        capability: 'data',
        desiredDigest: result.status === 'merged' ? result.checkpointId : undefined,
        availableDigest: result.status === 'merged' ? result.checkpointId : undefined,
        state: result.status === 'merged' ? 'ready' : 'blocked',
        blockers:
          result.status === 'merged'
            ? []
            : [`${result.conflictIds.length} reconciliation conflict(s) require resolution`],
        evidence: [{ changesetId: changeset.id, status: result.status }],
      });
    } finally {
      rmSync(stagingRoot, { recursive: true, force: true });
    }
  }
  return results;
}

function unresolvedConflictCount(appId: string): number {
  return Number(
    (
      getSqlite()!
        .prepare(
          "SELECT COUNT(*) AS count FROM data_conflicts WHERE app_id = ? AND status = 'open'",
        )
        .get(appId) as { count: number }
    ).count,
  );
}

async function materializeHomeCheckpoint(
  appId: string,
  coordinatorSiteId: string,
  executor?: SuitcaseDataExecutor,
): Promise<{ status: 'ready' | 'blocked'; checkpointId?: string; blocker?: string }> {
  const checkpointId = latestVerifiedCheckpoint(appId);
  if (!checkpointId) return { status: 'blocked', blocker: 'verified merged checkpoint is missing' };
  if (unresolvedConflictCount(appId) > 0) {
    const blocker = 'data conflicts must be resolved before Home adopts a merged checkpoint';
    updateMaterialization({
      appId,
      siteId: coordinatorSiteId,
      capability: 'data',
      desiredDigest: checkpointId,
      state: 'blocked',
      blockers: [blocker],
    });
    return { status: 'blocked', checkpointId, blocker };
  }
  try {
    const evidence = await restoreHomeDataCheckpoint({
      applicationId: appId,
      homeSiteId: coordinatorSiteId,
      checkpointId,
      executor,
    });
    updateMaterialization({
      appId,
      siteId: coordinatorSiteId,
      capability: 'data',
      desiredDigest: checkpointId,
      availableDigest: checkpointId,
      state: 'ready',
      blockers: [],
      evidence: [
        {
          checkpointId,
          manifestArtifactDigest: evidence.manifestArtifactDigest,
          restoredResources: evidence.resources,
          reused: evidence.reused,
        },
      ],
    });
    return { status: 'ready', checkpointId };
  } catch (error) {
    const blocker = error instanceof Error ? error.message : String(error);
    updateMaterialization({
      appId,
      siteId: coordinatorSiteId,
      capability: 'data',
      desiredDigest: checkpointId,
      state: 'blocked',
      blockers: [blocker],
    });
    return { status: 'blocked', checkpointId, blocker };
  }
}

export async function reconcilePendingChangesets(input: {
  originSiteId: string;
  explicitManual?: boolean;
  applicationIds?: ReadonlySet<string>;
  executor?: SuitcaseDataExecutor;
}): Promise<ReconciliationResult[]> {
  const run = coordinatorTail.then(
    () => reconcilePendingChangesetsNow(input),
    () => reconcilePendingChangesetsNow(input),
  );
  coordinatorTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function reconcilePendingChangesetsNow(input: {
  originSiteId: string;
  explicitManual?: boolean;
  applicationIds?: ReadonlySet<string>;
  executor?: SuitcaseDataExecutor;
}): Promise<ReconciliationResult[]> {
  const results: ReconciliationResult[] = [];
  const coordinatorSiteId = homeSiteId();
  const incoming = pendingForOrigin(input.originSiteId, input.applicationIds);
  const eligibleIncoming = incoming.filter((changeset) => {
    const policy = getDataSyncPolicy(changeset.app_id, changeset.origin_site_id);
    return (
      policy.policy !== 'none' && (policy.policy !== 'manual' || input.explicitManual === true)
    );
  });
  const appIds = new Set(eligibleIncoming.map((changeset) => changeset.app_id));
  const captureBlocked = new Set<string>();

  if (input.originSiteId !== coordinatorSiteId) {
    for (const appId of appIds) {
      try {
        await captureHomeDataBranch({
          applicationId: appId,
          homeSiteId: coordinatorSiteId,
          explicitManual: input.explicitManual,
          executor: input.executor,
        });
      } catch (error) {
        const blocker = error instanceof Error ? error.message : String(error);
        captureBlocked.add(appId);
        updateMaterialization({
          appId,
          siteId: coordinatorSiteId,
          capability: 'data',
          state: 'blocked',
          blockers: [`Home branch capture failed: ${blocker}`],
        });
        for (const changeset of eligibleIncoming.filter((row) => row.app_id === appId)) {
          results.push({ changesetId: changeset.id, status: 'waiting-for-home-capture' });
        }
      }
    }
  }

  const admissibleApps = new Set([...appIds].filter((appId) => !captureBlocked.has(appId)));
  results.push(
    ...(await applyPending(
      eligibleIncoming.filter((changeset) => admissibleApps.has(changeset.app_id)),
      input.explicitManual === true,
    )),
  );

  if (input.originSiteId !== coordinatorSiteId && admissibleApps.size > 0) {
    results.push(
      ...(await applyPending(pendingForOrigin(coordinatorSiteId, admissibleApps), true)),
    );
  }

  for (const appId of admissibleApps) {
    const materialized = await materializeHomeCheckpoint(appId, coordinatorSiteId, input.executor);
    if (materialized.status === 'blocked') {
      const last = [...results]
        .reverse()
        .find((result) =>
          eligibleIncoming.some(
            (changeset) => changeset.id === result.changesetId && changeset.app_id === appId,
          ),
        );
      if (last?.status === 'merged') last.status = 'merged-home-restore-blocked';
    }
  }
  return results;
}

export async function resolveAndMaterializeDataConflict(input: {
  conflictId: string;
  resolution: 'home' | 'suitcase' | 'keep-both' | 'custom';
  resolvedBy: string;
  executor?: SuitcaseDataExecutor;
}): Promise<{
  resolved: true;
  pendingConflicts: boolean;
  results: ReconciliationResult[];
}> {
  const resolution = resolveDataConflict(input);
  if (!resolution.readyToReconcile || !resolution.originSiteId) {
    return { resolved: true, pendingConflicts: true, results: [] };
  }
  const results = await reconcilePendingChangesets({
    originSiteId: resolution.originSiteId,
    explicitManual: true,
    executor: input.executor,
  });
  return {
    resolved: true,
    pendingConflicts: unresolvedConflictCount(resolution.appId) > 0,
    results,
  };
}

export async function reconcileAllAutomaticChangesets(): Promise<void> {
  // A brand-new installation has no fleet until onboarding or the first fleet-aware
  // operation. Startup reconciliation is maintenance work, so it must remain a no-op
  // instead of implicitly creating an identity or logging a false failure.
  const coordinatorSiteId = homeSiteIdIfPresent();
  if (!coordinatorSiteId) return;
  const origins = getSqlite()!
    .prepare("SELECT DISTINCT origin_site_id FROM data_changesets WHERE status = 'pending'")
    .all() as Array<{ origin_site_id: string }>;
  for (const origin of origins) {
    await reconcilePendingChangesets({ originSiteId: origin.origin_site_id });
  }
  const apps = getSqlite()!
    .prepare(
      `SELECT app_id FROM app_replicas
        WHERE site_id = ? AND data_mode = 'replicated' AND shared_lineage = 1
          AND removed_at IS NULL`,
    )
    .all(coordinatorSiteId) as Array<{ app_id: string }>;
  for (const app of apps) await materializeHomeCheckpoint(app.app_id, coordinatorSiteId);
}
