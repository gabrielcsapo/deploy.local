'use client';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-flight-router/client';
import { Sidebar, Nav, Icon, IconButton, Glyph, Status } from '@/components/ui';
import './v2-shell.css';

export function V2Sidebar({ pathname }: { pathname: string }) {
  return (
    <Sidebar
      brand={
        <>
          <span className="dl-brand">
            <span className="dl-mark">d</span>deploy.local
          </span>
          <IconButton icon="search" label="Search (coming soon)" disabled />
        </>
      }
      navigation={
        <>
          <Nav
            href="/dashboard"
            active={pathname === '/dashboard'}
            strong
            lead={<Icon name="compose" />}
            end={<span className="dl-kbd">⌘N</span>}
          >
            New task
          </Nav>
          <Nav
            href="/dashboard/projects"
            active={pathname.startsWith('/dashboard/projects')}
            lead={<Icon name="folder" />}
          >
            Projects
          </Nav>
          <Nav
            href="/dashboard/live"
            active={pathname.startsWith('/dashboard/live')}
            lead={<Icon name="pulse" />}
            end={<Status kind="failed">1 failing</Status>}
          >
            Live
          </Nav>
          <Nav
            href="/dashboard/computers"
            active={pathname.startsWith('/dashboard/computers')}
            lead={<Icon name="computer" />}
          >
            Computers
          </Nav>
        </>
      }
      footer={
        <a className="dl-side-foot" href="/dashboard/settings">
          <span className="dl-avatar">G</span>
          <span className="dl-who">
            <span className="dl-strong">Gabriel</span>
            <span className="dl-meta">3 computers online</span>
          </span>
          <Icon name="settings" />
        </a>
      }
    >
      <div className="dl-side-label">
        <span>Agents</span>
        <a href="/dashboard/agents/new" className="dl-icon-btn sm" aria-label="New agent">
          <Icon name="plus" size={14} />
        </a>
      </div>
      <Nav href="/dashboard/agents/scout" lead={<Glyph>S</Glyph>}>
        Scout
      </Nav>
      <Nav href="/dashboard/agents/warden" lead={<Glyph kind="warden">W</Glyph>}>
        Warden
      </Nav>
      <div className="dl-side-label">
        <a href="/dashboard/inbox">Waiting on you</a>
        <span>3</span>
      </div>
      {['Roll back home-gym?', 'Merge PR #18', 'Keep 3 or 5 releases?'].map((title, index) => (
        <Nav
          key={title}
          href="/dashboard/inbox"
          lead={<Icon name="attention" className="dl-attn" size={14} />}
          end={['now', '4m', '12m'][index]}
        >
          {title}
        </Nav>
      ))}
      <div className="dl-side-label">
        <span>Today</span>
        <a href="/dashboard" className="dl-icon-btn sm" aria-label="New task">
          <Icon name="plus" size={14} />
        </a>
      </div>
      {[
        'Self-release pipeline',
        'Fix the sync migration',
        'Show checks on merged PRs',
        'Rename workouts.started safely',
      ].map((title, index) => (
        <Nav
          key={title}
          href={`/dashboard/tasks/${['self-release', 'sync-migration', 'merged-checks', 'rename-workouts'][index]}`}
          lead={index < 2 ? <Icon name="running" className="dl-run" size={14} /> : undefined}
          end={['12m', '3m', '40m', '2h'][index]}
        >
          {title}
        </Nav>
      ))}
      <div className="dl-side-label">Yesterday</div>
      {[
        'Update from main after conflicts',
        'Keep leading zeros in SSH keys',
        'Queue runs per computer',
      ].map((title, index) => (
        <Nav key={title} href={`/dashboard/tasks/yesterday-${index}`}>
          {title}
        </Nav>
      ))}
    </Sidebar>
  );
}

export function V2Layout() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener('deploy:v2-sidebar', show);
    return () => window.removeEventListener('deploy:v2-sidebar', show);
  }, []);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    const dialog = drawer.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (open) dialog.showModal();
    else dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        window.location.assign('/dashboard');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  if (pathname === '/dashboard/design-system') return <Outlet />;
  return (
    <div className="dl-app">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <V2Sidebar pathname={pathname} />
      <dialog
        ref={drawer}
        className="dl-drawer"
        aria-label="Navigation"
        onCancel={(event) => {
          event.preventDefault();
          setOpen(false);
        }}
      >
        <IconButton
          icon="close"
          label="Close navigation"
          className="dl-drawer-close"
          onClick={() => setOpen(false)}
        />
        <V2Sidebar pathname={pathname} />
      </dialog>
      <main className="dl-main">
        <Outlet />
      </main>
    </div>
  );
}
