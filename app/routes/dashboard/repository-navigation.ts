export const repositorySections = [
  'repository',
  'issues',
  'pulls',
  'pipelines',
  'deployment',
  'settings',
] as const;
export type RepositorySection = (typeof repositorySections)[number];

export function repositoryURL(projectId: string, section: string = 'repository') {
  return `/dashboard/repositories/${encodeURIComponent(projectId)}${section === 'repository' ? '' : '/' + section}`;
}

export function repositoryRoute(pathname: string) {
  const parts = pathname.replace(/\/$/, '').split('/');
  if (parts[1] !== 'dashboard' || parts[2] !== 'repositories') return null;
  if (parts.length === 3)
    return { projectId: '', section: 'repository' as RepositorySection, valid: true };
  try {
    const projectId = decodeURIComponent(parts[3]);
    const section = parts[4] || 'repository';
    return {
      projectId,
      section: section as RepositorySection,
      valid:
        parts.length <= 5 &&
        !!projectId &&
        !projectId.includes('/') &&
        repositorySections.includes(section as RepositorySection),
    };
  } catch {
    return { projectId: '', section: 'repository' as RepositorySection, valid: false };
  }
}
