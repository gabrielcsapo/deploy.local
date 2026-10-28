import { randomUUID } from 'node:crypto';
import { db, list, save } from '../workspace/store.ts';
import { enqueueAgentJob, getAgentJob, getNodes, completeAgentJob, isAdmin } from '../store.ts';
import { readCliManifest } from '../cli-download.ts';
import { currentProjectReleases } from './releases.ts';
import {
  releaseComputerUpdate,
  updateReservation,
  withUpdateAdmission,
} from './update-admission.ts';
import { fail } from './inbox.ts';

export const UPDATE_INTERVAL_MS = 10 * 60_000;
export const UPDATE_UNAVAILABLE =
  'No verified coordinator release is available for automatic updates.';
export function automaticUpdates() {
  return list('v2-update-settings', 'system')[0]?.automatic === true;
}
export function setAutomaticUpdates(owner: string, value: unknown) {
  if (!isAdmin(owner)) fail('Administrator access is required to change updates', 403);
  if (typeof value !== 'boolean') fail('automatic must be a boolean');
  save('v2-update-settings', 'system', { id: 'fleet', automatic: value });
}
export function updateAttempts() {
  return list('v2-update-attempt', 'system');
}
export function fleetTarget(owner: string) {
  const record = currentProjectReleases(owner).find((row) =>
    row.release.apps.some((app) => app.appId === 'deploy.local'),
  );
  // A container named deploy.local is not proof that the coordinator itself switched.
  const runtime = record?.plan?.runtime as
    | { kind?: string; version?: string; id?: string }
    | undefined;
  if (record?.release.state !== 'live' || runtime?.kind !== 'coordinator-self-release') return;
  const receipt = list('v2-coordinator-activation', 'system').find((row) => row.id === runtime.id);
  if (receipt?.state !== 'activated' || receipt.version !== runtime.version) return;
  return { release: record.release, version: runtime.version! };
}
export function produceComputerUpdates(owner: string, manifest = readCliManifest()) {
  if (!automaticUpdates()) return;
  const target = fleetTarget(owner);
  if (!target || !manifest || manifest.version !== target.version) return;
  for (const node of getNodes()) {
    const capabilities = JSON.parse(node.capabilities || '{}');
    if (
      node.id === 'coordinator' ||
      node.revokedAt ||
      !node.online ||
      capabilities.selfUpdate !== 1 ||
      !node.agentVersion ||
      node.agentVersion === target.version
    )
      continue;
    const build = manifest.targets[`${node.platform}-${node.architecture}`];
    if (!build || !['darwin', 'linux'].includes(node.platform || '')) continue;
    const id = `${node.id}:${target.release.id}`;
    if (updateAttempts().some((row) => row.id === id)) continue;
    const jobId = `update_${randomUUID()}`;
    // Persist intent first. Recovery reuses this exact job id if enqueue was interrupted.
    const attempt = {
      id,
      nodeId: node.id,
      jobId,
      releaseId: target.release.id,
      targetVersion: target.version,
      previousVersion: node.agentVersion,
      sha256: build.sha256,
      size: build.size,
      nonce: randomUUID(),
      state: 'queued',
      createdAt: Date.now(),
    };
    save('v2-update-attempt', 'system', attempt);
  }
  for (const attempt of updateAttempts().filter((row) => row.state === 'queued')) {
    if (attempt.targetVersion !== target.version) continue;
    enqueueAgentJob({
      id: attempt.jobId,
      nodeId: attempt.nodeId,
      type: 'self-update',
      deploymentName: 'deploy.local',
      payload: attempt,
    });
  }
}
/** Called only after authenticating the reporting computer. A generic job success is insufficient. */
export function reportComputerUpdate(nodeId: string, report: any, version?: string) {
  if (!report || !['complete', 'failed'].includes(report.state)) return;
  withUpdateAdmission(() => {
    const reservation = updateReservation(nodeId);
    if (!reservation || reservation.jobId !== report.jobId) return;
    const job = getAgentJob(report.jobId);
    if (
      !job ||
      job.type !== 'self-update' ||
      job.nodeId !== nodeId ||
      !['running', report.state].includes(job.status)
    )
      return;
    const payload = updateAttempts().find(
      (attempt) => attempt.jobId === job.id && attempt.nodeId === nodeId,
    );
    if (!payload) return;
    if (report.nonce !== payload.nonce) return;
    const expected = report.state === 'complete' ? payload.targetVersion : payload.previousVersion;
    if (!version || version !== expected || report.version !== expected) return;
    completeAgentJob(job.id, nodeId, {
      success: report.state === 'complete',
      result: { version },
      error:
        report.state === 'failed'
          ? String(report.error || 'Update failed; previous build restored.').slice(0, 500)
          : undefined,
    });
    save('v2-update-attempt', 'system', {
      ...payload,
      state: report.state,
      error:
        report.state === 'failed'
          ? String(report.error || 'Update failed; previous build restored.').slice(0, 500)
          : undefined,
    });
    releaseComputerUpdate(nodeId, job.id);
  });
}
export function rejectComputerUpdateJob(jobId: string, nodeId: string, reason: string) {
  const job = getAgentJob(jobId);
  if (job?.type !== 'self-update') return false;
  reportComputerUpdate(
    nodeId,
    {
      ...JSON.parse(job.payload),
      jobId,
      state: 'failed',
      version: JSON.parse(job.payload).previousVersion,
      error: reason,
    },
    JSON.parse(job.payload).previousVersion,
  );
  return true;
}
let scheduler: ReturnType<typeof setInterval> | undefined;
export function startComputerUpdateScheduler() {
  if (scheduler) return;
  const tick = () => {
    try {
      for (const row of db
        .prepare("SELECT DISTINCT owner FROM records WHERE kind='v2-project-current'")
        .all() as { owner: string }[])
        produceComputerUpdates(row.owner);
    } catch (error) {
      console.error('[updates] Scheduler failed', error);
    }
  };
  scheduler = setInterval(tick, UPDATE_INTERVAL_MS);
  scheduler.unref();
  tick();
}
