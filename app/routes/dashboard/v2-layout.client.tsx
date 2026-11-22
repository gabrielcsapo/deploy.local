'use client';
import { commitScreen, projectTracer } from './v2/projects/interaction';
import { useDataSeed } from './v2/data/seeds';
import { waitingHref } from './v2/inbox/waiting';
import { useProjectFormatting } from './v2/projects/formatting.ts';
import {
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { Outlet, useLocation } from 'react-flight-router/client';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { Head, Sidebar, Nav, Icon, IconButton, Skeleton, Status } from '@/components/ui';
import {
  AgentNamesProvider,
  CoordinatorNameProvider,
  InboxProvider,
  WorkspaceContext,
  useInbox,
  useResource,
} from './v2/data/hooks';
import { type WorkspaceState, type SidebarAgent, type LiveSummary } from './v2/data/sidebar';
import './v2-shell.css';
import { DesignRail } from './v2/design/Rail';
import { sidebarCollapsed, sidebarPreferenceKey } from './v2/data/sidebar-preference';
import { FirstTask } from './v2/start/FirstTask';
import { useInAppLinks } from './v2/data/links';
import { SearchBox } from './v2/search/Search.client';
import { currentSearchScope } from './v2/search/scope.ts';
import { openSearch } from './v2/search/model.ts';
import { changeDesktopUpdateNavigation, useDesktopUpdate } from './v2/data/desktop-update';
import { DesktopUpdateRow } from './v2/DesktopUpdate';
import { SidebarTasks } from './v2/SidebarTasks';
import { rememberPlace } from './v2/design/review-origin';

function useSidebarData() {
  return {
    packages: useResource<{ served: boolean; usingCopies: boolean }>('/api/packages?sidebar=1'),
    inbox: useInbox(),
    workspace: useResource<WorkspaceState>('/api/state'),
    agents: useResource<{ agents: SidebarAgent[] }>('/api/agents', true),
    live: useResource<{ summary: LiveSummary }>('/api/live', true),
    user: useResource<{ username: string }>('/api/user'),
    computers: useResource<{ nodes: { id: string; name?: string; online: boolean }[] }>(
      '/api/nodes',
    ),
    desktopUpdate: useDesktopUpdate(),
  };
}

export function V2Sidebar({
  pathname,
  data,
  onCollapse,
  hidden,
  updateDetails,
}: {
  pathname: string;
  data: ReturnType<typeof useSidebarData>;
  onCollapse?: () => void;
  hidden?: boolean;
  updateDetails?: Pick<
    ComponentProps<typeof DesktopUpdateRow>,
    'open' | 'onOpenChange' | 'popoverId' | 'returnFocusRef'
  >;
}) {
  const { formatTime } = useProjectFormatting();
  const { inbox, workspace, live, user, computers } = data;
  const agents = data.agents.data?.agents ?? [];
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Design approvals waiting, counted on the Artifacts item like Live counts what runs.
  const designReviews = waiting.filter((item) => item.id.startsWith('design:')).length;
  const summary = live.data?.summary;
  const username = user.data?.username || 'Account';
  const online = computers.data?.nodes.filter((computer) => computer.online).length;
  return (
    <Sidebar
      hidden={hidden}
      onCollapse={onCollapse}
      brand={
        <>
          <span className="dl-brand" role="img" aria-label="deploy.local">
            <span className="dl-mark" aria-hidden="true">
              d
            </span>
            <span className="dl-wordmark">deploy.local</span>
          </span>
          <IconButton
            icon="search"
            label="Search"
            onClick={() => openSearch(currentSearchScope())}
          />
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
            active={
              pathname.startsWith('/dashboard/projects') ||
              pathname === '/dashboard/discover' ||
              pathname.startsWith('/dashboard/discover/')
            }
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
          {data.packages.data?.served && (
            <Nav
              href="/dashboard/packages"
              active={pathname.startsWith('/dashboard/packages')}
              lead={<Icon name="package" />}
              end={
                data.packages.data?.usingCopies ? (
                  <span className="dl-status attention">
                    <span className="dl-dot" />
                    Using copies
                  </span>
                ) : undefined
              }
            >
              Packages
            </Nav>
          )}
          <Nav
            href="/dashboard/artifacts"
            active={pathname === '/dashboard/design' || pathname.startsWith('/dashboard/artifacts')}
            lead={<Icon name="layers" />}
            end={designReviews ? <span>{designReviews} to review</span> : undefined}
          >
            Artifacts
          </Nav>
        </>
      }
      footer={
        <>
          <DesktopUpdateRow {...data.desktopUpdate} {...updateDetails} />
          <a className="dl-side-foot" href="/dashboard/settings">
            <span className="dl-avatar">{username.charAt(0).toUpperCase()}</span>
            <span className="dl-who">
              <span className="dl-strong">{username}</span>
              <span className="dl-meta">
                {online === undefined
                  ? computers.loading
                    ? ' '
                    : 'Computers unavailable'
                  : `${online} ${online === 1 ? 'computer' : 'computers'} online`}
              </span>
            </span>
            <Icon name="settings" />
          </a>
        </>
      }
    >
      <div className="dl-side-label">
        <span>Agents</span>
        <a href="/dashboard/agents/new" className="dl-icon-btn sm" aria-label="New agent">
          <Icon name="plus" size={14} />
        </a>
      </div>
      {!agents.length && (
        <a className="dl-nav dl-meta" href="/dashboard/agents/new">
          Make an agent to talk to
        </a>
      )}
      {agents.map((agent) => (
        <Nav
          key={agent.id}
          href={`/dashboard/agents/${encodeURIComponent(agent.id)}`}
          active={pathname === `/dashboard/agents/${encodeURIComponent(agent.id)}`}
          lead={<AgentAvatar avatar={agent.avatar} id={agent.id} size={28} />}
          end={
            agent.lastMessage ? (
              <span className="dl-meta">{formatTime(agent.lastMessage.at, 'list')}</span>
            ) : undefined
          }
        >
          <span className="dl-agent-name">{agent.name}</span>
          <span className="dl-meta">{agent.lastMessage?.text || 'Say hello'}</span>
        </Nav>
      ))}
      <div className="dl-side-label">
        <a
          href="/dashboard/inbox"
          aria-current={pathname === '/dashboard/inbox' ? 'page' : undefined}
        >
          Waiting on you
        </a>
        <span className="dl-c">{inbox.loading || inbox.error ? '—' : waiting.length}</span>
      </div>
      {inbox.error && (
        <p className="dl-sidebar-notice" role="status">
          Unavailable · retrying
        </p>
      )}
      {waiting.map((item) => (
        <Nav
          key={item.id}
          href={waitingHref(item)}
          lead={<Icon name="attention" className="dl-attn" size={14} />}
          end={formatTime(item.createdAt, 'list')}
        >
          {item.title}
        </Nav>
      ))}
      {workspace.error && (
        <p className="dl-sidebar-notice" role="status">
          Tasks unavailable · retrying
        </p>
      )}
      <SidebarTasks pathname={pathname} workspace={workspace.data} formatTime={formatTime} />
    </Sidebar>
  );
}

function LayoutSearch({
  pathname,
  data,
}: {
  pathname: string;
  data: ReturnType<typeof useSidebarData>;
}) {
  const { formatTime } = useProjectFormatting();
  return (
    <SearchBox
      pathname={pathname}
      agents={data.agents.data?.agents ?? []}
      waiting={data.inbox.items.filter((item) => item.state === 'waiting')}
      formatTime={formatTime}
    />
  );
}

export function V2Layout() {
  const { pathname } = useLocation();
  useInAppLinks();
  if (pathname === '/dashboard/design-system') return <Outlet />;
  return (
    <InboxProvider>
      <V2Shell />
    </InboxProvider>
  );
}

/**
 * A page that is not ready yet waits here, so the sidebar stays. The header stays too, because at
 * 820 px and below its menu button is the only way to the sidebar.
 */
function PageLoading() {
  return (
    <>
      <Head
        ruled
        title={<span className="dl-skel" style={{ width: 96 }} />}
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <div className="dl-scroll">
        <div className="dl-page">
          <div className="dl-page-head" aria-hidden="true">
            <div className="dl-t" style={{ gap: 10 }}>
              <span className="dl-skel" style={{ width: 180, height: 20, borderRadius: 6 }} />
              <span className="dl-skel" style={{ width: 320 }} />
            </div>
          </div>
          <Skeleton />
        </div>
      </div>
    </>
  );
}

function V2Shell() {
  const seed = useDataSeed();
  const data = useSidebarData();
  const { pathname, search } = useLocation();
  useEffect(() => {
    projectTracer();
    commitScreen(pathname);
  }, [pathname, data.user.data?.username]);
  const [navigation, setNavigation] = useState({ collapsed: false, updateOpen: false });
  const { collapsed, updateOpen } = navigation;
  const showRail = collapsed && !updateOpen;
  const updatePopoverId = useId();
  const railUpdateTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setNavigation((state) => ({ ...state, collapsed: sidebarCollapsed() }));
    const changed = (event: StorageEvent) => {
      if (event.key === sidebarPreferenceKey || event.key === null)
        setNavigation((state) => ({ ...state, collapsed: sidebarCollapsed() }));
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const [open, setOpen] = useState(false);
  const toggleSidebar = useCallback(() => {
    if (window.matchMedia('(max-width: 820px)').matches) {
      setOpen((previous) => !previous);
      return;
    }
    setNavigation(changeDesktopUpdateNavigation(navigation, 'toggle-sidebar'));
  }, [navigation]);
  const setUpdateOpen = useCallback((open: boolean) => {
    setNavigation((state) =>
      changeDesktopUpdateNavigation(state, open ? 'open-update' : 'close-update'),
    );
  }, []);
  useEffect(() => {
    if (data.desktopUpdate.status.phase === 'idle') setUpdateOpen(false);
  }, [data.desktopUpdate.status.phase, setUpdateOpen]);
  const drawer = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 820px)');
    const show = () => {
      if (compact.matches) setOpen((previous) => !previous);
    };
    const resized = () => {
      if (!compact.matches) setOpen(false);
    };
    compact.addEventListener('change', resized);
    window.addEventListener('deploy:v2-sidebar', show);
    return () => {
      window.removeEventListener('deploy:v2-sidebar', show);
      compact.removeEventListener('change', resized);
    };
  }, []);
  useEffect(() => {
    setOpen(false);
  }, [pathname]);
  // Each place shown, so a review can name the one it was opened from as its way back.
  useEffect(() => rememberPlace(pathname + search), [pathname, search]);
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
      if ((event.metaKey || event.ctrlKey) && event.key === '\\') {
        event.preventDefault();
        toggleSidebar();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        window.location.assign('/dashboard');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [toggleSidebar]);
  return (
    <div
      className={`dl-app${showRail ? ' dl-rail-shell' : ''}${pathname === '/dashboard/design' ? ' dl-design-shell' : ''}`}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"
      />
      <DesignRail
        hidden={!showRail}
        pathname={pathname}
        onExpand={toggleSidebar}
        update={data.desktopUpdate}
        onOpenUpdate={() => setUpdateOpen(true)}
        updatePopoverId={updatePopoverId}
        updateTriggerRef={railUpdateTrigger}
      />
      {/* Keep the list mounted so temporary expansion preserves its scroll position. */}
      <V2Sidebar
        hidden={showRail}
        pathname={pathname}
        data={data}
        onCollapse={toggleSidebar}
        updateDetails={{
          open: updateOpen,
          onOpenChange: setUpdateOpen,
          popoverId: updatePopoverId,
          returnFocusRef: collapsed ? railUpdateTrigger : undefined,
        }}
      />
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
      <LayoutSearch pathname={pathname} data={data} />
      <main className="dl-main">
        <CoordinatorNameProvider nodes={data.computers.data?.nodes}>
          <AgentNamesProvider agents={data.agents.data?.agents}>
            {/^\/dashboard\/tasks\/[^/]+/.test(pathname) && <FirstTask key={pathname} />}
            <Suspense fallback={seed ? null : <PageLoading />}>
              <WorkspaceContext.Provider
                value={{
                  owner: seed?.owner ?? data.user.data?.username,
                  data: data.workspace.data,
                }}
              >
                <Outlet />
              </WorkspaceContext.Provider>
            </Suspense>
          </AgentNamesProvider>
        </CoordinatorNameProvider>
      </main>
    </div>
  );
}
