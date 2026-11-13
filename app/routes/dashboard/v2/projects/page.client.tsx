'use client';
import { ListTemplate, DetailTemplate } from '@/components/ui/v2/Templates';
import { useEffect, useState } from 'react';
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
import type { LiveResponse, Project, Release } from '../../../../../shared/v2/contracts';
import { useData, type Overview, type Work } from './data';
import { appPath, appTabItems, projectPath, projectSegment, projectTabItems } from './routing';
import { AppOverview, AppSettings, Health, ReleaseList } from './app.client';
import { ProjectCode, ProjectIssues } from './code.client';
import { ProjectConfiguration } from './settings.client';
import { ProjectPipelines } from './pipelines.client';
import { ProjectLogs } from './logs.client';
import { AppRequest, AppRequests } from './requests.client';
import { AppPerformance } from './performance.client';
import { formatRequestClock, type RequestDetail } from './requests';
import './projects.css';
import { ProjectPanel } from './content.client';
import { AddExistingAppDialog, NoRepository } from './repository-connect.client';
import { projectRuntime } from './presentation';
import { NewProjectDialog } from './new-project.client';
import { ProjectPushCode, ProjectStart } from './project-start.client';
import { formatTime } from '../data/time';
import { remembered, useCoordinatorName, useInbox, useResource } from '../data/hooks';
import { taskState, type WorkspaceState } from '../data/sidebar';
import type { TaskPull } from '../tasks/types';
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
function ProjectList() {
  const coordinator = useCoordinatorName();
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const live = useResource<LiveResponse>('/api/v2/live');
  const [open, setOpen] = useState(false);
  return (
    <>
      <ListTemplate title="Projects" ruled={false} className="v2-project-page">
        <div className="dl-page-head">
          <div className="dl-t">
            <h1 className="dl-title">Projects</h1>
            <span className="dl-meta">
              Active projects grow. Maintained projects get fixes and updates. Done projects rest.
            </span>
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
        {projects.error && (
          <Banner
            title={projects.error}
            action={<Action onClick={projects.refresh}>Retry</Action>}
          />
        )}
        {!projects.data && !projects.error && <Skeleton rows={4} />}
        {projects.data?.projects.length === 0 && (
          <Empty title="No projects yet">Create a project from a repository.</Empty>
        )}
        {(['active', 'maintained', 'done'] as const).map((stage) => {
          const rows =
            projects.data?.projects.filter((project) => (project.stage || 'active') === stage) ||
            [];
          if (!rows.length) return null;
          const label = { active: 'Active', maintained: 'Maintained', done: 'Done' }[stage];
          return (
            <section className="dl-section" key={stage}>
              <h2 className="dl-section-title">{label}</h2>
              <Group>
                {rows.map((project) => {
                  const runtime = projectRuntime(project, live.data ?? undefined, coordinator);
                  return (
                    <Item
                      key={project.id}
                      title={`${project.name} · ${label}`}
                      description={
                        stage === 'done'
                          ? undefined
                          : project.fromDiscover
                            ? 'App from Discover'
                            : project.id.startsWith('app:')
                              ? 'No repository · shipped from a folder'
                              : project.apps.length > 1
                                ? `${project.apps.length} apps`
                                : project.apps.length
                                  ? '1 app'
                                  : 'Repository only · no app'
                      }
                      end={
                        stage !== 'done' && (
                          <span className="v2-project-runtime">
                            {'kind' in runtime ? (
                              <Status kind={runtime.kind}>{runtime.label}</Status>
                            ) : (
                              <span className="dl-meta">{runtime.label}</span>
                            )}
                            {'where' in runtime && <span className="dl-meta">{runtime.where}</span>}
                          </span>
                        )
                      }
                      href={projectPath(project.id)}
                    />
                  );
                })}
              </Group>
            </section>
          );
        })}
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
  search,
}: {
  projectKey: string;
  section: string;
  appKey?: string;
  appSettings: boolean;
  appRequests: boolean;
  appPerformance: boolean;
  requestId?: string;
  search: string;
}) {
  const { navigate } = useRouter();
  const overview = useData<Overview>(`/api/v2/projects/${projectSegment(projectKey)}/overview`);
  const pulls = useData<{ items: TaskPull[] }>(
    `/api/workspace/projects/${projectSegment(projectKey)}/pulls?status=open`,
  );
  const history = useData<{ releases: Release[] }>(
    `/api/v2/projects/${projectSegment(projectKey)}/releases`,
  );
  const [add, setAdd] = useState(false);
  const available = useData<{ apps: Project['apps'] }>('/api/v2/projects/unlinked-apps');
  const inbox = useInbox();
  const workspace = useResource<WorkspaceState>('/api/workspace/state');
  const live = useResource<LiveResponse>('/api/v2/live');
  const data = overview.data;
  const project = data?.project;
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
      ? `/api/v2/apps/${projectSegment(requestsApp!.name)}/requests/${encodeURIComponent(requestId)}`
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
    pageApp && !single ? appTabItems(base, pageApp) : projectTabItems(base, data, releases.length);
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
              pulls: 'Pull requests',
              issues: 'Issues',
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
          remembered<{ projects: Project[] }>('/api/v2/projects')?.projects.find(
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
            <a className="dl-btn primary" href="/dashboard">
              New task
            </a>
          ) : undefined
        }
        className={`${showRequests || showPerformance ? '' : 'wide'} v2-project-page v2-project-detail ${requestId ? 'v2-request-page' : ''}`}
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
                ) : section === 'issues' ? (
                  <ProjectIssues overview={data} refresh={overview.refresh} />
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
                      <p className="dl-meta">
                        Pull requests and issues get their own tabs once there are some. Add a
                        second app and an Apps tab appears.
                      </p>
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
                                Date.parse(release.steps[0]?.startedAt || '') >
                                  Date.now() - 7 * 86400000,
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
  const snapshot = useData<{
    computer?: string;
    run?: { status: string; updatedAt: string };
  }>(`/api/v2/tasks/${encodeURIComponent(task.id)}`);
  const diff = useData<{ patch?: string; status?: string }>(
    `/api/workspace/tasks/${encodeURIComponent(task.id)}/diff`,
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
