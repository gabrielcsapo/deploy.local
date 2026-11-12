import { encryptSecret, loadOrCreateSecretKey, decryptSecret } from '../secrets.ts';
import { DATA_DIR, getDb } from './connection.ts';
import { assertDeployRole, deployRoleEnabled } from './nodes.ts';
import { randomBytes } from 'node:crypto';
import { agentJobs } from '../schema.ts';
import { eq, and, sql, desc } from 'drizzle-orm';
import {
  withUpdateAdmission,
  updateReservation,
  computerUpdateAllowed,
  reserveComputerUpdate,
} from '../v2/update-admission.ts';
import { parseReleaseParts } from '../v2/release-progress.ts';
import { hasActiveAgentExecSessions } from '../agent-exec.ts';

function agentJobPayloadAddress(id: string) {
  return `deploy.local/agent-job/${id}/payload`;
}

function encryptAgentJobPayload(id: string, payload: Record<string, unknown>) {
  return encryptSecret(
    JSON.stringify(payload),
    loadOrCreateSecretKey(DATA_DIR),
    agentJobPayloadAddress(id),
  );
}

function decryptAgentJobRow<T extends { id: string; payload: string }>(job: T): T {
  // Rows created before v1 stored JSON directly. Preserve read compatibility
  // while ensuring every new or completed job is encrypted at rest.
  if (!job.payload.startsWith('v1:')) return job;
  return {
    ...job,
    payload: decryptSecret(
      job.payload,
      loadOrCreateSecretKey(DATA_DIR),
      agentJobPayloadAddress(job.id),
    ),
  };
}

export function enqueueAgentJob(input: {
  id?: string;
  nodeId: string;
  type: string;
  deploymentName: string;
  artifactPath?: string;
  payload: Record<string, unknown>;
}) {
  if (['deploy', 'application-graph'].includes(input.type)) assertDeployRole(input.nodeId);
  const db = getDb();
  const id = input.id || `job_${randomBytes(16).toString('hex')}`;
  const existing = getAgentJob(id);
  if (existing) {
    if (
      existing.nodeId !== input.nodeId ||
      existing.type !== input.type ||
      existing.deploymentName !== input.deploymentName
    )
      throw new Error('Agent job identity conflict');
    return existing;
  }
  db.insert(agentJobs)
    .values({
      id,
      nodeId: input.nodeId,
      type: input.type,
      deploymentName: input.deploymentName,
      artifactPath: input.artifactPath || null,
      payload: encryptAgentJobPayload(id, input.payload),
      createdAt: Date.now(),
    })
    .run();
  return decryptAgentJobRow(db.select().from(agentJobs).where(eq(agentJobs.id, id)).get()!);
}

export function claimAgentJob(nodeId: string) {
  const db = getDb();
  return withUpdateAdmission(() =>
    db.transaction((tx) => {
      if (updateReservation(nodeId)) return null;
      // Agent/service crashes can strand a claimed job. Builds have a 15-minute
      // ceiling, so a 20-minute lease safely makes abandoned work claimable.
      // Release heartbeats extend that lease; abandoned jobs remain recoverable after a restart.
      tx.update(agentJobs)
        .set({ status: 'queued', claimedAt: null })
        .where(
          and(
            eq(agentJobs.nodeId, nodeId),
            eq(agentJobs.status, 'running'),
            sql`${agentJobs.type} != 'self-update'`,
            sql`coalesce(json_extract(${agentJobs.progress}, '$.receivedAt'), ${agentJobs.claimedAt}) < ${Date.now() - 20 * 60_000}`,
          ),
        )
        .run();
      const job = tx
        .select()
        .from(agentJobs)
        .where(and(eq(agentJobs.nodeId, nodeId), eq(agentJobs.status, 'queued')))
        .orderBy(agentJobs.createdAt)
        .all()
        .find(
          (job) => deployRoleEnabled(nodeId) || !['deploy', 'application-graph'].includes(job.type),
        );
      if (!job) return null;
      if (job.type === 'self-update') {
        if (!computerUpdateAllowed(JSON.parse(decryptAgentJobRow(job).payload))) {
          tx.update(agentJobs)
            .set({
              status: 'failed',
              error: 'Automatic updates were turned off or the coordinator release changed.',
              completedAt: Date.now(),
            })
            .where(eq(agentJobs.id, job.id))
            .run();
          return null;
        }
        if (
          hasActiveAgentExecSessions(nodeId) ||
          tx
            .select()
            .from(agentJobs)
            .where(and(eq(agentJobs.nodeId, nodeId), eq(agentJobs.status, 'running')))
            .get()
        )
          return null;
        if (!reserveComputerUpdate(nodeId, job.id)) return null;
      }
      const claimedAt = Date.now();
      tx.update(agentJobs)
        .set({ status: 'running', claimedAt })
        .where(and(eq(agentJobs.id, job.id), eq(agentJobs.status, 'queued')))
        .run();
      return decryptAgentJobRow({ ...job, status: 'running', claimedAt });
    }),
  );
}

