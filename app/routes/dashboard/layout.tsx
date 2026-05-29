import { Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';
import { SidebarLink } from '../../components/SidebarLink';
import { Breadcrumbs } from '../../components/Breadcrumbs';
import {
  DeploymentsIcon,
  DiscoverIcon,
  SettingsIcon,
  OverviewIcon,
  HistoryIcon,
  LogsIcon,
} from '../../components/dashboard/icons';
import { DashboardSidebarTail } from './sidebar-tail.client';
import { DashboardDataShell } from './data.client';
import { UnhealthyAppsDot } from './sidebar-indicators.client';
import { CommandPalette } from './command-palette.client';

export default function Component() {
  // The DashboardDataShell wraps the entire dashboard chrome (sidebar + main)
  // so the sidebar can read fleet state (e.g. surface a red badge on "Apps"
  // when something is unhealthy). Before auth the shell renders the login
  // form full-bleed in place of the dashboard.
  return (
    <DashboardDataShell>
      <div className="flex w-full">
        <MobileSidebar>
          <nav className="flex flex-col h-full">
            <p className="eyebrow mb-2.5">Fleet</p>
            <ul className="flex flex-col gap-1">
              <li>
                <SidebarLink to="/dashboard" end={true} icon={<OverviewIcon />}>
                  Overview
                </SidebarLink>
              </li>
              <li>
                <SidebarLink
                  to="/dashboard/apps"
                  icon={<DeploymentsIcon />}
                  trailing={<UnhealthyAppsDot />}
                >
                  Apps
                </SidebarLink>
              </li>
              <li>
                <SidebarLink
                  to="/dashboard/activity"
                  icon={<HistoryIcon />}
                  hint="Deploys, restarts, and config changes across the fleet"
                >
                  Activity
                </SidebarLink>
              </li>
              <li>
                <SidebarLink
                  to="/dashboard/logs"
                  icon={<LogsIcon />}
                  hint="Live stdout/stderr tail from every container"
                >
                  Logs
                </SidebarLink>
              </li>
              <li>
                <SidebarLink
                  to="/dashboard/discover"
                  icon={<DiscoverIcon />}
                  hint="Apps marked discoverable for guests on your LAN"
                >
                  Shared apps
                </SidebarLink>
              </li>
            </ul>

            <p className="eyebrow mt-6 mb-2.5">Account</p>
            <ul className="flex flex-col gap-1">
              <li>
                <SidebarLink to="/dashboard/settings" icon={<SettingsIcon />}>
                  Settings
                </SidebarLink>
              </li>
            </ul>

            <DashboardSidebarTail />
          </nav>
        </MobileSidebar>
        <main className="flex-1 min-w-0 px-4 sm:px-8 py-6 sm:py-8">
          <div className="mb-5">
            <Breadcrumbs />
          </div>
          <Outlet />
        </main>
      </div>
      <CommandPalette />
    </DashboardDataShell>
  );
}
