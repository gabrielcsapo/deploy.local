'use client';

import { Link, Outlet, useLocation } from 'react-flight-router/client';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import { DashboardDataShell } from './data.client';
import { CommandPalette } from './command-palette.client';

/**
 * Keeps every dashboard context consumer in the same client boundary as its
 * provider. Server-authored child slots can be hydrated independently by the
 * Flight runtime, so the chrome and Outlet must be constructed here rather
 * than passed through DashboardDataShell from the server layout.
 */
export function DashboardLayoutClient() {
  return (
    <DashboardDataShell>
      <DashboardFrame />
      <CommandPalette />
    </DashboardDataShell>
  );
}

function DashboardFrame() {
  const { pathname } = useLocation();
  const commandCenter = pathname === '/dashboard' || pathname === '/dashboard/';
  const segments = pathname.split('/').filter(Boolean);
  const reserved = new Set([
    'apps',
    'activity',
    'logs',
    'discover',
    'settings',
    'sites',
    'nodes',
    'catalog',
  ]);
  const applicationDetail =
    segments[0] === 'dashboard' && Boolean(segments[1]) && !reserved.has(segments[1]);
  const catalogWorkspace = segments[0] === 'dashboard' && segments[1] === 'catalog';

  return (
    <div
      className={`dashboard-shell dashboard-shell-rail-free ${commandCenter ? 'is-command-center' : ''}`}
    >
      <main className="dashboard-canvas">
        <div className="dashboard-viewport">
          {!commandCenter && !applicationDetail && !catalogWorkspace ? (
            <div className="dashboard-breadcrumbs dashboard-location-bar">
              <Link to="/dashboard" className="dashboard-graph-return">
                <span aria-hidden>←</span>
                Command center
              </Link>
              <Breadcrumbs />
              <button
                type="button"
                className="dashboard-location-command"
                onClick={() => window.dispatchEvent(new CustomEvent('deploy:command-palette'))}
              >
                Commands <kbd>⌘K</kbd>
              </button>
            </div>
          ) : null}
          <Outlet />
        </div>
      </main>
    </div>
  );
}
