import { Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';
import { SidebarLink } from '../../components/SidebarLink';

export default function Component() {
  return (
    <div className="max-w-7xl mx-auto px-6 flex gap-10 py-8">
      <MobileSidebar>
        <nav className="sticky top-8">
          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Getting Started
          </p>
          <ul className="flex flex-col gap-1 mb-6">
            <li>
              <SidebarLink to="/docs" end={true}>
                Introduction
              </SidebarLink>
            </li>
            <li>
              <SidebarLink to="/docs/deploying">Deploying Apps</SidebarLink>
            </li>
            <li>
              <SidebarLink to="/docs/managing">Managing Deployments</SidebarLink>
            </li>
            <li>
              <SidebarLink to="/docs/configuration">Configuration</SidebarLink>
            </li>
          </ul>

          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Reference
          </p>
          <ul className="flex flex-col gap-1 mb-6">
            <li>
              <SidebarLink to="/docs/cli">CLI</SidebarLink>
            </li>
            <li>
              <SidebarLink to="/docs/architecture">Architecture</SidebarLink>
            </li>
          </ul>

          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Help
          </p>
          <ul className="flex flex-col gap-1">
            <li>
              <SidebarLink to="/docs/troubleshooting">Troubleshooting</SidebarLink>
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
