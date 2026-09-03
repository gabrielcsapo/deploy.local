import { Outlet } from 'react-flight-router/client';
import { MobileSidebar } from '../../components/MobileSidebar';
import { SidebarLink } from '../../components/SidebarLink';
import { DocsJourneyRail } from './DocsJourneyRail.client';

export default function Component() {
  return (
    <div className="docs-shell">
      <header className="docs-mast">
        <div>
          <p className="eyebrow">Operator field guide</p>
          <h1>Documentation</h1>
          <p>Follow an application graph from its first deploy through placement and travel.</p>
        </div>
        <div className="docs-mast-status">
          <span>v1 contract</span>
          <strong>Current</strong>
        </div>
      </header>

      <div className="docs-layout">
        <MobileSidebar variant="docs" ariaLabel="Documentation navigation">
          <nav className="docs-navigation">
            <DocsNavGroup title="Start">
              <SidebarLink to="/docs" end>
                Orientation
              </SidebarLink>
              <SidebarLink to="/docs/deploying">Deploy an application</SidebarLink>
            </DocsNavGroup>

            <DocsNavGroup title="Define and operate">
              <SidebarLink to="/docs/configuration">Application graph</SidebarLink>
              <SidebarLink to="/docs/nodes">Machines and placement</SidebarLink>
              <SidebarLink to="/docs/managing">Operate applications</SidebarLink>
            </DocsNavGroup>

            <DocsNavGroup title="Carry and recover">
              <SidebarLink to="/docs/roadmap">Suitcase workflows</SidebarLink>
              <SidebarLink to="/docs/troubleshooting">Troubleshooting</SidebarLink>
            </DocsNavGroup>

            <DocsNavGroup title="Reference">
              <SidebarLink to="/docs/cli">CLI commands</SidebarLink>
              <SidebarLink to="/docs/architecture">System architecture</SidebarLink>
            </DocsNavGroup>
          </nav>
        </MobileSidebar>

        <main className="docs-content">
          <Outlet />
        </main>

        <DocsJourneyRail />
      </div>
    </div>
  );
}

function DocsNavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      <div>{children}</div>
    </section>
  );
}
