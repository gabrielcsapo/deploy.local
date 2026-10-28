/** Shared by server redirects, client redirects and the bookmark regression tests. */
export const staticRedirects: Record<string, string> = {
  '/dashboard/repositories': '/dashboard/projects',
  '/dashboard/apps': '/dashboard/live',
  '/dashboard/activity': '/dashboard/inbox?tab=answered',
  '/dashboard/logs': '/dashboard/live',
  '/dashboard/nodes': '/dashboard/computers',
  '/dashboard/catalog': '/dashboard/discover',
  '/dashboard/catalog/import': '/dashboard/discover/import',
  '/discover': '/',
  '/docs/nodes': '/docs/computers',
  '/docs/managing': '/docs/live',
  '/docs/roadmap': '/docs/ask',
  '/docs/deploying': '/docs/ship',
  '/docs/configuration': '/docs/deploy-yaml',
};
const places = new Set([
  'projects',
  'live',
  'inbox',
  'computers',
  'tasks',
  'agents',
  'settings',
  'discover',
  'design-system',
]);
export function staticRedirect(path: string): string | null {
  const url = new URL(path, 'http://localhost');
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const catalog = pathname.match(/^\/dashboard\/catalog\/([^/]+)$/);
  const target =
    staticRedirects[pathname] || (catalog ? `/dashboard/discover/${catalog[1]}` : null);
  if (!target) return null;
  const destination = new URL(target, url);
  for (const [key, value] of url.searchParams)
    if (!destination.searchParams.has(key)) destination.searchParams.append(key, value);
  return destination.pathname + destination.search + url.hash;
}

export async function legacyDestination(
  path: string,
  projectForApplication: (application: string) => Promise<string | null>,
): Promise<string | null> {
  const direct = staticRedirect(path);
  if (direct) return direct;
  const url = new URL(path, 'http://localhost');
  const match = url.pathname
    .replace(/\/+$/, '')
    .match(/^\/dashboard\/([^/]+)(?:\/(releases|logs|build|traffic|settings))?$/);
  if (!match || places.has(match[1])) return null;
  let application: string;
  try {
    application = decodeURIComponent(match[1]);
  } catch {
    return '/dashboard/live';
  }
  const project = await projectForApplication(application);
  if (!project) return '/dashboard/live';
  const base = `/dashboard/projects/${encodeURIComponent(project)}`;
  const app = `${base}/apps/${encodeURIComponent(application)}`;
  const target =
    match[2] === 'releases'
      ? `${base}/releases`
      : match[2] === 'logs' || match[2] === 'build'
        ? `${base}/logs`
        : match[2] === 'settings'
          ? `${app}/settings`
          : app;
  if (match[2] === 'logs' || match[2] === 'build') url.searchParams.set('app', application);
  return target + url.search + url.hash;
}

export async function lookupApplicationProject(
  application: string,
  request: typeof fetch = fetch,
  init: RequestInit = {},
): Promise<string | null> {
  const query = `?application=${encodeURIComponent(application)}`;
  try {
    let response = await request(`/api/application-repositories${query}`, init);
    // The existing coordinator mounts this resource under /api/workspace.
    if (response.status === 404)
      response = await request(`/api/workspace/application-repositories${query}`, init);
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('projects' in data) || !Array.isArray(data.projects))
      return null;
    const project = data.projects.find(
      (entry: unknown) =>
        entry &&
        typeof entry === 'object' &&
        'id' in entry &&
        typeof entry.id === 'string' &&
        entry.id.length > 0,
    );
    return project?.id || null;
  } catch {
    return null;
  }
}

/** Apply before the host's RSC/SSR handler; the router itself renders redirects as HTTP 200. */
export async function permanentRedirectResponse(
  request: Request,
  projectForApplication: (application: string) => Promise<string | null>,
): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const destination = await legacyDestination(request.url, projectForApplication);
  return destination
    ? new Response(null, { status: 308, headers: { Location: destination } })
    : null;
}
