'use client';

import { useLocation } from 'react-flight-router/client';
import { AppSwitcher } from '../../components/dashboard/AppSwitcher';

/**
 * Detects when the user is inside /dashboard/:name/* and renders the
 * AppSwitcher quick picker below the main nav. Kept as a separate
 * client component so the parent layout can stay server-rendered.
 */
export function DashboardSidebarTail() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'dashboard') return null;
  const second = segments[1];
  // Reserved subroutes that aren't apps
  if (
    second === 'discover' ||
    second === 'settings' ||
    second === 'apps' ||
    second === 'activity' ||
    second === 'logs'
  )
    return null;
  return <AppSwitcher current={second} />;
}
