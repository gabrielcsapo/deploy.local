'use client';
import type { Interaction } from '../../../../../packages/trace/interaction';
import { markProjectOpen, startProjectOpen } from './interaction';
import { useProjectFormatting } from './formatting.ts';
import { ListTemplate, DetailTemplate } from '@/components/ui/v2/Templates';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams, useRouter } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Empty,
  Glyph,
  Group,
  Icon,
  Item,
  Skeleton,
  Status,
  Tabs,
} from '@/components/ui';
import type {
  LiveResponse,
  Project,
  ProjectListGroup,
  ProjectListResponse,
  Release,
} from '../../../../../shared/v2/contracts';
import { useData, type Overview, type Work } from './data';
import { appPath, appTabItems, projectPath, projectSegment, projectTabItems } from './routing';
import { AppOverview, AppSettings, Health, ReleaseList } from './app.client';
import { ProjectCode } from './code.client';
import { ProjectWorkTab } from './work.client';
import { CloneUrls } from './clone.client';
import { ProjectConfiguration } from './settings.client';
import { ProjectPipelines } from './pipelines.client';
import { ProjectLogs } from './logs.client';
import { AppRequest, AppRequests } from './requests.client';
import { AppPerformance } from './performance.client';
import { type RequestDetail } from './requests';
import './projects.css';
import { ProjectPanel } from './content.client';
import { AddExistingAppDialog, NoRepository } from './repository-connect.client';
import {
  projectCardFact,
  projectListSummary,
  projectRuntime,
  rankLiveProjects,
  repositoryRowFact,
  requestsToday,
  showLabel,
  sparkPoints,
} from './presentation';
import {
  PROJECT_LIST_DEFAULT,
  PROJECT_LIST_GROUPS,
  REPOSITORY_PAGE,
  projectListPath,
} from '../../../../../shared/v2/project-list';
import { NewProjectDialog } from './new-project.client';
import { ProjectPushCode, ProjectStart } from './project-start.client';

import { remembered, useCoordinatorName, useInbox, useResource } from '../data/hooks';
import { taskState, type WorkspaceState } from '../data/sidebar';
import type { TaskPull } from '../tasks/types';
import type { ProjectWork } from '../../../../../server/features/repositories/project-work.ts';
import { parsePatch } from '../tasks/api';
import { appAddress, releaseLabel, repositoryName, runningSubtitle } from '../live/presentation';

export default function Projects() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[1] === 'settings')
    return (
      <>
        <ListTemplate title="Settings" ruled={false} className="v2-project-page">
          <Group>
            <Item
              title="Account"
              description="Manage your sign-in"
              href="/dashboard/settings?tab=account"
            />
            <Item
              title="Agents and approvals"
              description="Choose what agents can do"
              href="/dashboard/settings/approvals"
            />
            <Item title="Backups" href="/dashboard/settings/backups" />
            <Item title="Computers and models" href="/dashboard/computers" />
          </Group>
          <Account />
        </ListTemplate>
      </>
    );
  return parts[2] ? (
    <ProjectPage
      key={parts[2]}
      projectKey={parts[2]}
      section={parts[3] || ''}
      appKey={parts[3] === 'apps' ? parts[4] : undefined}
      appSettings={parts[5] === 'settings'}
      appRequests={parts[5] === 'requests'}
      appPerformance={parts[5] === 'performance'}
      requestId={
        parts[3] === 'requests' ? parts[4] : parts[5] === 'requests' ? parts[6] : undefined
      }
      pullId={parts[3] === 'pulls' ? parts[4] : undefined}
      search={search}
    />
  ) : (
    <ProjectList />
  );
}
function Account() {
  const user = useData<{ username: string }>('/api/user');
  return (
    <Group title="Account">
      <Item
        title={user.data?.username || 'Account'}
        description={user.error || 'Signed in on this computer'}
      />
      <Item
        title="Variables and secrets"
        description="Manage these in each project’s Settings."
        href="/dashboard/projects"
      />
    </Group>
  );
}
const SHOW_KEY = 'deploy-projects-show';
const SHOW_NAMES: Record<ProjectListGroup, string> = {
  live: 'Live',
  repositories: 'Repositories',
  archived: 'Archived',
};
/** How many more repositories one “Show more” fetches. */
const REPOSITORY_STEP = 20;

