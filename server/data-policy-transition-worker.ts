import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import {
  ApplicationGraphExecutor,
  type GraphExecutorContext,
} from './application-graph-executor.ts';
import {
  completeReplicaDataPolicyTransition,
  failReplicaDataPolicyTransition,
  recordReplicaDataPolicyTransitionBackup,
  type PolicyTransitionBackupEvidence,
} from './data-policy-transitions.ts';
import { deployDataPath } from './data-directory.ts';
import { updateMaterialization } from './fleet-release.ts';
import {
  resolveLocalDataApplication,
  restoreHomeDataCheckpoint,
  type SuitcaseDataExecutor,
} from './suitcase-data-bridge.ts';
import { getSqlite } from './store.ts';
import { inspectUploadArchive } from './upload-archive.ts';

type PolicyTransitionExecutor = SuitcaseDataExecutor &
  Pick<ApplicationGraphExecutor, 'createRecoveryPoint'>;

interface PreparedHomeReplacement {
  eventId: string;
  requestEventId: string;
  appId: string;
  targetSiteId: string;
  replacementCheckpointId: string;
  targetBackupEventIds: string[];
}

let workerTimer: NodeJS.Timeout | null = null;
let workerActive = false;

function homeSiteId(): string {
  const home = getSqlite()!
    .prepare("SELECT id FROM sites WHERE kind = 'home' ORDER BY created_at LIMIT 1")
    .get() as { id: string } | undefined;
  if (!home) throw new Error('Home site identity is unavailable');
  return home.id;
}

function pendingHomeReplacements(): PreparedHomeReplacement[] {
  const rows = getSqlite()!
    .prepare(
      `SELECT prepared.id, prepared.app_id, prepared.payload
         FROM fleet_events prepared
        WHERE prepared.operation = 'application.data.policy.transition.prepared'
          AND json_extract(prepared.payload, '$.rejoinChoice') = 'replace-shared-from-site'
          AND NOT EXISTS (
            SELECT 1 FROM fleet_events terminal
             WHERE terminal.operation IN ('application.data.policy.transition.completed',
                                          'application.data.policy.transition.failed')
               AND json_extract(terminal.payload, '$.requestEventId') =
                   json_extract(prepared.payload, '$.requestEventId')
          )
        ORDER BY prepared.created_at, prepared.id`,
    )
    .all() as Array<{ id: string; app_id: string; payload: string }>;
  return rows.map((row) => {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    return {
      eventId: row.id,
      requestEventId: String(payload.requestEventId),
      appId: row.app_id,
      targetSiteId: String(payload.siteId),
      replacementCheckpointId: String(payload.replacementCheckpointId),
      targetBackupEventIds: Array.isArray(payload.backupEventIds)
        ? payload.backupEventIds.filter((id): id is string => typeof id === 'string')
        : [],
    };
  });
}

/**
 * Finish target-prepared "replace Home from suitcase" transitions. This is a
 * restart-safe worker: target preparation, both backups, Home restore, and the
 * terminal event are durable facts, so a new process resumes at the first
 * missing fact rather than repeating a destructive step blindly.
 */
export async function materializeHomeDataPolicyTransitions(
  input: {
    executor?: PolicyTransitionExecutor;
  } = {},
): Promise<void> {
  if (process.env.DEPLOY_SUITCASE === '1' || workerActive) return;
  workerActive = true;
  const executor = input.executor || new ApplicationGraphExecutor();
  const home = homeSiteId();
  try {
    for (const prepared of pendingHomeReplacements()) {
      const backupEventIds = [...prepared.targetBackupEventIds];
      try {
        if (backupEventIds.length === 0) {
          throw new Error('Target preparation did not retain its displaced namespace');
        }
        const application = resolveLocalDataApplication(prepared.appId, home, {
          checkpointId: prepared.replacementCheckpointId,
        });
        const backup = await ensureHomeTransitionBackup({
          prepared,
          homeSiteId: home,
          context: application.context,
          executor,
        });
        backupEventIds.push(backup.eventId);
        const restored = await restoreHomeDataCheckpoint({
          applicationId: prepared.appId,
          homeSiteId: home,
          checkpointId: prepared.replacementCheckpointId,
          executor,
        });
        const now = new Date().toISOString();
        getSqlite()!
          .prepare(
            `UPDATE app_replicas SET base_checkpoint_id = ?, branch_checkpoint_id = NULL,
                    pending_changesets = 0, pending_blobs = 0, updated_at = ?
              WHERE app_id = ? AND site_id = ? AND removed_at IS NULL`,
          )
          .run(prepared.replacementCheckpointId, now, prepared.appId, home);
        updateMaterialization({
          appId: prepared.appId,
          siteId: home,
          capability: 'data',
          desiredDigest: prepared.replacementCheckpointId,
          availableDigest: prepared.replacementCheckpointId,
          state: 'ready',
          blockers: [],
          evidence: [
            {
              source: 'policy-transition-home-replacement',
              requestEventId: prepared.requestEventId,
              backupEventId: backup.eventId,
              manifestArtifactDigest: restored.manifestArtifactDigest,
              reused: restored.reused,
            },
          ],
        });
        completeReplicaDataPolicyTransition({
          requestEventId: prepared.requestEventId,
          completedBySiteId: home,
          baseCheckpointId: prepared.replacementCheckpointId,
          backupEventIds,
          preparedEventId: prepared.eventId,
          actor: `system@${home}`,
        });
      } catch (error) {
        failReplicaDataPolicyTransition({
          requestEventId: prepared.requestEventId,
          failedBySiteId: home,
          backupEventIds,
          error: error instanceof Error ? error.message : String(error),
          actor: `system@${home}`,
        });
      }
    }
  } finally {
    workerActive = false;
  }
}

