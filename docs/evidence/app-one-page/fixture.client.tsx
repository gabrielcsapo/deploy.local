import { createRoot } from 'react-dom/client';
import { InboxProvider } from '../../../app/routes/dashboard/v2/data/hooks';
import { V2Sidebar } from '../../../app/routes/dashboard/v2-layout.client';
import Projects from '../../../app/routes/dashboard/v2/projects/page.client';
import Live from '../../../app/routes/dashboard/v2/live/page.client';
import Releases from '../../../app/routes/dashboard/v2/releases/page.client';
import Computers from '../../../app/routes/dashboard/v2/computers/page.client';
import { AppRequests } from '../../../app/routes/dashboard/v2/projects/requests.client';
import { DetailTemplate } from '../../../app/components/ui/v2/Templates';
import '../../../app/routes/dashboard/v2/projects/projects.css';
import '../../../app/design-tokens.css';
import '../../../app/routes/dashboard/v2-shell.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: 'Gabriel', token: 'fixture' }));
const path = location.pathname;
const sidebar: any = {
  inbox: { items: [], loading: false },
  workspace: { data: { projects: [], tasks: [], runs: [] }, loading: false },
  agents: { data: { agents: [] } },
  live: { data: { summary: { running: 7, failing: 1 } } },
  user: { data: { username: 'Gabriel' } },
  computers: { data: { nodes: [{ online: true }] } },
  packages: { data: null },
  desktopUpdate: {},
};
createRoot(document.getElementById('root')!).render(
  <InboxProvider>
    <div className="dl-app">
      <V2Sidebar pathname={path} data={sidebar} />
      <main className="dl-main">
        {path.startsWith('/dashboard/live') ? (
          <Live />
        ) : path.startsWith('/dashboard/app-requests') ? (
          // The project page's tabs need the real router; this shows the Requests tab's own content.
          <DetailTemplate
            title="forma"
            parent={{ label: 'Projects', href: '/dashboard/projects' }}
            className="v2-project-page v2-project-detail"
          >
            <AppRequests
              app="forma"
              address="https://forma.deploy.local"
              base="/dashboard/app-requests"
            />
          </DetailTemplate>
        ) : path.startsWith('/dashboard/computers') ? (
          <Computers />
        ) : path.includes('/releases') ? (
          <Releases />
        ) : (
          <Projects />
        )}
      </main>
    </div>
  </InboxProvider>,
);
