import { createRoot } from 'react-dom/client';
import { V2Layout } from '../../../app/routes/dashboard/v2-layout.client';
import Backups from '../../../app/routes/dashboard/v2/settings/backups/page.client';
import Projects from '../../../app/routes/dashboard/v2/projects/page.client';
import Start from '../../../app/routes/dashboard/v2/start/page.client';
import Live from '../../../app/routes/dashboard/v2/live/page.client';
import Inbox from '../../../app/routes/dashboard/v2/inbox/page.client';
import Settings from '../../../app/routes/dashboard/v2/settings/page.client';
import Releases from '../../../app/routes/dashboard/v2/releases/page.client';
import Computers from '../../../app/routes/dashboard/v2/computers/page.client';
import Agents from '../../../app/routes/dashboard/v2/agents/page.client';
import Task from '../../../app/routes/dashboard/v2/tasks/page.client';
import { setContent } from './fixture-router';
import '../../../app/design-tokens.css';
import '../../../app/routes/dashboard/v2/agents/style.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: 'gabriel', token: 'fixture' }));
const params = new URLSearchParams(location.search);
// CSS-only desktop emulation; real Electron window controls still need capture on a Mac.
if (params.has('mac')) document.documentElement.classList.add('deploy-desktop-mac');
if (params.has('fullscreen')) document.documentElement.classList.add('deploy-desktop-fullscreen');
const path = location.pathname;
setContent(
  path.includes('/backups') ? (
    <Backups />
  ) : path.startsWith('/dashboard/projects') ? (
    <Projects />
  ) : path.startsWith('/dashboard/live') ? (
    <Live />
  ) : path.startsWith('/dashboard/inbox') ? (
    <Inbox />
  ) : path.startsWith('/dashboard/computers') ? (
    <Computers />
  ) : path.startsWith('/dashboard/agents') ? (
    <Agents />
  ) : path.startsWith('/dashboard/settings') ? (
    <Settings />
  ) : path.startsWith('/dashboard/releases') ? (
    <Releases />
  ) : path.startsWith('/dashboard/tasks') ? (
    <Task />
  ) : (
    <Start />
  ),
);
createRoot(document.getElementById('root')!).render(<V2Layout />);
