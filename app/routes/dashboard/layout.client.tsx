'use client';
import { WorkspaceTitleBar, dashboardSection } from './workspace-title-bar.client';

import { Suspense } from 'react';
import { LoadingState } from '../../components/LoadingState';
import { Outlet, useLocation } from 'react-flight-router/client';
import ProjectsClient from './projects.client';
import './workspace.css';
import { DashboardDataShell } from './data.client';
import { CommandPalette } from './command-palette.client';

/**
 * Keeps every dashboard context consumer in the same client boundary as its
 * provider. Server-authored child slots can be hydrated independently by the
 * Flight runtime, so the chrome and Outlet must be constructed here rather
 * than passed through DashboardDataShell from the server layout.
 */
export function DashboardLayoutClient() {
  const { pathname } = useLocation();
  // Embedded pages bring their own minimal frame and read everything over the API.
  if (pathname.startsWith('/dashboard/embed/'))
    return (
      <Suspense fallback={<LoadingState />}>
        <Outlet />
      </Suspense>
    );
  const showingSurface =
    !pathname.startsWith('/dashboard/repositories/') &&
    !['/dashboard', '/dashboard/', '/dashboard/projects', '/dashboard/repositories'].includes(
      pathname,
    );
  return (
    <>
      <ProjectsClient
        surface={
          showingSurface ? (
            <DashboardDataShell>
              <DashboardFrame />
              <CommandPalette />
            </DashboardDataShell>
          ) : undefined
        }
      />
      {!showingSurface && (
        <DashboardDataShell chrome={false}>
          <CommandPalette />
        </DashboardDataShell>
      )}
    </>
  );
}

function DashboardFrame() {
  const { pathname } = useLocation();
  const commandCenter = pathname === '/dashboard' || pathname === '/dashboard/';
  const segments = pathname.split('/').filter(Boolean);
  const reserved = new Set([
    'projects',
    'repositories',
    'apps',
    'activity',
    'logs',
    'discover',
    'settings',
    'nodes',
    'computers',
    'catalog',
    'design-system',
  ]);
  const applicationDetail =
    segments[0] === 'dashboard' && Boolean(segments[1]) && !reserved.has(segments[1]);

  return (
    <div
      className={`dashboard-shell dashboard-shell-rail-free ${commandCenter ? 'is-command-center' : ''}`}
    >
      <main className="dashboard-canvas">
        <div className="dashboard-viewport">
          {!commandCenter && !applicationDetail ? (
            <WorkspaceTitleBar className="desktop-only" {...dashboardSection(pathname)} />
          ) : null}
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
