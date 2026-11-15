import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  enqueueAgentJob,
  getAgentJob,
  cancelQueuedAgentJob,
  requeueFailedAgentJob,
} from '../../store.ts';
import type { WorkerReleasePart } from './release-progress.ts';
import type { ReleaseNodePayload, ReleaseNodeResult } from '../../v2/releases-worker.ts';

export type ReleaseNodeTransport = (
  nodeId: string,
  application: string,
  payload: ReleaseNodePayload,
  artifactPath?: string,
  onParts?: (parts: WorkerReleasePart[]) => void,
) => Promise<ReleaseNodeResult>;

/** Retries after coordinator restart follow the same durable job, never enqueue a second switch. */
export function createReleaseNodeTransport(
  clock = {
    now: () => Date.now(),
    sleep: (ms: number) => delay(ms),
  },
): ReleaseNodeTransport {
  return async (nodeId, application, payload, artifactPath, onParts) => {
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
    // Abort only removes this release's copy, so it is safe to run again. Without this a
    // failed abort (say, from an agent too old to know the job) answers every later
    // recovery with the same failure and the project stays locked.
    if (payload.phase === 'abort')
      requeueFailedAgentJob(job.id, payload as unknown as Record<string, unknown>);
    let lastParts: string | undefined;
    for (;;) {
      const current = getAgentJob(job.id)!;
      const progress = current.progress ? JSON.parse(current.progress) : undefined;
      const parts = JSON.stringify(progress?.parts);
      if (parts !== undefined && parts !== lastParts) {
        onParts?.(progress.parts);
        lastParts = parts;
      }
      if (current.status === 'complete') {
        const result = JSON.parse(current.result || '{}');
        if (typeof result.verified !== 'boolean' || typeof result.phase !== 'string')
          throw new Error('Computer returned an invalid release receipt');
        if (result.parts) onParts?.(result.parts);
        return result;
      }
      if (current.status === 'failed') {
        const result = JSON.parse(current.result || '{}');
        if (result.parts) onParts?.(result.parts);
        throw new Error(current.error || 'Computer release job failed');
      }
      const age = clock.now() - current.createdAt;
      const expired =
        current.status === 'queued' || !progress
          ? age >= 20 * 60_000
          : clock.now() - progress.receivedAt >= 10 * 60_000 || age >= 3 * 60 * 60_000;
      if (expired) {
        const cancelled = cancelQueuedAgentJob(job.id, 'Computer did not claim the release job');
        throw Object.assign(
          new Error(
            'Computer release job has not completed; recovery will follow its durable receipt',
          ),
          { requiresRecovery: !cancelled },
        );
      }
      await clock.sleep(250);
    }
  };
}

export const dispatchReleaseNodeJob = createReleaseNodeTransport();
