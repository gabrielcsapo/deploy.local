/**
 * Short repository addresses: `deploy.local/<repo>` opens a repository and
 * `deploy.local/<repo>.git` clones it. The address is derived from the repository
 * name, matched without regard to case, and never shadows a deploy.local page.
 */

/** First path segments deploy.local already serves, so no repository can claim them. */
export const reservedRepositoryAddresses = new Set([
  'api',
  'apps',
  'assets',
  'ca.crt',
  'changelog',
  'cli',
  'dashboard',
  'discover',
  'docs',
  'favicon.ico',
  'favicon.svg',
  'fonts',
  'git',
  'health',
  'install',
  'login',
  'logout',
  'new',
  'settings',
  'site.webmanifest',
  'ws',
]);

/** A folder-safe form of the repository name, used for clone folders and short addresses. */
export function repositoryFolderName(name: unknown) {
  const folder = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return folder || 'repository';
}

export function reservedRepositoryAddress(segment: string) {
  const key = segment.toLowerCase();
  return (
    reservedRepositoryAddresses.has(key) ||
    key.startsWith('_') ||
    key.endsWith('.git') ||
    /\.(?:png|svg|ico|txt|json|js|css|webmanifest|xml)$/.test(key)
  );
}

/** The repository's short address segment, or null when its name maps onto a reserved one. */
export function repositoryAddress(name: unknown) {
  const folder = repositoryFolderName(name);
  return reservedRepositoryAddress(folder) ? null : folder;
}

export function sameRepositoryAddress(name: unknown, segment: string) {
  const address = repositoryAddress(name);
  return !!address && address.toLowerCase() === segment.toLowerCase();
}

type AddressedRepository = { id: string; name: string; previousAddresses?: string[] };

/** The repository a short address names: a current name first, then one renamed away from it. */
export function projectAtAddress<T extends AddressedRepository>(projects: T[], segment: string) {
  const current = projects.filter((project) => sameRepositoryAddress(project.name, segment));
  if (current.length) return current.length === 1 ? current[0] : null;
  const key = segment.toLowerCase();
  const renamed = projects.filter((project) => project.previousAddresses?.includes(key));
  return renamed.length === 1 ? renamed[0] : null;
}

/** The short address for this repository when it is the one that address resolves to. */
export function uniqueRepositoryAddress<T extends AddressedRepository>(projects: T[], project: T) {
  const address = repositoryAddress(project.name);
  return address && projectAtAddress(projects, address)?.id === project.id ? address : null;
}

const gitTransport =
  /^\/(?:info\/refs|git-upload-pack|git-receive-pack|HEAD|objects\/.+|info\/lfs\/.+)$/;

/**
 * Recognize Git's smart-HTTP requests against a short address: `/<repo>.git/...`, and
 * `/<repo>/info/refs` etc. for clones of `deploy.local/<repo>` without the suffix.
 * Returns the repository segment and the transport path, or null for anything else.
 */
export function shortGitRequest(pathname: string) {
  const match = pathname.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const segment = decodeSegment(match[1]);
  const rest = match[2] ?? '';
  const named = segment.toLowerCase().endsWith('.git');
  const repository = named ? segment.slice(0, -4) : segment;
  if (!repository || reservedRepositoryAddress(repository)) return null;
  if (named ? rest !== '' && !gitTransport.test(rest) : !gitTransport.test(rest)) return null;
  return { repository, transport: rest };
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return '';
  }
}