async function ensureHomeTransitionBackup(input: {
  prepared: PreparedHomeReplacement;
  homeSiteId: string;
  context: GraphExecutorContext;
  executor: PolicyTransitionExecutor;
}): Promise<PolicyTransitionBackupEvidence> {
  const existing = getSqlite()!
    .prepare(
      `SELECT id, payload FROM fleet_events
        WHERE operation = 'application.data.policy.transition.backup.created'
          AND json_extract(payload, '$.requestEventId') = ?
          AND json_extract(payload, '$.siteId') = ?
          AND json_extract(payload, '$.scope') = 'shared-home-namespace'
        ORDER BY created_at, id LIMIT 1`,
    )
    .get(input.prepared.requestEventId, input.homeSiteId) as
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
      scope: 'shared-home-namespace',
    };
    await verifyBackup(evidence);
    return evidence;
  }
  const artifact = await input.executor.createRecoveryPoint(
    input.context,
    deployDataPath(
      'policy-transition-backups',
      safeSegment(input.prepared.requestEventId),
      'shared-home-namespace',
    ),
  );
  await verifyBackup({
    artifactReference: artifact.artifactReference,
    artifactDigest: artifact.artifactDigest,
    verification: artifact.verification,
  });
  return recordReplicaDataPolicyTransitionBackup({
    requestEventId: input.prepared.requestEventId,
    siteId: input.homeSiteId,
    scope: 'shared-home-namespace',
    artifactReference: artifact.artifactReference,
    artifactDigest: artifact.artifactDigest,
    verification: artifact.verification,
    actor: `system@${input.homeSiteId}`,
  });
}

async function verifyBackup(
  evidence: Pick<
    PolicyTransitionBackupEvidence,
    'artifactReference' | 'artifactDigest' | 'verification'
  >,
): Promise<void> {
  const manifestPath = resolve(evidence.artifactReference);
  const content = readFileSync(manifestPath);
  const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  if (digest !== evidence.artifactDigest || !evidence.verification) {
    throw new Error('Home policy transition backup manifest failed verification');
  }
  const manifest = JSON.parse(content.toString('utf8')) as {
    version: number;
    resources: Array<{ resource: string; archive: string; digest: string }>;
  };
  if (manifest.version !== 1 || !Array.isArray(manifest.resources)) {
    throw new Error('Home policy transition backup manifest format is invalid');
  }
  const root = dirname(manifestPath);
  for (const resource of manifest.resources) {
    const archive = resolve(root, resource.archive);
    if (archive !== root && !archive.startsWith(`${root}${sep}`)) {
      throw new Error('Home policy transition backup archive escapes its durable directory');
    }
    const archiveDigest = `sha256:${createHash('sha256').update(readFileSync(archive)).digest('hex')}`;
    if (archiveDigest !== resource.digest) {
      throw new Error(`Home policy transition backup is corrupt: ${resource.resource}`);
    }
    await inspectUploadArchive(archive);
  }
}

function safeSegment(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9_.-]/g, '_');
  if (!safe || safe === '.' || safe === '..') throw new Error('Unsafe transition identifier');
  return safe;
}

/** Start the Home worker once; the immediate pass makes restart recovery deterministic. */
export function startDataPolicyTransitionWorker(intervalMs = 5_000): void {
  if (process.env.DEPLOY_SUITCASE === '1' || workerTimer) return;
  void materializeHomeDataPolicyTransitions().catch((error) =>
    console.error('Data policy transition worker failed:', error),
  );
  workerTimer = setInterval(() => {
    void materializeHomeDataPolicyTransitions().catch((error) =>
      console.error('Data policy transition worker failed:', error),
    );
  }, intervalMs);
  workerTimer.unref();
}

export function stopDataPolicyTransitionWorker(): void {
  if (!workerTimer) return;
  clearInterval(workerTimer);
  workerTimer = null;
}
