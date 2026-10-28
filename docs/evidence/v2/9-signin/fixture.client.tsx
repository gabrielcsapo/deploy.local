import { createRoot } from 'react-dom/client';
import PublicPage from '../../../../app/routes/v2-public/page.client';
import Start, { FirstTask } from '../../../../app/routes/dashboard/v2/start/page.client';
import Account, {
  PasskeyOffer,
  SessionExpired,
} from '../../../../app/routes/dashboard/v2/start/account.client';
import Home from '../../../../app/routes/dashboard/v2-home.client';
import { V2Sidebar } from '../../../../app/routes/dashboard/v2-layout.client';
import { Head, Composer, WorkLog, Tabs } from '../../../../app/components/ui';
import '../../../../app/design-tokens.css';
import '../../../../app/routes/dashboard/v2-shell.css';
const board = new URLSearchParams(location.search).get('board') || 'FirstAccount';
const paths: Record<string, string> = {
  FirstAccount: '/setup',
  WebSignIn: '/signin',
  CliLogin: '/signin',
  RecoverWeb: '/recover',
  AppsHome: '/',
  AppsHomePhone: '/',
  Welcome: '/dashboard/start',
  NewProject: '/dashboard/start/project',
  InstallApp: '/dashboard/start/apps',
  Devices: '/dashboard/settings/devices',
  Account: '/dashboard/settings/account',
};
const url = new URL(location.href);
url.searchParams.set('path', paths[board] || '/dashboard');
history.replaceState({}, '', url);
if (board === 'CliLogin') {
  url.searchParams.set('cli', 'K2MQ-9XDV');
  history.replaceState({}, '', url);
}
localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: 'gabriel', token: 'fixture' }));
const sidebar: any = {
  inbox: { items: [], loading: false },
  workspace: { data: { projects: [], tasks: [] }, loading: false },
  agents: {
    data: {
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    },
  },
  live: { data: { summary: { running: 0, failing: 0 } } },
  user: { data: { username: 'Gabriel' } },
  computers: { data: { nodes: [{ online: true }] } },
};
function Task() {
  return (
    <>
      <Head title="Add a shopping list to pantry" subtitle="pantry · MacBook Pro" />
      <Tabs
        items={[
          { href: '#chat', label: 'Chat' },
          { href: '#changes', label: 'Changes' },
          { href: '#checks', label: 'Checks' },
        ]}
        value="#chat"
      />
      <FirstTask />
      <div className="dl-col">
        <p className="dl-bubble">
          Add a shopping list to pantry that pulls in items about to expire.
        </p>
        <WorkLog
          summary="Reading the pantry code"
          steps={[
            { icon: 'file', text: 'Read src/items.ts and src/routes.ts' },
            { icon: 'search', text: 'Searched for expiry · 4 results' },
          ]}
          live
        />
        <Composer project="pantry" computer="MacBook Pro" />
      </div>
    </>
  );
}
const content =
  board === 'FirstTask' || board === 'SessionExpired' ? (
    <Task />
  ) : board === 'PasskeyOffer' ? (
    <Home banner={<PasskeyOffer />} />
  ) : ['Devices', 'Account'].includes(board) ? (
    <Account />
  ) : (
    <Start />
  );
createRoot(document.getElementById('root')!).render(
  paths[board]?.startsWith('/') && !paths[board]?.startsWith('/dashboard') ? (
    <PublicPage />
  ) : (
    <div className="dl-app">
      <V2Sidebar pathname="/dashboard" data={sidebar} />
      <main className="dl-main">{content}</main>
      {board === 'SessionExpired' && <SessionExpired />}
    </div>
  ),
);
if (board === 'FirstAccount')
  setTimeout(() => {
    for (const [name, value] of Object.entries({
      name: 'Gabriel',
      username: 'gabriel',
      code: '4QX7-PL2M',
      password: 'example-password',
    })) {
      const input = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (input) input.value = value;
    }
  }, 500);
if (board === 'InstallApp')
  setTimeout(() => {
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent === 'Install…')
      ?.click();
  }, 500);
