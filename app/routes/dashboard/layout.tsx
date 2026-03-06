import { Link, Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';

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
              <Link
                to="/dashboard"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Deployments
              </Link>
            </li>
            <li>
              <Link
                to="/dashboard/settings"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Settings
              </Link>
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
