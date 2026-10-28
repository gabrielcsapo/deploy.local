import Settings from '../../../../app/routes/dashboard/v2/settings/page.client';
import Projects from '../../../../app/routes/dashboard/v2/projects/page.client';
import '../../../../app/routes/dashboard/v2/agents/style.css';
import { createRoot } from 'react-dom/client';
import { InboxProvider } from '../../../../app/routes/dashboard/v2/data/hooks';
import { V2Sidebar } from '../../../../app/routes/dashboard/v2-layout.client';
import Inbox from '../../../../app/routes/dashboard/v2/inbox/page.client';
import Live from '../../../../app/routes/dashboard/v2/live/page.client';
import Releases from '../../../../app/routes/dashboard/v2/releases/page.client';
import Backups from '../../../../app/routes/dashboard/v2/settings/backups/page.client';
import Start from '../../../../app/routes/dashboard/v2/start/page.client';
import Task from '../../../../app/routes/dashboard/v2/tasks/page.client';
import Public from '../../../../app/routes/v2-public/page.client';
import About from '../../../../app/routes/v2-public/about/page';
import '../../../../app/design-tokens.css';
import '../../../../app/routes/dashboard/v2-shell.css';
const path = location.pathname;
localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: 'gabriel', token: 'fixture' }));
localStorage.removeItem('deploy-v2-first-task-seen');
const sidebar: any = {
  inbox: {
    items: [
      {
        id: 'rollback',
        title: 'Roll back home-gym?',
        state: 'waiting',
        createdAt: new Date().toISOString(),
      },
      { id: 'merge', title: 'Merge PR #18', state: 'waiting', createdAt: new Date().toISOString() },
    ],
    loading: false,
  },
  workspace: {
    data: {
      projects: [],
      tasks: [
        { id: 'first', title: 'Self-release pipeline', updatedAt: new Date().toISOString() },
        { id: 'launch', title: 'Bazzite app launch', updatedAt: new Date().toISOString() },
      ],
      runs: [],
    },
    loading: false,
  },
  agents: {
    data: {
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    },
  },
  live: {
    data: {
      summary: {
        running: 7,
        failing: new URLSearchParams(location.search).get('board') === 'AutoRollback' ? 0 : 1,
      },
    },
  },
  user: { data: { username: 'Gabriel' } },
  computers: { data: { nodes: [{ online: true }, { online: true }, { online: true }] } },
};
const content =
  path === '/dashboard/settings/approvals' ? (
    <Settings />
  ) : path.includes('/projects/') && path.includes('/settings') ? (
    <Projects />
  ) : path === '/dashboard/inbox' ? (
    <Inbox />
  ) : path.startsWith('/dashboard/live') ? (
    <Live />
  ) : path.includes('/releases') ? (
    <Releases />
  ) : path.includes('/backups') ? (
    <Backups />
  ) : path.startsWith('/dashboard/tasks') ? (
    <Task />
  ) : (
    <Start />
  );
createRoot(document.getElementById('root')!).render(
  path === '/about' ? (
    <About />
  ) : path === '/' || path === '/signin' ? (
    <Public />
  ) : (
    <InboxProvider>
      <div className="dl-app">
        <V2Sidebar pathname={path} data={sidebar} />
        <main className="dl-main">{content}</main>
      </div>
    </InboxProvider>
  ),
);
