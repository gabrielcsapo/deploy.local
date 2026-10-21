'use client';

import { Link, useLocation } from 'react-flight-router/client';
import { WorkspaceIcon } from '../routes/dashboard/workspace-icon';

import { dashboardBreadcrumbs } from './breadcrumb-trail';

export function Breadcrumbs() {
  const location = useLocation();
  const crumbs = dashboardBreadcrumbs(location.pathname);
  if (!crumbs.length) return null;

  return (
    <nav aria-label="Breadcrumb" className="ds-breadcrumb">
      <ol className="flex items-center gap-1.5 flex-wrap min-w-0">
        {crumbs.map((c, i) => (
          <li key={i} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <WorkspaceIcon name="chevron" className="ds-breadcrumb-separator" />}
            {c.current || c.href === '/dashboard' ? (
              <span className="truncate font-medium text-text-secondary">{c.label}</span>
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
