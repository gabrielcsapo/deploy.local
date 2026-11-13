import type {
  Computer,
  ComputerUpdates,
  ComputerUpdateOverview,
  Release,
} from '../../shared/v2/contracts.ts';
import {
  automaticUpdates,
  fleetTarget,
  updateAttempts,
  UPDATE_UNAVAILABLE,
} from './fleet-updates.ts';
import { getNodes, getAgentJob, readDeploymentRecord } from '../store.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { deployDataDirectory } from '../kernel/files/data-directory.ts';
import { COORDINATOR_UNAVAILABLE } from './self-release-runtime.ts';
import { currentProjectReleases } from './releases.ts';
import {
  changesSince,
  findSourceRepository,
  readReleaseConfig,
  runningRevision,
} from './self-update-host.ts';
import { list } from '../workspace/store.ts';

export const UPDATE_INTERVAL_MS = 10 * 60_000;
export function updateState(
  computer: Computer,
  release?: Release,
  targetVersion = release?.apps.find((app) => app.appId === 'deploy.local')?.to,
): ComputerUpdates['computers'][number] {
  const base = { id: computer.id, version: computer.version, targetVersion };
  if (!targetVersion || !computer.version)
    return { ...base, state: 'unavailable', reason: 'Version information is unavailable.' };
  if (computer.version === targetVersion) return { ...base, state: 'current' };
  if (!computer.online)
    return { ...base, state: 'offline', reason: 'Waiting for this computer to connect.' };
  if (computer.doing.some((item) => item.kind === 'task' || item.kind === 'job'))
    return { ...base, state: 'waiting', reason: 'Updates when its task finishes.' };
  if (computer.roles.includes('coordinator'))
    return {
      ...base,
      state: 'unavailable',
      reason: 'Release the deploy.local project to update the coordinator.',
    };
  return {
    ...base,
    state: 'ready',
    reason: 'Idle. An update-capable runtime is required to install this release.',
  };
}
export async function getUpdates(
  owner: string,
  computers: Computer[],
): Promise<ComputerUpdateOverview> {
  const record = currentProjectReleases(owner).find((r) =>
    r.release.apps.some((a) => a.appId === 'deploy.local'),
  );
  // Only a completed Live release is a fleet update target. Failed Watch must not propagate.
  const latestRelease = record?.release.state === 'live' ? record.release : undefined;
  const target = fleetTarget(owner);
  const nodes = getNodes();
  const source = readDeploymentRecord('deploy.local')?.directory;
  const capable =
    source &&
    existsSync(join(source, 'coordinator-build.json')) &&
    existsSync(join(deployDataDirectory(), 'coordinator-updates', 'switch.sock'));
  // A coordinator set up with deploy-update updates itself from main (Computers, deploy.local updates).
  const releaseConfig = readReleaseConfig();
  const selfUpdating = !!releaseConfig;
  const coordinatorRevision = releaseConfig ? runningRevision(releaseConfig) : undefined;
  const ownSource = coordinatorRevision
    ? await findSourceRepository(
        list('project', owner).map((p) => ({ name: p.name, path: p.repositoryPath })),
        coordinatorRevision,
        true,
      )
    : undefined;
  const coordinatorAhead =
    ownSource && coordinatorRevision
      ? (await changesSince(ownSource.path, coordinatorRevision, true)).ahead
      : 0;
  return {
    currentVersion: computers.find((c) => c.roles.includes('coordinator'))?.version,
    latestRelease,
    projectId: record?.release.projectId,
    automatic: automaticUpdates(),
    automaticReason: target ? undefined : UPDATE_UNAVAILABLE,
    coordinatorReason: capable || selfUpdating ? undefined : COORDINATOR_UNAVAILABLE,
    computers: computers.map((computer) => {
      const base = updateState(computer, latestRelease, target?.version);
      const attempt = updateAttempts()
        .filter((row) => row.nodeId === computer.id)
        .at(-1);
      const job = attempt ? getAgentJob(attempt.jobId) : undefined;
      if (job?.status === 'failed' || attempt?.state === 'failed')
        return {
          ...base,
          state: 'failed',
          reason: attempt?.error || job?.error || 'Update failed; the previous build was kept.',
        };
      if (job?.status === 'running')
        return {
          ...base,
          state: 'updating',
          reason:
            Date.now() - (job.claimedAt || job.createdAt) > 180_000
              ? 'Startup confirmation is overdue. New tasks remain paused until this computer reports its installed version.'
              : 'Checking the replacement after restart. New tasks are paused.',
        };
      if (computer.roles.includes('coordinator') && selfUpdating)
        return {
          ...base,
          version: coordinatorRevision?.slice(0, 7) || base.version,
          state: coordinatorAhead ? 'ready' : 'current',
          reason: 'Updates itself from main',
        };
      if (computer.roles.includes('coordinator'))
        return { ...base, reason: capable ? base.reason : COORDINATOR_UNAVAILABLE };
      const node = nodes.find((node) => node.id === computer.id);
      if (!node || JSON.parse(node.capabilities || '{}').selfUpdate !== 1)
        return {
          ...base,
          state: base.state === 'current' ? 'current' : 'unavailable',
          reason: 'This computer needs a worker with supervised updates. Update it manually first.',
        };
      if (!target) return { ...base, state: 'unavailable', reason: UPDATE_UNAVAILABLE };
      return base;
    }),
  };
}

/** Runtime hook: re-read idleness immediately before installation, never interrupt a task. */
export async function followRelease(input: {
  computer: () => Promise<Computer>;
  release: () => Promise<Release | undefined>;
  install: (release: Release) => Promise<void>;
  reserve: () => Promise<(() => Promise<void>) | null>;
}) {
  const release = await input.release();
  if (!release || release.state !== 'live') return false;
  const unlock = await input.reserve();
  if (!unlock) return false;
  try {
    if (updateState(await input.computer(), release).state !== 'ready') return false;
    await input.install(release);
    return true;
  } finally {
    await unlock();
  }
}
