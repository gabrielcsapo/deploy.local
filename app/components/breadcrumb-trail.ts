const LABELS: Record<string, string> = {
  dashboard: 'Workspace',
  apps: 'Applications',
  nodes: 'Computers',
  computers: 'Computers',
  projects: 'Projects',
  repositories: 'Repositories',
  import: 'Import',
  releases: 'Deployments',
  traffic: 'Activity',
  catalog: 'Catalog',
  activity: 'Activity',
  discover: 'Shared apps',
  settings: 'Settings',
  'design-system': 'Design system',
  docs: 'Docs',
  changelog: 'Changelog',
  // Per-app tabs
  overview: 'Overview',
  build: 'Build',
  logs: 'Logs',
  terminal: 'Terminal',
  requests: 'Requests',
  resources: 'Resources',
  history: 'Activity',
};

// Segments that contribute to the trail but don't render their own crumb.
const SKIP: Set<string> = new Set();

// Reserved second-level dashboard segments (i.e. real routes, not apps).
// Anything not in this set under /dashboard is treated as an app slug — that
// distinction matters for the implicit-"Overview" trailing crumb below.
const DASHBOARD_RESERVED: Set<string> = new Set([
  'apps',
  'activity',
  'logs',
  'discover',
  'settings',
  'projects',
  'repositories',
  'nodes',
  'computers',
  'catalog',
  'design-system',
]);

interface Crumb {
  label: string;
  href: string;
  current: boolean;
}

export function dashboardBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return [];

  const crumbs: Crumb[] = [];
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    prefix += '/' + seg;
    if (SKIP.has(seg) || (i === 0 && ['computers', 'nodes'].includes(segments[1]))) continue;
    crumbs.push({
      label: LABELS[seg] ?? seg,
      href: prefix,
      current: i === segments.length - 1,
    });
  }

  // Detail-page child routes (e.g. /dashboard/medius without an explicit tab
  // segment) map to "Overview" as the trailing crumb so the URL bar matches
  // what the user sees on screen. Only applies when the 2nd segment is an
  // app slug, not a reserved fleet-level route like /dashboard/apps.
  if (
    segments.length === 2 &&
    segments[0] === 'dashboard' &&
    !DASHBOARD_RESERVED.has(segments[1])
  ) {
    crumbs.push({
      label: 'Overview',
      href: pathname,
      current: true,
    });
    // The app-name crumb is no longer current
    crumbs[1].current = false;
  }

  return crumbs;
}
