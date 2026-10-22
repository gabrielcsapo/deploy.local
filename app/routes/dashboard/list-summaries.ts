import type { Computer } from '../../../server/computer-roles';

const labels = {
  deploy: 'Deploy apps',
  tasks: 'Coding tasks',
  computer: 'Screen access',
  browser: 'Task browser',
};
export function computerRoleSummary(computer: Pick<Computer, 'online' | 'roles'>): string {
  if (!computer.online) return 'Offline';
  const roles = Object.entries(computer.roles).filter(([id]) => id !== 'coordinator');
  if (!roles.length) return 'Roles unavailable';
  const ready = roles.filter(([, role]) => role.state === 'ready').length;
  if (ready === Object.keys(labels).length) return 'All roles ready';
  const attention = roles
    .filter(([, role]) => role.state === 'needs-setup' || role.state === 'paused')
    .map(
      ([id, role]) =>
        `${labels[id as keyof typeof labels]} ${role.state === 'paused' ? 'paused' : 'needs setup'}`,
    );
  return [`${ready} ${ready === 1 ? 'role' : 'roles'} ready`, ...attention].join(' · ');
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
