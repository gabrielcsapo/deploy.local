import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { enqueueAgentJob, getAgentJob, cancelQueuedAgentJob } from '../store.ts';
import type { ReleaseNodePayload, ReleaseNodeResult } from './releases-worker.ts';

export type ReleaseNodeTransport = (
  nodeId: string,
  application: string,
  payload: ReleaseNodePayload,
  artifactPath?: string,
) => Promise<ReleaseNodeResult>;

/** Retries after coordinator restart follow the same durable job, never enqueue a second switch. */
export const dispatchReleaseNodeJob: ReleaseNodeTransport = async (
  nodeId,
  application,
  payload,
  artifactPath,
) => {
  const id = `release_${createHash('sha256')
    .update(
      JSON.stringify([
        nodeId,
        application,
        payload.releaseId,
        payload.phase,
        payload.backupId,
        payload.reverse,
        ['watch', 'status'].includes(payload.phase) ? randomUUID() : null,
      ]),
    )
    .digest('hex')}`;
  const job = enqueueAgentJob({
    id,
    nodeId,
    deploymentName: application,
    type: 'project-release',
    payload: payload as unknown as Record<string, unknown>,
    artifactPath,
  });
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    const current = getAgentJob(job.id)!;
    if (current.status === 'complete') {
      const result = JSON.parse(current.result || '{}');
      if (typeof result.verified !== 'boolean' || typeof result.phase !== 'string')
        throw new Error('Computer returned an invalid release receipt');
      return result;
    }
    if (current.status === 'failed')
      throw new Error(current.error || 'Computer release job failed');
    if (Date.now() >= deadline) {
      const cancelled = cancelQueuedAgentJob(job.id, 'Computer did not claim the release job');
      throw Object.assign(
        new Error(
          'Computer release job has not completed; recovery will follow its durable receipt',
        ),
        { requiresRecovery: !cancelled },
      );
    }
    await delay(250);
  }
};