export function getAgentJob(id: string) {
  const job = getDb().select().from(agentJobs).where(eq(agentJobs.id, id)).get();
  return job ? decryptAgentJobRow(job) : null;
}

/** Cancel a job only while it is still waiting to be claimed by an agent. */
export function cancelQueuedAgentJob(id: string, reason: string): boolean {
  const db = getDb();
  const result = db
    .update(agentJobs)
    .set({
      status: 'failed',
      error: reason,
      payload: encryptAgentJobPayload(id, {}),
      completedAt: Date.now(),
    })
    .where(and(eq(agentJobs.id, id), eq(agentJobs.status, 'queued')))
    .run();
  return result.changes > 0;
}

/**
 * Put a failed job back in the queue under the same identity, for work that is safe to
 * repeat. A finished job's payload is wiped, so the caller supplies it again.
 */
export function requeueFailedAgentJob(id: string, payload: Record<string, unknown>): boolean {
  return (
    getDb()
      .update(agentJobs)
      .set({
        status: 'queued',
        claimedAt: null,
        createdAt: Date.now(),
        completedAt: null,
        error: null,
        result: null,
        progress: null,
        payload: encryptAgentJobPayload(id, payload),
      })
      .where(and(eq(agentJobs.id, id), eq(agentJobs.status, 'failed')))
      .run().changes > 0
  );
}

export function getRecentAgentJobs(nodeId: string, limit = 5) {
  return getDb()
    .select()
    .from(agentJobs)
    .where(eq(agentJobs.nodeId, nodeId))
    .orderBy(desc(agentJobs.createdAt))
    .limit(limit)
    .all();
}

export function completeAgentJob(
  id: string,
  nodeId: string,
  completion: { success: boolean; result?: Record<string, unknown>; error?: string },
) {
  const db = getDb();
  const job = getAgentJob(id);
  if (!job || job.nodeId !== nodeId) throw new Error('Job not found');
  if (job.status === 'complete' || job.status === 'failed') return;
  if (job.type === 'project-release' && job.status !== 'running')
    throw new Error('Job has not been claimed');
  db.update(agentJobs)
    .set({
      status: completion.success ? 'complete' : 'failed',
      result: completion.result ? JSON.stringify(completion.result) : null,
      error: completion.error || null,
      payload: encryptAgentJobPayload(id, {}),
      completedAt: Date.now(),
    })
    .where(eq(agentJobs.id, id))
    .run();
}

/** The receipt time is coordinator-owned; worker clocks cannot extend the idle deadline. */
export function recordReleaseJobProgress(id: string, nodeId: string, parts: unknown) {
  const parsed = parts === undefined ? undefined : parseReleaseParts(parts);
  const db = getDb();
  return db.transaction(() => {
    const job = getAgentJob(id);
    if (!job || job.nodeId !== nodeId || job.type !== 'project-release' || job.status !== 'running')
      throw new Error('Release job has not been claimed by this computer');
    const previous = job.progress ? JSON.parse(job.progress) : {};
    db.update(agentJobs)
      .set({
        progress: JSON.stringify({
          receivedAt: Date.now(),
          parts: parsed ?? previous.parts ?? [],
        }),
      })
      .where(eq(agentJobs.id, id))
      .run();
  });
}
