'use client';
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Dialog,
  Empty,
  Field,
  Glyph,
  Group,
  Head,
  Icon,
  IconButton,
  Item,
  Skeleton,
  Tabs,
} from '@/components/ui';
import type { LiveResponse, Project, Release } from '../../../../../shared/v2/contracts';
import { request, useData, type Overview, type Work } from './data';
import { projectPath, projectSegment, projectTabs } from './routing';
import { AppOverview, Health, ReleaseList } from './app.client';
import { ProjectCode, ProjectIssues } from './code.client';
import { ProjectConfiguration } from './settings.client';
import { ProjectLogs } from './logs.client';
import './projects.css';
import { formatTime } from '../data/time';
import { useInbox, useResource } from '../data/hooks';
import { taskState, type WorkspaceState } from '../data/sidebar';
import type { TaskPull } from '../tasks/types';
import { parsePatch } from '../tasks/api';

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Head
      title={title}
      subtitle={subtitle}
      menu={
        <IconButton
          icon="menu"
          label="Show sidebar"
          className="dl-menu-btn"
          onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
        />
      }
      actions={
        subtitle === 'Project' ? (
          <a className="dl-btn primary" href="/dashboard">
            New task
          </a>
        ) : undefined
      }
    />
  );
}
export default function Projects() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();
  const parts = location.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[1] === 'settings')
    return (
      <>
        <Header title="Settings" />
        <div className="dl-scroll">
          <div className="dl-page v2-project-page">
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
          </div>
        </div>
      </>
    );
  return parts[2] ? (
    <ProjectPage
      key={parts[2]}
      projectKey={parts[2]}
      section={parts[3] || ''}
      appKey={parts[4]}
      appSettings={parts[5] === 'settings'}
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
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const live = useData<LiveResponse>('/api/v2/live');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setBusy(true);
    setError('');
    try {
      const project = await request('/api/workspace/projects', {
        method: 'POST',
        body: JSON.stringify({ name, sourcePath: source, operationId: crypto.randomUUID() }),
      });
      window.location.assign(projectPath(project.id));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header title="Projects" />
      <div className="dl-scroll">
        <div className="dl-page v2-project-page">
          <div className="dl-page-head">
            <div className="dl-t">
              <h1 className="dl-title">Projects</h1>
              <span className="dl-meta">A repository and everything it runs.</span>
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
          <Group>
            {projects.data?.projects.map((project) => {
              const apps = live.data?.computers
                .flatMap((computer) => computer.apps)
                .filter((app) => project.apps.some((entry) => entry.id === app.appId));
              const failed = apps?.find((app) => app.state === 'failing');
              return (
                <Item
                  key={project.id}
                  lead={
                    <Glyph kind="plain">
                      <Icon name="folder" size={12} />
                    </Glyph>
                  }
                  title={project.name}
                  description={
                    project.apps.length > 1
                      ? `${project.apps.length} apps${apps?.[0]?.release ? ` · release ${apps[0].release}` : ''}`
                      : project.apps.length
                        ? apps?.[0]?.address || '1 app'
                        : 'Repository only · no app'
                  }
                  end={project.apps.length ? <Health app={failed || apps?.[0]} /> : undefined}
                  href={projectPath(project.id)}
                />
              );
            })}
          </Group>
        </div>
      </div>
      <Dialog
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title="New project"
        actions={
          <>
            <Action disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              disabled={!name || !source}
              loading={busy}
              onClick={() => void create()}
            >
              Create project
            </Action>
          </>
        }
      >
        <div className="v2-project-form">
          <Field label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <Field
            label="Repository URL or folder"
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
          {error && <Banner title={error} />}
        </div>
      </Dialog>
    </>
  );
}
function ProjectPage({
  projectKey,
  section,
  appKey,
  appSettings,
  search,
}: {
  projectKey: string;
  section: string;
  appKey?: string;
  appSettings: boolean;
  search: string;
}) {
  const overview = useData<Overview>(`/api/v2/projects/${projectSegment(projectKey)}/overview`);
  const pulls = useData<{ items: TaskPull[] }>(
    `/api/workspace/projects/${projectSegment(projectKey)}/pulls?status=open`,
  );
  const history = useData<{ releases: Release[] }>(
    `/api/v2/projects/${projectSegment(projectKey)}/releases`,
  );
  const [add, setAdd] = useState(false);
  const [appName, setAppName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
  const computer = live.data?.computers.find((computer) =>
    computer.apps.some((app) => app.appId === project?.apps[0]?.id),
  );
  const liveApp = computer?.apps.find((app) => app.appId === project?.apps[0]?.id);
  const params = new URLSearchParams(search);
  const appList = section === '' && params.get('tab') === 'apps';
  const selectedApp = appKey
    ? project?.apps.find((app) => app.id === appKey || app.name === appKey)
    : undefined;
  const single =
    project?.apps.length === 1 &&
    !data?.tasks.length &&
    !data?.pulls.length &&
    !data?.issues.length;
  const labels =
    project && data
      ? projectTabs({
          code: !!data.repository,
          pulls: data.pulls.length,
          issues: data.issues.length,
          apps: project.apps.length,
          releases: releases.length,
        })
      : [];
  const tabHref = (label: string) =>
    label === 'Overview'
      ? base
      : label === 'Apps'
        ? `${base}?tab=apps`
        : `${base}/${label === 'Pull requests' ? 'pulls' : label.toLowerCase()}`;
  async function addApp() {
    setBusy(true);
    setError('');
    try {
      await request(`/api/v2/projects/${projectSegment(projectKey)}/apps`, {
        method: 'POST',
        body: JSON.stringify({ app: appName }),
      });
      setAdd(false);
      overview.refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Header
        title={selectedApp?.name || project?.name || projectKey}
        subtitle={
          selectedApp
            ? `${selectedApp.kind === 'worker' ? 'Worker' : 'Web app'} in ${project?.name}`
            : 'Project'
        }
      />
      <div className="dl-scroll">
        <div className="dl-page v2-project-page v2-project-detail">
          {overview.error && (
            <Banner
              title={overview.error}
              action={<Action onClick={overview.refresh}>Retry</Action>}
            />
          )}
          {!data && !overview.error && <Skeleton rows={4} />}
          {project && data && (
            <>
              <Tabs
                value={
                  selectedApp
                    ? `${base}/apps/${projectSegment(selectedApp.name)}${appSettings ? '/settings' : ''}`
                    : appList
                      ? `${base}?tab=apps`
                      : section
                        ? `${base}/${section}`
                        : base
                }
                items={
                  selectedApp
                    ? [
                        {
                          label: 'Overview',
                          href: `${base}/apps/${projectSegment(selectedApp.name)}`,
                        },
                        {
                          label: 'Settings',
                          href: `${base}/apps/${projectSegment(selectedApp.name)}/settings`,
                        },
                      ]
                    : labels.map((label) => ({
                        label,
                        href: tabHref(label),
                        ...(label === 'Apps'
                          ? { count: project.apps.length }
                          : label === 'Pull requests'
                            ? { count: data.pulls.length }
                            : label === 'Issues'
                              ? { count: data.issues.length }
                              : {}),
                      }))
                }
              />
              {selectedApp && (
                <a className="dl-meta" href={base}>
                  ← {project.name}
                </a>
              )}
              {history.error && (
                <Banner
                  title="Release history is unavailable"
                  action={<Action onClick={history.refresh}>Retry</Action>}
                />
              )}
              {section === 'code' ? (
                <ProjectCode overview={data} />
              ) : section === 'issues' ? (
                <ProjectIssues overview={data} refresh={overview.refresh} />
              ) : section === 'settings' ? (
                <ProjectConfiguration project={project} overview={data} />
              ) : section === 'logs' ? (
                <ProjectLogs project={project} selected={params.get('app') || ''} />
              ) : selectedApp ? (
                <AppOverview
                  project={project}
                  app={selectedApp}
                  overview={data}
                  releases={releases}
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
                  <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                </>
              ) : single ? (
                <>
                  <AppOverview
                    project={project}
                    app={project.apps[0]}
                    overview={data}
                    releases={releases}
                  />
                  <p className="dl-meta">
                    Pull requests and issues get their own tabs once there are some. Add a second
                    app and an Apps tab appears.
                  </p>
                  <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                </>
              ) : (
                <>
                  <div className="dl-stats">
                    <div className="dl-stat">
                      <span className="dl-meta">Open work</span>
                      <span className="dl-v">
                        {data.tasks.filter((task) => task.status !== 'completed').length}
                      </span>
                      <span className="dl-meta">
                        {running} running ·{' '}
                        {inbox.loading
                          ? 'Loading decisions…'
                          : inbox.error
                            ? 'Decisions unavailable'
                            : `${waiting.length} waiting on you`}
                      </span>
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
                    <div className="dl-stat">
                      <span className="dl-meta">{project.apps.length === 1 ? 'App' : 'Apps'}</span>
                      {project.apps.length === 1 ? (
                        <Health app={liveApp} />
                      ) : (
                        <span className="dl-v">{project.apps.length}</span>
                      )}
                      {liveApp && (
                        <span className="dl-meta">
                          {liveApp.release || 'Release unavailable'} on {computer?.name}
                        </span>
                      )}
                    </div>
                  </div>
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
                  {project.apps.length < 2 && (
                    <Action onClick={() => setAdd(true)}>Add an app to this project</Action>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      <Dialog
        open={add}
        onClose={() => {
          if (!busy) setAdd(false);
        }}
        title="Add an app to this project"
        actions={
          <>
            <Action disabled={busy} onClick={() => setAdd(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              disabled={!appName}
              loading={busy}
              onClick={() => void addApp()}
            >
              Add app
            </Action>
          </>
        }
      >
        <p>
          Enter an existing app's name. Apps already in another repository project must stay with
          that project.
        </p>
        <Field
          label="App name"
          value={appName}
          onChange={(event) => setAppName(event.target.value)}
        />
        {error && <Banner title={error} />}
      </Dialog>
    </>
  );
}

function WorkRow({ task, runs }: { task: Work; runs: WorkspaceState['runs'] }) {
  const snapshot = useData<{ computer?: string; run?: { status: string; updatedAt: string } }>(
    `/api/v2/tasks/${encodeURIComponent(task.id)}`,
  );
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
          {formatTime(snapshot.data?.run?.updatedAt || task.updatedAt || task.createdAt, 'elapsed')}
        </span>
      }
      href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}
    />
  );
}
