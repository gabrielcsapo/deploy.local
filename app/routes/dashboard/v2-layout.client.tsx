'use client';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-flight-router/client';
import { Sidebar, Nav, Icon, IconButton, Glyph, Status } from '@/components/ui';
import {
  AgentNamesProvider,
  CoordinatorNameProvider,
  InboxProvider,
  useInbox,
  useResource,
} from './v2/data/hooks';
import {
  dayLabel,
  relativeTime,
  taskState,
  type WorkspaceState,
  type SidebarAgent,
  type LiveSummary,
} from './v2/data/sidebar';
import './v2-shell.css';
import { FirstTask } from './v2/start/page.client';

function useSidebarData() {
  return {
    inbox: useInbox(),
    workspace: useResource<WorkspaceState>('/api/workspace/state'),
    agents: useResource<{ agents: SidebarAgent[] }>('/api/v2/agents', true),
    live: useResource<{ summary: LiveSummary }>('/api/v2/live', true),
    user: useResource<{ username: string }>('/api/user'),
    computers: useResource<{ nodes: { id: string; name?: string; online: boolean }[] }>(
      '/api/nodes',
    ),
  };
}

export function V2Sidebar({
  pathname,
  data,
}: {
  pathname: string;
  data: ReturnType<typeof useSidebarData>;
}) {
  const { inbox, workspace, live, user, computers } = data;
  const agents = data.agents.data?.agents ?? [];
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Design approvals waiting, counted on the Design item like Live counts what runs.
  const designReviews = waiting.filter((item) => item.id.startsWith('design:')).length;
  const tasks = [...(workspace.data?.tasks ?? [])].sort(
    (a, b) => Date.parse(b.updatedAt || b.createdAt) - Date.parse(a.updatedAt || a.createdAt),
  );
  const summary = live.data?.summary;
  const username = user.data?.username || 'Account';
  const online = computers.data?.nodes.filter((computer) => computer.online).length;
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
            end={
              live.error ? (
                <span>Unavailable</span>
              ) : summary ? (
                summary.failing > 0 ? (
                  <Status kind="failed">{summary.failing} failing</Status>
                ) : (
                  <span>{summary.running} running</span>
                )
              ) : undefined
            }
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
          <Nav
            href="/dashboard/design"
            active={pathname === '/dashboard/design'}
            lead={<Icon name="layers" />}
            end={designReviews ? <span>{designReviews} to review</span> : undefined}
          >
            Design
          </Nav>
        </>
      }
      footer={
        <a className="dl-side-foot" href="/dashboard/settings">
          <span className="dl-avatar">{username.charAt(0).toUpperCase()}</span>
          <span className="dl-who">
            <span className="dl-strong">{username}</span>
            <span className="dl-meta">
              {online === undefined
                ? 'Computers unavailable'
                : `${online} ${online === 1 ? 'computer' : 'computers'} online`}
            </span>
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
      {agents.map((agent) => (
        <Nav
          key={agent.id}
          href={`/dashboard/agents/${encodeURIComponent(agent.id)}`}
          active={pathname === `/dashboard/agents/${encodeURIComponent(agent.id)}`}
          lead={<Glyph>{agent.name.charAt(0)}</Glyph>}
        >
          {agent.name}
        </Nav>
      ))}
      <div className="dl-side-label">
        <a
          href="/dashboard/inbox"
          aria-current={pathname === '/dashboard/inbox' ? 'page' : undefined}
        >
          Waiting on you
        </a>
        <span>{inbox.loading || inbox.error ? '—' : waiting.length}</span>
      </div>
      {inbox.error && (
        <p className="dl-sidebar-notice" role="status">
          Unavailable · retrying
        </p>
      )}
      {waiting.map((item) => (
        <Nav
          key={item.id}
          href={`/dashboard/inbox?item=${encodeURIComponent(item.id)}`}
          lead={<Icon name="attention" className="dl-attn" size={14} />}
          end={relativeTime(item.createdAt)}
        >
          {item.title}
        </Nav>
      ))}
      {workspace.error && (
        <p className="dl-sidebar-notice" role="status">
          Tasks unavailable · retrying
        </p>
      )}
      {['Today', 'Yesterday'].map((day) => {
        const items = tasks.filter((task) => dayLabel(task.updatedAt || task.createdAt) === day);
        return (
          items.length > 0 && (
            <div key={day}>
              <div className="dl-side-label">
                <span>{day}</span>
                {day === 'Today' && (
                  <a href="/dashboard" className="dl-icon-btn sm" aria-label="New task">
                    <Icon name="plus" size={14} />
                  </a>
                )}
              </div>
              {items.map((task) => {
                const state = taskState(task, workspace.data?.runs ?? []);
                return (
                  <Nav
                    key={task.id}
                    href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}
                    active={pathname.startsWith(`/dashboard/tasks/${encodeURIComponent(task.id)}`)}
                    lead={
                      state === 'idle' ? undefined : (
                        <span
                          aria-label={
                            state === 'stalled'
                              ? 'Stalled'
                              : state === 'ready'
                                ? 'Ready'
                                : 'Running'
                          }
                        >
                          <Icon
                            name={
                              state === 'running'
                                ? 'running'
                                : state === 'ready'
                                  ? 'check'
                                  : 'clock'
                            }
                            className={
                              state === 'running'
                                ? 'dl-run dl-spin'
                                : state === 'ready'
                                  ? 'dl-ok'
                                  : 'dl-stalled'
                            }
                            size={14}
                          />
                        </span>
                      )
                    }
                    end={
                      day === 'Today' ? relativeTime(task.updatedAt || task.createdAt) : undefined
                    }
                  >
                    {task.title}
                  </Nav>
                );
              })}
            </div>
          )
        );
      })}
    </Sidebar>
  );
}

export function V2Layout() {
  const { pathname } = useLocation();
  if (pathname === '/dashboard/design-system') return <Outlet />;
  return (
    <InboxProvider>
      {/* Design is full screen with its own navigation, like Figma; it still reads Waiting on you. */}
      {pathname === '/dashboard/design' ? <Outlet /> : <V2Shell />}
    </InboxProvider>
  );
}

function V2Shell() {
  const data = useSidebarData();
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
  return (
    <div className="dl-app">
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <V2Sidebar pathname={pathname} data={data} />
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
        <V2Sidebar pathname={pathname} data={data} />
      </dialog>
      <main className="dl-main">
        <CoordinatorNameProvider nodes={data.computers.data?.nodes}>
          <AgentNamesProvider agents={data.agents.data?.agents}>
            {/^\/dashboard\/tasks\/[^/]+/.test(pathname) && <FirstTask key={pathname} />}
            <Outlet />
          </AgentNamesProvider>
        </CoordinatorNameProvider>
      </main>
    </div>
  );
}
