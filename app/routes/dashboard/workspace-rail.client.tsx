'use client';
import { LegacyIconButton as IconButton } from '@/components/ui';

import { Select } from '@/components/ui';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation } from 'react-flight-router/client';
import { dashboardPathname } from './repository-navigation';
import { WorkspaceIcon, type WorkspaceIconName } from './workspace-icon';
import { ProviderUsageFooter } from './provider-usage.client';
import { getAuth, clearAuth } from './detail/shared';
import './workspace-rail.css';

type Worker = { id: string; name: string; status: string; providers?: any[] };
export function WorkspaceRail({
  workers: supplied,
  workerId,
}: {
  workers?: Worker[];
  workerId?: string;
}) {
  const pathname = dashboardPathname(useLocation().pathname);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [usageWorker, setUsageWorker] = useState('');
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    const auth = getAuth();
    try {
      if (auth)
        await fetch('/api/logout', {
          headers: { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token },
        });
    } catch {
      // Local sign-out must still work while the coordinator is unreachable.
    } finally {
      clearAuth();
      window.location.assign('/dashboard/apps');
    }
  }
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const accountSource = useRef<HTMLElement | null>(null);
  const popupId = useId();
  const username = getAuth()?.username || 'Account';
  useEffect(() => {
    if (supplied) return;
    const controller = new AbortController();
    const auth = getAuth();
    if (!auth) return;
    const refresh = () =>
      fetch('/api/workspace/state', {
        headers: { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.ok) setWorkers((await response.json()).workers || []);
        })
        .catch(() => {});
    void refresh();
    const timer = setInterval(refresh, 60000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [supplied]);
  useEffect(() => {
    popup.current?.hidePopover();
  }, [pathname]);
  useEffect(() => {
    const show = (event: Event) => {
      accountSource.current = (event as CustomEvent<HTMLElement>).detail;
      popup.current?.showPopover();
      popup.current?.querySelector<HTMLElement>('a,button,select')?.focus();
    };
    window.addEventListener('deploy:account', show);
    return () => window.removeEventListener('deploy:account', show);
  }, []);
  const available = supplied || workers;
  const selected = available.find((item) => item.id === (usageWorker || workerId)) || available[0];
  const links: { to: string; icon: WorkspaceIconName; label: string; active: boolean }[] = [
    {
      to: '/dashboard',
      icon: 'chat',
      label: 'Tasks',
      active: ['/dashboard', '/dashboard/', '/dashboard/projects'].includes(pathname),
    },
    {
      to: '/dashboard/repositories',
      icon: 'folder',
      label: 'Repositories',
      active: pathname.startsWith('/dashboard/repositories'),
    },
    {
      to: '/dashboard/apps',
      icon: 'grid',
      label: 'Applications',
      active:
        Boolean(pathname.split('/')[2]) &&
        ![
          'projects',
          'repositories',
          'nodes',
          'computers',
          'embed',
          'settings',
          'design-system',
        ].includes(pathname.split('/')[2]),
    },
    {
      to: '/dashboard/computers',
      icon: 'computer',
      label: 'Computers',
      active: pathname.startsWith('/dashboard/computers'),
    },
  ];
  return (
    <>
      <nav className="workspace-rail" aria-label="Main navigation">
        <Link to="/dashboard" className="wr-brand" title="deploy.local" aria-label="deploy.local">
          <WorkspaceIcon name="brand" />
        </Link>
        <div className="wr-destinations">
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="wr-action"
              aria-label={link.label}
              title={link.label}
              aria-current={link.active ? 'page' : undefined}
            >
              <WorkspaceIcon name={link.icon} />
              {link.icon === 'computer' && available.some((w) => w.status === 'online') && (
                <span className="wr-online" />
              )}
            </Link>
          ))}
        </div>
        <div className="wr-account">
          <Link
            to="/dashboard/settings"
            className="wr-action"
            aria-label="Settings"
            title="Settings"
            aria-current={
              pathname.startsWith('/dashboard/settings') ||
              pathname.startsWith('/dashboard/design-system')
                ? 'page'
                : undefined
            }
          >
            <WorkspaceIcon name="settings" />
          </Link>
          <IconButton
            icon="user"
            label="Account and provider usage"
            ref={trigger}
            pressed={open}
            aria-expanded={open}
            aria-controls={popupId}
            popoverTarget={popupId}
          />
        </div>
      </nav>
      <nav className="workspace-tabs phone-only" aria-label="Main navigation">
        {links.map((link) => (
          <Link
            key={link.to}
            to={link.to}
            aria-label={link.label}
            aria-current={link.active ? 'page' : undefined}
            onClick={() => {
              if (link.label === 'Tasks') window.dispatchEvent(new CustomEvent('deploy:task-list'));
            }}
          >
            <WorkspaceIcon name={link.icon} />
            <span>{link.label === 'Repositories' ? 'Repos' : link.label}</span>
          </Link>
        ))}
      </nav>
      <div
        ref={popup}
        id={popupId}
        popover="auto"
        className="wr-account-popover"
        onToggle={(event) => {
          setOpen(event.newState === 'open');
          if (event.newState === 'closed' && accountSource.current?.isConnected) {
            accountSource.current.focus();
            accountSource.current = null;
          }
        }}
      >
        <div className="wr-account-heading">
          <span className="wr-avatar">
            <WorkspaceIcon name="user" />
          </span>
          <div>
            <strong>{username}</strong>
            <span>deploy.local account</span>
          </div>
        </div>
        {available.length > 1 && (
          <label className="wr-computer-label">
            Usage on
            <Select
              aria-label="Usage computer"
              value={selected?.id || ''}
              onChange={(event) => setUsageWorker(event.target.value)}
            >
              {available.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        <Link className="wr-settings-link phone-only" to="/dashboard/settings">
          <WorkspaceIcon name="settings" /> Settings
        </Link>
        {open && <ProviderUsageFooter worker={selected} />}
        <button className="wr-sign-out" disabled={signingOut} onClick={() => void signOut()}>
          <WorkspaceIcon name="sign-out" /> {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </>
  );
}
