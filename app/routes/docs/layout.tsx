import { Link, Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';

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
              <Link
                to="/docs"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Introduction
              </Link>
            </li>
            <li>
              <Link
                to="/docs/deploying"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Deploying Apps
              </Link>
            </li>
            <li>
              <Link
                to="/docs/configuration"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Configuration
              </Link>
            </li>
          </ul>

          <p className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
            Reference
          </p>
          <ul className="flex flex-col gap-1">
            <li>
              <Link
                to="/docs/cli"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                CLI
              </Link>
            </li>
            <li>
              <Link
                to="/docs/architecture"
                className="block text-sm text-text-secondary hover:text-text px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
              >
                Architecture
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