/** Three ticks, any number at once but never none; it stays open while you tick. */
function ShowMenu({
  show,
  onChange,
}: {
  show: ProjectListGroup[];
  onChange: (show: ProjectListGroup[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="v2-project-show"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="dl-btn secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {showLabel(show)}
        <Icon name="down" size={14} />
      </button>
      {open && (
        <div className="dl-menu" role="menu" aria-label="Show">
          <span className="dl-menu-label">Show</span>
          {PROJECT_LIST_GROUPS.map((group) => {
            const on = show.includes(group);
            return (
              <button
                key={group}
                type="button"
                className="dl-menu-item"
                role="menuitemcheckbox"
                aria-checked={on}
                aria-disabled={on && show.length === 1}
                onClick={() => {
                  if (on && show.length === 1) return;
                  onChange(
                    PROJECT_LIST_GROUPS.filter((entry) =>
                      entry === group ? !on : show.includes(entry),
                    ),
                  );
                }}
              >
                {SHOW_NAMES[group]}
                {on && (
                  <span className="dl-end">
                    <Icon name="tick" size={14} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

const folderGlyph = (
  <Glyph kind="plain">
    <Icon name="folder" size={12} />
  </Glyph>
);

function ProjectList() {
  const coordinator = useCoordinatorName();
  const { repositoryTime, now } = useProjectFormatting();
  const live = useResource<LiveResponse>('/api/live');
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<ProjectListGroup[]>(PROJECT_LIST_DEFAULT);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(REPOSITORY_PAGE);
  // The ticks are remembered on this computer; the page first arrives with the usual two.
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(SHOW_KEY) || 'null');
      const groups = PROJECT_LIST_GROUPS.filter(
        (group) => Array.isArray(stored) && stored.includes(group),
      );
      if (groups.length) setShow(groups);
    } catch {
      // A browser that keeps nothing shows the usual two.
    }
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(filter.trim()), 200);
    return () => clearTimeout(timer);
  }, [filter]);
  const list = useData<ProjectListResponse>(projectListPath(show, query, limit));
  // While the next answer loads, the last one stays: the list never blanks between keystrokes.
  const [kept, setKept] = useState(list.data);
  if (list.data && list.data !== kept) setKept(list.data);
  const data = list.data ?? kept;
  const total = data ? data.counts.live + data.counts.repositories + data.counts.archived : 0;
  const matches = data ? data.live.length + data.repositories.length + data.archived.length : 0;
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const changed = (project: Project) =>
    project.changedAt ? repositoryTime(project.changedAt) : undefined;
  const summary = data ? projectListSummary(data.counts, live.data?.summary.failing ?? 0) : '';
  return (
    <>
      <ListTemplate title="Projects" ruled={false} className="v2-project-page">
        <div className="dl-page-head">
          <div className="dl-t">
            <h1 className="dl-title">Projects</h1>
            {summary && <span className="dl-meta">{summary}</span>}
          </div>
          <span className="dl-end">
            <a className="dl-btn secondary" href="/dashboard/discover">
              Discover apps
            </a>
            <Action variant="primary" onClick={() => setOpen(true)}>
              New project
            </Action>
          </span>
        </div>
        {list.error && (
          <Banner title={list.error} action={<Action onClick={list.refresh}>Retry</Action>} />
        )}
        {!data && !list.error && <Skeleton rows={4} />}
        {data && total === 0 && (
          <Empty title="No projects yet">Create a project from a repository.</Empty>
        )}
        {data && total > 0 && (
          <div className="v2-project-tools">
            <label className="dl-field">
              <span className="dl-sr">Filter projects</span>
              <Icon name="search" size={14} />
              <input
                type="search"
                placeholder="Filter projects"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <ShowMenu
              show={show}
              onChange={(next) => {
                setShow(next);
                try {
                  localStorage.setItem(SHOW_KEY, JSON.stringify(next));
                } catch {
                  // Nowhere to keep it; the choice lasts for this visit.
                }
              }}
            />
          </div>
        )}
        {data && total > 0 && !matches && (
          <Empty title={query ? 'No projects match' : `Nothing under ${showLabel(show)}`}>
            {query
              ? `Nothing is named “${query}”.`
              : 'Tick another kind of project in the menu beside the filter.'}
          </Empty>
        )}
        {data && data.live.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-title">Live</h2>
            <div className="dl-stats v2-project-cards">
              {rankLiveProjects(data.live, live.data ?? undefined, coordinator).map((project) => {
                const runtime = projectRuntime(project, live.data ?? undefined, coordinator);
                const fact = projectCardFact(project, changed(project));
                return (
                  <a
                    key={project.id}
                    className="dl-stat v2-project-card"
                    onClick={() => markProjectOpen(project.id)}
                    href={projectPath(project.id)}
                  >
                    <span className="v2-project-card-head">
                      <Glyph>{project.name.charAt(0).toUpperCase()}</Glyph>
                      <span className="v2-project-card-name">
                        <span className="dl-strong dl-truncate">{project.name}</span>
                        <span className="dl-meta dl-truncate">
                          {'where' in runtime ? runtime.where : runtime.label}
                        </span>
                      </span>
                      {'kind' in runtime && <Status kind={runtime.kind}>{runtime.label}</Status>}
                    </span>
                    {project.traffic && (
                      <svg
                        className="dl-spark"
                        viewBox="0 0 110 40"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        <polyline
                          points={sparkPoints(project.traffic.hourly)}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                    )}
                    <span className="v2-project-card-foot">
                      <span className="dl-meta">
                        {project.traffic ? requestsToday(project.traffic, midnight) : ''}
                      </span>
                      {fact && <span className="dl-meta">{fact}</span>}
                    </span>
                  </a>
                );
              })}
            </div>
          </section>
        )}
        {data && data.repositories.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-title">Repositories</h2>
            <Group>
              {data.repositories.map((project) => {
                const fact = repositoryRowFact(project, changed(project));
                return (
                  <Item
                    key={project.id}
                    lead={folderGlyph}
                    title={project.name}
                    description={project.lastCommit}
                    end={fact ? <span className="dl-meta">{fact}</span> : undefined}
                    onClick={() => markProjectOpen(project.id)}
                    href={projectPath(project.id)}
                  />
                );
              })}
              {data.more > 0 && (
                <button
                  type="button"
                  className="dl-item v2-project-more"
                  onClick={() => setLimit(limit + REPOSITORY_STEP)}
                >
                  Show {Math.min(data.more, REPOSITORY_STEP)} more
                </button>
              )}
            </Group>
          </section>
        )}
        {data && data.archived.length > 0 && (
          <section className="dl-section">
            <h2 className="dl-section-title">Archived</h2>
            <Group>
              {data.archived.map((project) => (
                <Item
                  key={project.id}
                  lead={folderGlyph}
                  title={project.name}
                  onClick={() => markProjectOpen(project.id)}
                  href={projectPath(project.id)}
                />
              ))}
            </Group>
          </section>
        )}
      </ListTemplate>
      <NewProjectDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(project) => window.location.assign(projectPath(project.id))}
      />
    </>
  );
}
function ProjectPage({
  projectKey,
  section,
  appKey,
  appSettings,
  appRequests,
  appPerformance,
  requestId,
  pullId,
  search,
}: {
  projectKey: string;
  section: string;
  appKey?: string;
  appSettings: boolean;
  appRequests: boolean;
  appPerformance: boolean;
  requestId?: string;
  pullId?: string;
  search: string;
}) {
  const { formatRequestClock, formatTime, now } = useProjectFormatting();
  const { navigate } = useRouter();
  const open = useRef<Interaction | undefined>(undefined);
  useEffect(() => {
    const interaction = startProjectOpen(projectKey);
    open.current = interaction;
    return () => {
      interaction?.finish('navigation.left', 'cancelled');
      open.current = undefined;
    };
  }, [projectKey]);
  const overview = useData<Overview>(`/api/projects/${projectSegment(projectKey)}/overview`, {
    open,
  });
  const pulls = useData<{ items: TaskPull[] }>(
    `/api/projects/${projectSegment(projectKey)}/pulls?status=open`,
    { open },
  );
  // Every tab row shows the Work count, so the work is read with the page, not the tab.
  const work = useData<ProjectWork>(`/api/projects/${projectSegment(projectKey)}/work`, { open });
  const history = useData<{ releases: Release[] }>(
    `/api/projects/${projectSegment(projectKey)}/releases`,
    { open },
  );
  // An open pull request's page has Merge as its one primary action, so New task steps back.
  const pullDetail = useData<{ record: TaskPull }>(
    pullId
      ? `/api/projects/${projectSegment(projectKey)}/pulls/${projectSegment(pullId)}`
      : undefined,
  );
  const openPull = pullDetail.data?.record.status === 'open';
  const refreshPull = pullDetail.refresh;
  useEffect(() => {
    window.addEventListener('deploy:pull-changed', refreshPull);
    return () => window.removeEventListener('deploy:pull-changed', refreshPull);
  }, [refreshPull]);
  const [add, setAdd] = useState(false);
  const available = useData<{ apps: Project['apps'] }>('/api/projects/unlinked-apps');
  const inbox = useInbox();
  const workspace = useResource<WorkspaceState>('/api/state');
  const live = useResource<LiveResponse>('/api/live');
  const data = overview.data;
  const project = data?.project;
  useEffect(() => {
    const interaction = open.current;
    if (overview.error) {
      interaction?.finish('project.failed', 'error');
      return;
    }
    if (!project) return;
    const frame = requestAnimationFrame(() => interaction?.finish('details.visible'));
    return () => cancelAnimationFrame(frame);
  }, [projectKey, project, overview.error]);
  const base = projectPath(project?.id || projectKey);
  const releases = history.data?.releases || [];
  const waiting = inbox.items.filter(
    (item) =>
      item.state === 'waiting' &&
      (item.projectId === project?.id || data?.tasks.some((task) => task.id === item.taskId)),
  );
  const running =
    data?.tasks.filter(
      (task) =>
        taskState(
          { ...task, status: task.status || '', createdAt: task.createdAt || '' },
          workspace.data?.runs || [],
        ) === 'running',
    ).length || 0;
  const readyPull = pulls.data?.items.find((pull) =>
    waiting.some(
      (item) => item.kind === 'merge' && item.taskId && pull.taskIds.includes(item.taskId),
    ),
  );
  const latest = releases
    .filter((release) => ['live', 'superseded'].includes(release.state))
    .map(
      (release) =>
        release.steps.find((step) => step.name === 'activate')?.endedAt ||
        release.steps[0]?.startedAt,
    )
    .filter((at): at is string => !!at)
    .sort()
    .at(-1);
  const runningApps =
    live.data?.computers.flatMap((computer) =>
      computer.apps
        .filter(
          (app) => app.state !== 'stopped' && project?.apps.some((entry) => entry.id === app.appId),
        )
        .map((app) => ({ app, computer: computer.name })),
    ) ?? [];
  const params = new URLSearchParams(search);
  const appList = section === '' && params.get('tab') === 'apps';
  const single = project?.apps.length === 1;
  const contextApp = params.get('app');
  const selectedApp = appKey
    ? project?.apps.find((app) => app.id === appKey || app.name === appKey)
    : ['logs', 'releases'].includes(section) && contextApp
      ? project?.apps.find((app) => app.id === contextApp || app.name === contextApp)
      : undefined;
  const pageApp = selectedApp ?? (single ? project?.apps[0] : undefined);
  useEffect(() => {
    if (single && selectedApp && section === 'apps' && !appRequests && !appPerformance)
      void navigate(appSettings ? `${base}/settings` : base, { replace: true });
  }, [single, selectedApp, section, appSettings, appRequests, appPerformance, base, navigate]);
  const appBase = selectedApp ? `${base}/apps/${projectSegment(selectedApp.name)}` : '';
  // A one-app project is its own app page, so its requests live at the project's /requests.
  const requestsApp =
    selectedApp ??
    (section === 'requests' && project?.apps.length === 1 ? project.apps[0] : undefined);
  const requestsBase = selectedApp && !single ? `${appBase}/requests` : `${base}/requests`;
  const showRequests =
    !!requestsApp && (appRequests || section === 'requests') && requestsApp.kind !== 'worker';
  const performanceApp =
    selectedApp ?? (single && section === 'performance' ? project?.apps[0] : undefined);
  const showPerformance =
    !!performanceApp &&
    (appPerformance || section === 'performance') &&
    performanceApp.kind !== 'worker';
  const performanceBase = selectedApp && !single ? `${appBase}/performance` : `${base}/performance`;
  const liveAddress = live.data?.computers
    .flatMap((computer) => computer.apps)
    .find((app) => app.appId === (requestsApp ?? performanceApp)?.name)?.address;
  const requestDetail = useData<RequestDetail>(
    showRequests && requestId
      ? `/api/apps/${projectSegment(requestsApp!.name)}/requests/${encodeURIComponent(requestId)}`
      : undefined,
  );
  const starting =
    !section &&
    !selectedApp &&
    !appList &&
    !!data?.repository?.empty &&
    !data.tasks.length &&
    !project?.apps.length;
  const tabs =
    pageApp && !single
      ? appTabItems(base, pageApp)
      : projectTabItems(base, data, releases.length, work.data?.counts.open);
  const activeLabel = appSettings
    ? 'Settings'
    : showRequests
      ? 'Requests'
      : showPerformance
        ? 'Performance'
        : appList
          ? 'Apps'
          : ({
              releases: 'Releases',
              logs: 'Logs',
              code: 'Code',
              work: 'Work',
              // A pull request's own page sits under Work.
              pulls: 'Work',
              pipelines: 'Pipelines',
              settings: 'Settings',
            }[section] ?? 'Overview');
  return (
    <>
      <DetailTemplate
        title={
          (showRequests && requestId && (
            <nav className="v2-crumbs" aria-label="Breadcrumb">
              <a href={selectedApp && !single ? appBase : base}>{requestsApp!.name}</a>
              <Icon name="chevron" size={14} />
              <a href={requestsBase}>Requests</a>
              <Icon name="chevron" size={14} />
              <span className="dl-truncate" aria-current="page">
                {requestDetail.data ? formatRequestClock(requestDetail.data.request.at) : 'Request'}
              </span>
            </nav>
          )) ||
          (pageApp && (
            <nav className="v2-crumbs" aria-label="Breadcrumb">
              <a href="/dashboard/projects">Projects</a>
              <Icon name="chevron" size={14} />
              {single ? (
                <span aria-current="page">{project?.name}</span>
              ) : (
                <>
                  <a href={base}>{project?.name}</a>
                  <Icon name="chevron" size={14} />
                  <span className="dl-truncate" aria-current="page">
                    {pageApp.name}
                  </span>
                </>
              )}
            </nav>
          )) ||
          project?.name ||
          // Until the project loads, its name from the project list, never its ID.
          remembered<{ projects: Project[] }>('/api/projects')?.projects.find(
            (item) => item.id === projectKey,
          )?.name ||
          ''
        }
        parent={
          !pageApp && !(showRequests && requestId)
            ? { label: 'Projects', href: '/dashboard/projects' }
            : undefined
        }
        subtitle={
          (showRequests && requestId) || pageApp
            ? undefined
            : selectedApp
              ? `${selectedApp.kind === 'worker' ? 'Worker' : 'Web app'} in ${project?.name}`
              : 'Project'
        }
        actions={
          !starting && !selectedApp ? (
            <a className={`dl-btn ${openPull ? 'secondary' : 'primary'}`} href="/dashboard">
              New task
            </a>
          ) : undefined
        }
        // Work is a reading list: its rows, and a pull request's page under it, keep the tabs'
        // column instead of the wide page.
        className={`${showRequests || showPerformance || section === 'work' || section === 'pulls' ? '' : 'wide'} v2-project-page v2-project-detail ${requestId ? 'v2-request-page' : ''}`}
      >
        {overview.error && (
          <Banner
            title={overview.error}
            action={<Action onClick={overview.refresh}>Retry</Action>}
          />
        )}
        {!data && !overview.error && <Skeleton rows={4} />}
        {project && data && showRequests && requestId ? (
          <ProjectPanel>
            <AppRequest
              app={requestsApp!.name}
              detail={requestDetail}
              base={requestsBase}
              logs={`${base}/logs?app=${encodeURIComponent(requestsApp!.name)}`}
            />
          </ProjectPanel>
        ) : (
          project &&
          data && (
            <>
              <Tabs
                retainContent
                value={tabs.find((tab) => tab.label === activeLabel)?.href ?? base}
                items={tabs}
              />
              <ProjectPanel>
                {history.error && (
                  <Banner
                    title="Release history is unavailable"
                    action={<Action onClick={history.refresh}>Retry</Action>}
                  />
                )}
                {['pulls', 'releases'].includes(section) ? null : section === 'pipelines' &&
                  data.repository?.deployment?.pipeline ? (
                  <ProjectPipelines projectId={project.id} />
                ) : section === 'code' ? (
                  data.repository?.empty ? (
                    <ProjectPushCode project={project} overview={data} />
                  ) : (
                    <ProjectCode overview={data} />
                  )
                ) : section === 'work' ? (
                  <ProjectWorkTab
                    projectId={project.id}
                    work={work.data}
                    error={work.error}
                    refresh={() => {
                      work.refresh();
                      overview.refresh();
                    }}
                  />
                ) : section === 'settings' ? (
                  <>
                    {single && (
                      <AppSettings project={project} app={project.apps[0]} overview={data} />
                    )}
                    <ProjectConfiguration project={project} overview={data} />
                  </>
                ) : section === 'logs' ? (
                  <ProjectLogs project={project} selected={params.get('app') || ''} />
                ) : showRequests ? (
                  <AppRequests app={requestsApp!.name} address={liveAddress} base={requestsBase} />
                ) : showPerformance ? (
                  <AppPerformance
                    app={performanceApp!.name}
                    address={liveAddress}
                    base={performanceBase}
                  />
                ) : selectedApp ? (
                  <AppOverview
                    project={project}
                    app={selectedApp}
                    overview={data}
                    releases={releases}
                    single={single}
                    settings={appSettings}
                  />
                ) : section === 'apps' ? (
                  <Empty title="App not found">This app does not belong to this project.</Empty>
                ) : appList ? (
                  <>
                    <Group title="Apps">
                      {project.apps.map((app) => (
                        <Item
                          key={app.id}
                          title={app.name}
                          description={app.kind === 'worker' ? 'Worker' : 'Web app'}
                          href={`${base}/apps/${projectSegment(app.name)}`}
                        />
                      ))}
                    </Group>
                    {data.repository && (
                      <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                    )}
                  </>
                ) : starting ? (
                  <ProjectStart
                    project={project}
                    overview={data}
                    addApp={available.data?.apps.length ? () => setAdd(true) : undefined}
                  />
                ) : single ? (
                  <>
                    <AppOverview
                      project={project}
                      app={project.apps[0]}
                      overview={data}
                      releases={releases}
                      single
                    />
                    {!project.fromDiscover && !data.repository && !data.repositoryError && (
                      <NoRepository project={project} />
                    )}
                    {!data.pulls.length && !data.issues.length && (
                      <p className="dl-meta">Add a second app and an Apps tab appears.</p>
                    )}
                    {data.repository && (
                      <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                    )}
                  </>
                ) : (
                  <>
                    <div className="dl-stats">
                      <div className="dl-stat">
                        <span className="dl-meta">Open work</span>
                        <span className="dl-v">
                          {data.tasks.filter((task) => task.status !== 'completed').length}
                        </span>
                        <div className="dl-meta">
                          {running} running ·{' '}
                          {inbox.loading ? (
                            <Skeleton rows={1} label="Loading decisions" />
                          ) : inbox.error ? (
                            'Decisions unavailable'
                          ) : (
                            `${waiting.length} waiting on you`
                          )}
                        </div>
                      </div>
                      <div className="dl-stat">
                        <span className="dl-meta">Pull requests</span>
                        <span className="dl-v">
                          {data.pulls.filter((pull) => pull.state === 'open').length}
                        </span>
                        <span className="dl-meta">
                          {readyPull
                            ? `#${readyPull.number} ready to merge`
                            : pulls.error
                              ? 'Review status unavailable'
                              : 'None ready to merge'}
                        </span>
                      </div>
                      <div className="dl-stat">
                        <span className="dl-meta">Shipped this week</span>
                        <span className="dl-v">
                          {
                            releases.filter(
                              (release) =>
                                ['live', 'superseded'].includes(release.state) &&
                                Date.parse(release.steps[0]?.startedAt || '') > now - 7 * 86400000,
                            ).length
                          }
                        </span>
                        <span className="dl-meta">
                          {latest ? `Last ${formatTime(latest)}` : 'No releases yet'}
                        </span>
                      </div>
                    </div>
                    {runningApps.length > 0 && (
                      <section className="dl-section">
                        <h2 className="dl-section-title">Running</h2>
                        <p className="dl-section-sub">
                          {runningSubtitle(
                            runningApps.map(({ app }) => app),
                            repositoryName(data.repository?.source),
                            formatTime,
                          )}
                        </p>
                        <Group>
                          {runningApps.map(({ app, computer }) => (
                            <Item
                              key={app.appId}
                              title={app.name}
                              lead={
                                <Glyph kind="plain">
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.75"
                                    aria-hidden="true"
                                  >
                                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                                    <rect x="14" y="3" width="7" height="7" rx="1.5" />
                                    <rect x="3" y="14" width="7" height="7" rx="1.5" />
                                    <rect x="14" y="14" width="7" height="7" rx="1.5" />
                                  </svg>
                                </Glyph>
                              }
                              description={`${app.kind === 'worker' ? 'Worker' : 'Web app'} · ${appAddress(app)} · ${computer}`}
                              end={<Health app={app} />}
                              href={appPath(app)}
                            >
                              <span className="dl-c dl-mono dl-hide-narrow">
                                {releaseLabel(app.release, app.source)}
                              </span>
                            </Item>
                          ))}
                        </Group>
                      </section>
                    )}
                    <div className="dl-cols">
                      <section className="dl-section">
                        <h2 className="dl-section-title">Work</h2>
                        {waiting.length > 0 && (
                          <p className="dl-section-sub">
                            {waiting.length} {waiting.length === 1 ? 'decision' : 'decisions'} for
                            this project {waiting.length === 1 ? 'is' : 'are'} in{' '}
                            <a href="/dashboard/inbox">Waiting on you</a>.
                          </p>
                        )}
                        <Group>
                          {data.tasks.map((task) => (
                            <WorkRow key={task.id} task={task} runs={workspace.data?.runs || []} />
                          ))}
                          {!data.tasks.length && (
                            <Item
                              title="No work yet"
                              description="Start a new task for this project."
                            />
                          )}
                        </Group>
                      </section>
                      <ReleaseList project={project} releases={releases} />
                    </div>
                    {data.repository && (
                      <section className="dl-section">
                        <h2 className="dl-section-title">Clone</h2>
                        <div className="dl-group v2-clone-card">
                          <CloneUrls repository={data.repository} projectId={project.id} />
                        </div>
                      </section>
                    )}
                    {project.apps.length < 2 && data.repository && (
                      <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                    )}
                  </>
                )}
              </ProjectPanel>
            </>
          )
        )}
      </DetailTemplate>
      {add && project && (
        <AddExistingAppDialog
          project={project}
          onClose={() => setAdd(false)}
          onAdded={() => {
            overview.refresh();
            available.refresh();
          }}
        />
      )}
    </>
  );
}

function WorkRow({ task, runs }: { task: Work; runs: WorkspaceState['runs'] }) {
  const { formatTime } = useProjectFormatting();
  const snapshot = useData<{
    computer?: string;
    run?: { status: string; updatedAt: string };
  }>(`/api/task-snapshots/${encodeURIComponent(task.id)}`);
  const diff = useData<{ patch?: string; status?: string }>(
    `/api/tasks/${encodeURIComponent(task.id)}/diff`,
  );
  const files =
    diff.data?.patch === undefined || diff.data.status ? undefined : parsePatch(diff.data.patch);
  const state = taskState(
    { ...task, status: task.status || '', createdAt: task.createdAt || '' },
    runs,
  );
  return (
    <Item
      title={task.title}
      lead={
        <Icon
          name={state === 'running' ? 'running' : state === 'ready' ? 'check' : 'clock'}
          className={
            state === 'running'
              ? 'dl-spin v2-work-running'
              : state === 'ready'
                ? 'v2-work-ready'
                : ''
          }
        />
      }
      description={
        <>
          {state === 'ready' ? 'Ready for review' : state === 'running' ? 'Running' : task.status}
          {snapshot.data?.computer && ` · ${snapshot.data.computer}`}
          {files && (
            <>
              {' '}
              · <span className="dl-add">+{files.reduce((n, file) => n + file.added, 0)}</span>{' '}
              <span className="dl-del">−{files.reduce((n, file) => n + file.removed, 0)}</span>
            </>
          )}
        </>
      }
      end={
        <span className="dl-meta">
          {formatTime(snapshot.data?.run?.updatedAt || task.updatedAt || task.createdAt, 'list')}
        </span>
      }
      href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}
    />
  );
}
