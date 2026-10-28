import type { Computer, ComputerUpdates, Release } from '../../shared/v2/contracts.ts';
import { currentProjectReleases } from './releases.ts';

export const UPDATE_INTERVAL_MS = 10 * 60_000;
export function updateState(
  computer: Computer,
  release?: Release,
): ComputerUpdates['computers'][number] {
  const targetVersion = release?.apps.find((app) => app.appId === 'deploy.local')?.to;
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
export function getUpdates(owner: string, computers: Computer[]): ComputerUpdates {
  const record = currentProjectReleases(owner).find((r) =>
    r.release.apps.some((a) => a.appId === 'deploy.local'),
  );
  // Only a completed Live release is a fleet update target. Failed Watch must not propagate.
  const latestRelease = record?.release.state === 'live' ? record.release : undefined;
  return {
    currentVersion: computers.find((c) => c.roles.includes('coordinator'))?.version,
    latestRelease,
    projectId: record?.release.projectId,
    automatic: false,
    computers: computers.map((computer) => updateState(computer, latestRelease)),
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
