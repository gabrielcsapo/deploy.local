import { repositoryAddress, reservedRepositoryAddress } from '../../../shared/repository-address';

export const repositorySections = [
  'repository',
  'issues',
  'pulls',
  'pipelines',
  'deployment',
  'settings',
] as const;
export type RepositorySection = (typeof repositorySections)[number];

// Workspace rows are loosely typed, so every field is optional here.
type RepositoryLink = string | { id?: string; name?: string; address?: string | null };

/**
 * A repository row links to its short address (`/<repo>`); a bare id keeps the id route, which
 * the repository page then rewrites to the short address once it knows the name.
 */
export function repositoryURL(project: RepositoryLink, section: string = 'repository') {
  const suffix = section === 'repository' ? '' : '/' + section;
  // The server's `address` accounts for older repositories that share one; rows without it
  // (e.g. just created) derive it from the name.
  const address =
    typeof project === 'string'
      ? null
      : project.address !== undefined
        ? project.address
        : repositoryAddress(project.name);
  if (address) return `/${encodeURIComponent(address)}${suffix}`;
  const id = typeof project === 'string' ? project : (project.id ?? '');
  return `/dashboard/repositories/${encodeURIComponent(id)}${suffix}`;
}

export function repositoryRoute(pathname: string): {
  projectId: string;
  address?: string;
  section: RepositorySection;
  valid: boolean;
} | null {
  const parts = pathname.replace(/\/$/, '').split('/');
  if (parts[1] !== 'dashboard') return repositoryAddressRoute(parts);
  if (parts[2] !== 'repositories') return null;
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

/** `/<repo>` and `/<repo>/<section>`; reserved first segments belong to deploy.local pages. */
function repositoryAddressRoute(parts: string[]) {
  if (!parts[1]) return null;
  let address: string;
  try {
    address = decodeURIComponent(parts[1]);
  } catch {
    return null;
  }
  if (reservedRepositoryAddress(address)) return null;
  const section = parts[2] || 'repository';
  return {
    projectId: '',
    address,
    section: section as RepositorySection,
    valid: parts.length <= 3 && repositorySections.includes(section as RepositorySection),
  };
}

/** The `/dashboard/...` form of a workspace path, for section checks written against it. */
export function dashboardPathname(pathname: string) {
  return repositoryRoute(pathname)?.address
    ? '/dashboard/repositories' + pathname.replace(/\/$/, '')
    : pathname;
}

/** Workspace pages: everything under `/dashboard` plus repository short addresses. */
export function workspacePath(pathname: string) {
  return pathname.startsWith('/dashboard') || repositoryRoute(pathname) !== null;
}
