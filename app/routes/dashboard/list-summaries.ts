import type { Computer } from '../../../server/computer-roles';

export function computerRoleSummary(
  computer: Pick<Computer, 'online' | 'roles' | 'update'>,
): string {
  const summary = roleSummary(computer);
  return computer.update && computer.update.state !== 'current'
    ? `${summary.split(' · ')[0]} · Update available`
    : summary;
}
function roleSummary(computer: Pick<Computer, 'online' | 'roles'>): string {
  if (!computer.online) return 'Offline';
  const roles = Object.entries(computer.roles).filter(([id]) => id !== 'coordinator');
  if (!roles.length) return 'Roles unavailable';
  const ready = roles.filter(([, role]) => role.state === 'ready').length;
  if (ready === 4) return 'All roles ready';
  const needsSetup = roles.some(([, role]) => role.state === 'needs-setup');
  const paused = roles.some(([, role]) => role.state === 'paused');
  return [
    `${ready} ${ready === 1 ? 'role' : 'roles'} ready`,
    needsSetup ? 'Setup needed' : paused ? 'Paused' : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function repositorySecondary(project: {
  description?: string | null;
  sourcePath?: string | null;
}): string {
  if (project.description?.trim()) return project.description;
  if (!project.sourcePath) return 'Hosted on deploy.local';
  try {
    const url = new URL(project.sourcePath);
    if (['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) && url.hostname)
      return `Imported from ${url.hostname}`;
  } catch {
    /* Git also accepts scp-style remotes and local imports. */
  }
  const host = project.sourcePath.match(/^(?:[^/@\s]+@)([^/:\s]+):/);
  return host ? `Imported from ${host[1]}` : 'Hosted on deploy.local';
}
