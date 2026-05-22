'use client';

import { Link, useLocation } from 'react-flight-router/client';

// Friendly labels for known URL segments. Anything not in this map renders
// the raw segment (deployment names, doc slugs, etc.).
const LABELS: Record<string, string> = {
  dashboard: 'Overview',
  apps: 'Apps',
  activity: 'Activity',
  discover: 'Shared apps',
  settings: 'Settings',
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
]);

interface Crumb {
  label: string;
  href: string;
  current: boolean;
}

/**
 * Auto-derived breadcrumbs from the current pathname. Each segment becomes
 * a link to its prefix; the last segment renders as the current page (no
 * link). Reads naturally for "Dashboard / medius / Overview" — the exact
 * trail Heroku/Vercel show.
 */
export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const crumbs: Crumb[] = [];
  let prefix = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    prefix += '/' + seg;
    if (SKIP.has(seg)) continue;
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
      href: location.pathname,
      current: true,
    });
    // The app-name crumb is no longer current
    crumbs[1].current = false;
  }

  return (
    <nav aria-label="Breadcrumb" className="flex items-center text-sm">
      <ol className="flex items-center gap-1.5 flex-wrap min-w-0">
        {crumbs.map((c, i) => (
          <li key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && (
              <span className="text-text-tertiary/60 select-none" aria-hidden>
                /
              </span>
            )}
            {c.current ? (
              <span className="text-text font-medium truncate">{c.label}</span>
            ) : (
              <Link
                to={c.href}
                className="text-text-tertiary hover:text-text transition-colors truncate"
              >
                {c.label}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
