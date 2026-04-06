import { Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';
import { SidebarLink } from '../../components/SidebarLink';

export default function Component() {
  return (
    <div className="max-w-7xl mx-auto px-6 flex gap-10 py-8">
      <MobileSidebar>
        <nav>
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Dashboard
          </p>
          <ul className="flex flex-col gap-1">
            <li>
              <SidebarLink to="/dashboard" end={true}>
                Deployments
              </SidebarLink>
            </li>
            <li>
              <SidebarLink to="/dashboard/discover">Discover</SidebarLink>
            </li>
            <li>
              <SidebarLink to="/dashboard/settings">Settings</SidebarLink>
            </li>
          </ul>
        </nav>
      </MobileSidebar>
      <main className="flex-1 min-w-0">
        <Outlet />
      </main>
    </div>
  );
}
