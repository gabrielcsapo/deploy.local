'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Empty,
  Glyph,
  Group,
  Head,
  Icon,
  IconButton,
  Item,
  Skeleton,
  Status,
  Term,
} from '@/components/ui';
import type {
  AppHealth,
  InboxItem,
  LiveApp,
  LiveAppResponse,
  LiveResponse,
  Project,
  Role,
  Rollback,
} from '../../../../../shared/v2/contracts';
import { liveRequest, useLive } from './data';
import { formatTime } from '../data/time';
import { authenticatedFetch } from '../data/hooks';
import { useData, type Overview as ProjectOverview } from '../projects/data';
import { appPath, projectPath } from '../projects/routing';
import './style.css';
import {
  appAddress,
  appHealthLabel,
  latestError,
  releaseLabel,
  repositoryName,
} from './presentation';

const roles: Record<Role, string> = {
  coordinator: 'Coordinator',
  'take-tasks': 'Take tasks',
  'run-apps': 'Run apps',
  'serve-models': 'Serve models',
  'use-screen': 'Use the screen',
};
const age = (at?: string) => formatTime(at, 'elapsed');
function StartApp({ appId, refresh }: { appId: string; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function start() {
    setBusy(true);
    setError('');
    try {
      const response = await authenticatedFetch(
        `/api/deployments/${encodeURIComponent(appId)}/restart`,
        { method: 'POST' },
      );
      if (!response.ok)
        throw new Error((await response.json()).error || 'Could not start the app.');
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start the app.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Action variant="quiet" loading={busy} onClick={() => void start()}>
        Start
      </Action>
      {error && (
        <span role="alert" className="dl-fail">
          {error}
        </span>
      )}
    </>
  );
}
function AutoRollback({
  rollback,
  names,
  refresh,
}: {
  rollback: Rollback;
  names: Record<string, string>;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function undo() {
    setBusy(true);
    setError('');
    try {
      await liveRequest(`/projects/${encodeURIComponent(rollback.projectId)}/rollback`, undefined, {
        from: rollback.to,
        to: rollback.from,
        reason: 'Undo automatic rollback',
      });
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not undo the rollback.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="dl-approval">
      <div className="dl-approval-head">
        <Glyph kind="warden">d</Glyph>
        <div className="dl-t">
          <h3 className="dl-approval-title">
            Automatically rolled back {names[rollback.projectId] ?? rollback.projectId} to{' '}
            {rollback.to.slice(0, 7)}
          </h3>
          <p className="dl-approval-text">
            {rollback.reason}
            <span className="dl-meta live-decision-source">
              Allowed by rule · nothing is waiting on you
            </span>
          </p>
        </div>
      </div>
      <div className="dl-approval-actions">
        <a
          className="dl-btn secondary"
          href={`${projectPath(rollback.projectId)}/releases/${encodeURIComponent(rollback.from)}`}
        >
          See the report
        </a>
        <Action variant="quiet" loading={busy} onClick={() => void undo()}>
          Undo the rollback
        </Action>
        <a className="dl-btn quiet" href="/dashboard/settings/approvals">
          Edit the rule
        </a>
      </div>
      {error && <Banner kind="danger" title={error} />}
    </article>
  );
}
function LatestError({ appId, checkedAt }: { appId: string; checkedAt: string }) {
  const [excerpt, setExcerpt] = useState('Loading error lines…');
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timer = setTimeout(() => controller.abort(), 5000);
    let logs = '';
    void (async () => {
      try {
        const response = await authenticatedFetch(
          `/api/deployments/${encodeURIComponent(appId)}/logs?tail=200`,
          { signal: controller.signal },
        );
        if (!response.ok || !response.body) throw new Error('Logs unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done) break;
          logs = (logs + decoder.decode(chunk.value, { stream: true })).slice(-32000);
          if (!disposed) setExcerpt(latestError(logs) || 'No error in the latest 200 log lines.');
        }
        if (!disposed) setExcerpt(latestError(logs) || 'No error in the latest 200 log lines.');
      } catch {
        if (!disposed && !logs) setExcerpt('Error details unavailable. Open logs to retry.');
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [appId, checkedAt]);
  return <Term aria-label="Latest error">{excerpt}</Term>;
}
function HealthStatus({ app }: { app: AppHealth }) {
  return (
    <Status
      kind={
        app.state === 'failing'
          ? 'failed'
          : app.state === 'warning'
            ? 'attention'
            : app.state === 'stopped'
              ? 'inactive'
              : 'healthy'
      }
    >
      {appHealthLabel(app)}
    </Status>
  );
}
function Decision({
  item,
  apps,
  refresh,
}: {
  item: InboxItem;
  apps: LiveApp[];
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const worker = apps.find(
    (app) => app.project === item.projectId && app.kind === 'worker' && app.state === 'failing',
  );
  async function answer(actionId: string) {
    setBusy(true);
    setError('');
    try {
      await liveRequest(`/inbox/${encodeURIComponent(item.id)}/answer`, undefined, {
        actionId,
        on: 'web',
      });
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not answer. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div>
      <article className="dl-approval">
        <div className="dl-approval-head">
          <Glyph kind="warden">d</Glyph>
          <div className="dl-t">
            <h3 className="dl-approval-title">{item.title}</h3>
            <p className="dl-approval-text">
              <>
                {item.text}
                <span className="dl-meta live-decision-source">
                  From deploy.local · also in Waiting on you
                </span>
              </>
            </p>
          </div>
        </div>
        <div className="dl-approval-actions">
          <>
            <Action variant="primary" disabled={busy} onClick={() => void answer('rollback')}>
              {item.actions.find((action) => action.id === 'rollback')?.label ?? 'Roll back'}
            </Action>
            {worker && (
              <a className="dl-btn secondary" href={appPath(worker)}>
                Open worker
              </a>
            )}
            {item.actions
              .filter((action) => ['keep', 'dismiss', 'not-now'].includes(action.id))
              .map((action) => (
                <Action
                  key={action.id}
                  variant="quiet"
                  disabled={busy}
                  onClick={() => void answer(action.id)}
                >
                  {action.label}
                </Action>
              ))}
          </>
        </div>
      </article>
      {error && (
        <Banner title={error} kind="danger">
          {item.projectId && (
            <a className="dl-link" href={`${projectPath(item.projectId)}/releases`}>
              Review project rollback
            </a>
          )}
        </Banner>
      )}
    </div>
  );
}
function RollbackAction({ item, refresh }: { item: InboxItem; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function answer() {
    setBusy(true);
    setError('');
    try {
      await liveRequest(`/inbox/${encodeURIComponent(item.id)}/answer`, undefined, {
        actionId: 'rollback',
        on: 'web',
      });
      refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not answer. Try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Action variant="primary" disabled={busy} onClick={() => void answer()}>
        {item.actions.find((action) => action.id === 'rollback')?.label ?? 'Roll back'}
      </Action>
      {error && (
        <Banner title={error} kind="danger">
          {item.projectId && (
            <a className="dl-link" href={`${projectPath(item.projectId)}/releases`}>
              Review project rollback
            </a>
          )}
        </Banner>
      )}
    </>
  );
}
function ProjectOrigin({ app, names }: { app: LiveApp; names: Record<string, string> }) {
  return app.project && !app.project.startsWith('app:') ? (
    <a className="dl-link" href={projectPath(app.project)}>
      {names[app.project] ?? 'Unavailable'}
    </a>
  ) : app.fromDiscover ? (
    'From Discover'
  ) : (
    'No project'
  );
}
function Computer({
  computer,
  names,
}: {
  computer: LiveResponse['computers'][number];
  names: Record<string, string>;
}) {
  const apps = computer.apps.filter((app) => app.state !== 'stopped');
  if (!apps.length) return null;
  return (
    <Group
      className="live-computer"
      title={
        <>
          <Glyph kind="plain">
            <Icon name="computer" size={12} />
          </Glyph>
          <span className="dl-strong">{computer.name}</span>
          <span>
            {[
              ...computer.roles.map((role) => roles[role]),
              ...(computer.cpu !== undefined ? [`CPU ${Math.round(computer.cpu)}%`] : []),
              ...(computer.memory !== undefined ? [`memory ${Math.round(computer.memory)}%`] : []),
              ...(computer.disk !== undefined ? [`disk ${Math.round(computer.disk)}%`] : []),
            ].join(' · ')}
          </span>
        </>
      }
      end={
        <Status kind={computer.online ? 'healthy' : 'inactive'}>
          {computer.online ? 'Online' : 'Offline'}
        </Status>
      }
    >
      <div className="dl-table-wrap">
        <table className="dl-table live-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Health</th>
              <th className="dl-hide-narrow">Traffic</th>
              <th className="dl-hide-mid">Release</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.appId}>
                <td className="dl-name">
                  <div className="live-stack">
                    <a href={appPath(app)}>{app.name}</a>
                    <span className="dl-meta dl-truncate">
                      <ProjectOrigin app={app} names={names} />
                      {' · '}
                      {app.kind === 'worker' ? 'worker, no address' : appAddress(app)}
                    </span>
                  </div>
                </td>
                <td className="live-health-cell">
                  <div className="live-stack">
                    <HealthStatus app={app} />
                    <span className="dl-meta">{app.summary}</span>
                  </div>
                </td>
                <td className="dl-hide-narrow">
                  <div className="live-stack">
                    {app.jobs ? (
                      <>
                        <span>{Math.round(app.jobs.perMin)} jobs/min</span>
                        <span className="dl-meta">
                          {app.queue
                            ? app.queue.depth
                              ? `${app.queue.depth.toLocaleString()} queued`
                              : 'Queue empty'
                            : 'Queue unavailable'}
                        </span>
                      </>
                    ) : app.http ? (
                      <>
                        <span>{app.http.reqPerMin} req/min</span>
                        <span className="dl-meta">p95 {Math.round(app.http.p95ms)} ms</span>
                      </>
                    ) : (
                      <span className="dl-meta">Unavailable</span>
                    )}
                  </div>
                </td>
                <td className="dl-hide-mid">
                  {app.release ? (
                    <>
                      <span className="dl-mono">{releaseLabel(app.release, app.source)}</span>{' '}
                      <span className="dl-meta">{app.releasedAt && age(app.releasedAt)}</span>
                    </>
                  ) : (
                    <span className="dl-meta">Unavailable</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Group>
  );
}
function Overview({
  live,
  items,
  names,
  refresh,
}: {
  live: LiveResponse;
  items: InboxItem[];
  names: Record<string, string>;
  refresh: () => void;
}) {
  const apps = live.computers.flatMap((computer) => computer.apps);
  const stopped = apps.filter((app) => app.state === 'stopped');
  const highMemory = apps.filter(
    (app) => app.state === 'warning' && /memory|% of \d+(?:\.\d+)? GB/i.test(app.summary),
  ).length;
  const warning = live.summary.warning - highMemory;
  return (
    <>
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title">Live</h1>
          <span className="dl-meta">
            {live.summary.running} apps on{' '}
            {
              live.computers.filter((computer) =>
                computer.apps.some((app) => app.state !== 'stopped'),
              ).length
            }{' '}
            computers{live.summary.failing ? ` · ${live.summary.failing} failing` : ''}
            {highMemory ? ` · ${highMemory} high memory` : ''}
            {warning ? ` · ${warning} warning` : ''} · checked {age(live.summary.checkedAt)} ago
          </span>
        </div>
        <span className="dl-end">
          <a className="dl-btn secondary" href="/dashboard/discover">
            Discover apps
          </a>
        </span>
      </div>
      {live.rollbacks?.map((rollback) => (
        <AutoRollback key={rollback.id} rollback={rollback} names={names} refresh={refresh} />
      ))}
      {items
        .filter(
          (item) => item.kind === 'rollback' && apps.some((app) => app.project === item.projectId),
        )
        .map((item) => (
          <Decision key={item.id} item={item} apps={apps} refresh={refresh} />
        ))}
      {apps.length === 0 && (
        <Empty title="No apps yet" icon="folder">
          Apps appear here once they run on your computers.
        </Empty>
      )}
      {live.computers.map((computer) => (
        <Computer key={computer.id} computer={computer} names={names} />
      ))}
      {stopped.length > 0 && (
        <section className="dl-section">
          <h2 className="dl-section-title">Not running</h2>
          <div className="live-section-gap" />
          <Group>
            {stopped.map((app) => (
              <Item
                key={app.appId}
                lead={
                  <Glyph kind="plain">
                    <Icon name="folder" size={12} />
                  </Glyph>
                }
                title={<a href={appPath(app)}>{app.name}</a>}
                description={
                  <>
                    <ProjectOrigin app={app} names={names} /> · {app.summary}
                  </>
                }
                end={<StartApp appId={app.appId} refresh={refresh} />}
              />
            ))}
          </Group>
        </section>
      )}
    </>
  );
}
function History({ detail }: { detail: LiveAppResponse }) {
  const samples = detail.history.filter((point) => point.failRate !== undefined);
  const start = Date.now() - 3600_000;
  const points = (failed: boolean) =>
    samples
      .map(
        (point) =>
          `${Math.max(0, Math.min(100, (Date.parse(point.at) - start) / 36000))},${40 - (failed ? point.failRate! : 1 - point.failRate!) * 38}`,
      )
      .join(' ');
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Jobs in the last hour</h2>
      <div className="live-section-gap" />
      <div className="dl-stat">
        {samples.length > 1 ? (
          <>
            <div className="live-chart-labels">
              <span className="dl-meta">Completed (%)</span>
              <span className="dl-meta">Failed (%)</span>
            </div>
            <svg
              className="live-chart"
              viewBox="0 0 100 42"
              preserveAspectRatio="none"
              role="img"
              aria-label={`Job failure rate, latest ${Math.round(samples.at(-1)!.failRate! * 100)} percent`}
            >
              <polyline
                points={points(false)}
                fill="none"
                stroke="var(--ds-secondary)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
              <polyline
                points={points(true)}
                fill="none"
                stroke="var(--ds-danger)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
            <span className="dl-meta">{detail.app.summary}</span>
          </>
        ) : (
          <span className="dl-meta">
            Job history unavailable. Reports will appear here as they arrive.
          </span>
        )}
      </div>
    </section>
  );
}
function ProvenanceCell({
  label,
  value,
  description,
  href,
}: {
  label: string;
  value: ReactNode;
  description?: string;
  href?: string;
}) {
  const Cell = href ? 'a' : 'div';
  return (
    <Cell className="live-provenance-cell" href={href}>
      <span className="dl-meta">{label}</span>
      <span className={`${href ? 'dl-link ' : ''}dl-truncate live-provenance-value`}>{value}</span>
      {description && <span className="dl-meta dl-truncate">{description}</span>}
    </Cell>
  );
}
export function AppDetail({
  detail,
  live,
  items,
  projectName,
  refresh,
}: {
  detail: LiveAppResponse;
  live: LiveResponse;
  items: InboxItem[];
  projectName?: string;
  refresh: () => void;
}) {
  const app = detail.app;
  const overview = useData<ProjectOverview>(
    `/api/v2/projects/${encodeURIComponent(app.project || `app:${app.name}`)}/overview`,
  );
  const repository = overview.data?.repository;
  const source = detail.release?.source ?? app.source;
  const computer = live.computers.find((c) => c.apps.some((a) => a.appId === app.appId));
  const project = projectPath(app.project || `app:${app.name}`);
  const decision = items.find((item) => item.kind === 'rollback' && item.projectId === app.project);
  const siblings = live.computers
    .flatMap((c) => c.apps)
    .filter((a) => detail.release?.apps.some((entry) => entry.appId === a.appId));
  return (
    <>
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title live-title">
            {app.name} <HealthStatus app={app} />
          </h1>
          <span className="dl-meta">
            {app.kind === 'worker' ? 'Worker' : 'Web app'} · {appAddress(app)}
          </span>
        </div>
        <span className="dl-end">
          {decision && project && <RollbackAction item={decision} refresh={refresh} />}
        </span>
      </div>
      <div className="dl-group live-provenance" aria-label="Where it comes from">
        <ProvenanceCell
          label="Project"
          href={project}
          value={projectName ?? overview.data?.project.name ?? app.name}
          description={
            overview.data
              ? `${overview.data.project.apps.length} ${overview.data.project.apps.length === 1 ? 'app' : 'apps'}, one release`
              : undefined
          }
        />
        <ProvenanceCell
          label="Repository"
          href={repository && project ? `${project}/code` : undefined}
          value={
            repository
              ? repositoryName(repository.source) || projectName || 'Unavailable'
              : 'Unavailable'
          }
          description={
            repository?.defaultBranch ? `Releases from ${repository.defaultBranch}` : undefined
          }
        />
        <ProvenanceCell
          label="Release"
          href={
            app.release && project
              ? `${project}/releases/${encodeURIComponent(app.release)}?app=${encodeURIComponent(app.appId)}`
              : undefined
          }
          value={
            <>
              <span className="dl-mono">{releaseLabel(app.release, source)}</span>
              {app.releasedAt && ` · ${formatTime(app.releasedAt, 'clock')}`}
            </>
          }
          description={source?.message}
        />
        <ProvenanceCell
          label="Computer"
          href={computer ? `/dashboard/computers/${encodeURIComponent(computer.id)}` : undefined}
          value={computer?.name ?? 'Unavailable'}
          description={
            computer
              ? `${computer.roles.includes('coordinator') ? 'Coordinator' : 'Run apps'} · ${computer.online ? 'online' : 'offline'}`
              : undefined
          }
        />
      </div>
      <section className="dl-section">
        <h2 className="dl-section-title">Health</h2>
        <p className="dl-section-sub">
          {app.kind === 'worker'
            ? 'A worker has no address to check, so deploy.local watches what it does.'
            : app.summary}
        </p>
        <Group>
          {app.kind === 'worker' ? (
            <>
              <Item
                title="Jobs"
                description={app.summary}
                lead={
                  <Icon
                    name={app.state === 'failing' ? 'close' : 'pulse'}
                    className={
                      app.state === 'failing'
                        ? 'dl-fail'
                        : app.state === 'healthy'
                          ? 'dl-ok'
                          : 'dl-attn'
                    }
                  />
                }
                end={
                  app.jobs
                    ? `Usually under ${Math.max(1, Math.ceil(app.jobs.baselineFailRate * 100))}%`
                    : 'Unavailable'
                }
              />
              <Item
                title="Queue"
                description={
                  app.queue
                    ? `${app.queue.depth.toLocaleString()} waiting · oldest ${Math.ceil(app.queue.oldestSec / 60)} min`
                    : 'Queue measurements unavailable'
                }
                lead={
                  <Icon
                    name={app.queue && app.queue.oldestSec > 60 ? 'close' : 'check'}
                    className={app.queue ? (app.queue.oldestSec > 60 ? 'dl-fail' : 'dl-ok') : ''}
                  />
                }
              />
            </>
          ) : (
            <Item
              title="HTTP check"
              description={app.summary}
              lead={<Icon name="pulse" />}
              end={app.http ? `p95 ${Math.round(app.http.p95ms)} ms` : 'Unavailable'}
            />
          )}
          <Item
            title="Process"
            description={
              app.state === 'stopped'
                ? 'Not running'
                : app.restarts
                  ? `Running · restarted ${app.restarts.count} times in ${app.restarts.windowSec / 60} min`
                  : 'Restart history unavailable'
            }
            lead={
              <Icon
                name={app.restarts?.count ? 'running' : 'check'}
                className={
                  app.restarts?.count
                    ? 'dl-attn'
                    : app.state !== 'stopped' && app.restarts
                      ? 'dl-ok'
                      : ''
                }
              />
            }
          />
          <Item
            title="Heartbeat"
            description={
              app.heartbeatAt ? `Last seen ${age(app.heartbeatAt)} ago` : 'Heartbeat unavailable'
            }
            lead={
              <Icon
                name="check"
                className={
                  app.heartbeatAt && Date.now() - Date.parse(app.heartbeatAt) < 90000
                    ? 'dl-ok'
                    : 'dl-attn'
                }
              />
            }
          />
        </Group>
      </section>
      {app.release && project && (
        <section className="dl-section">
          <h2 className="dl-section-title">In this release</h2>
          <p className="dl-section-sub">
            {siblings.length === 2 &&
            detail.release?.migrations.length === 1 &&
            detail.release.migrations[0].reversible
              ? 'One release covers the project, so rolling back moves both apps and undoes the migration.'
              : 'One release covers the project.'}
          </p>
          <Group>
            {siblings.map((sibling) => (
              <Item
                key={sibling.appId}
                title={sibling.name}
                description={sibling.kind === 'worker' ? 'Worker' : 'Web app'}
                href={sibling.appId !== app.appId ? appPath(sibling) : undefined}
                lead={
                  <Glyph kind="plain">
                    <Icon name="folder" size={12} />
                  </Glyph>
                }
                end={<HealthStatus app={sibling} />}
              />
            ))}
            {detail.release?.migrations.map((migration) => (
              <Item
                key={migration.id}
                title={`Migration ${migration.id}`}
                description={migration.title}
                lead={<Icon name="file" />}
                end={migration.reversible ? 'Reversible' : 'Backup required'}
              />
            ))}
          </Group>
        </section>
      )}
      {app.kind === 'worker' && (
        <div className="dl-cols">
          <History detail={detail} />
          <section className="dl-section">
            <h2 className="dl-section-title">Latest error</h2>
            <div className="live-section-gap" />
            <div className="dl-stat">
              <LatestError appId={app.appId} checkedAt={live.summary.checkedAt} />
              {project && (
                <a
                  className="dl-link"
                  href={`${project}/logs?app=${encodeURIComponent(app.appId)}`}
                >
                  Open logs
                </a>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}
export default function LivePage() {
  const { pathname } = useLocation();
  const encoded = pathname.split('/')[3];
  const appId = encoded ? decodeURIComponent(encoded) : undefined;
  const { live, detail, items, error, retry } = useLive(appId);
  const projects = useData<{ projects: Project[] }>('/api/v2/projects');
  const names = Object.fromEntries(
    projects.data?.projects.map((project) => [project.id, project.name]) ?? [],
  );
  useEffect(() => {
    if (appId && detail) window.location.replace(appPath(detail.app));
  }, [appId, detail]);
  return (
    <>
      <Head
        title={
          appId ? (
            <nav className="live-crumbs" aria-label="Breadcrumb">
              <a href="/dashboard/live">Live</a>
              <Icon name="chevron" size={14} />
              <span className="dl-truncate" aria-current="page">
                {detail?.app.name ?? appId}
              </span>
            </nav>
          ) : (
            'Live'
          )
        }
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
        <div className={`dl-page live-page ${appId ? 'live-detail' : ''}`}>
          {error && (
            <Banner
              title={error}
              action={
                <Action variant="secondary" onClick={retry}>
                  Retry
                </Action>
              }
            >
              {live
                ? 'Showing the last received health.'
                : 'Health is unavailable until the connection returns.'}
            </Banner>
          )}
          {!live || (appId && !detail) ? (
            !error && (
              <Skeleton
                rows={5}
                label="Loading Live"
                slowLabel="Live is taking longer than usual"
              />
            )
          ) : appId ? (
            <Skeleton rows={5} label="Opening app" />
          ) : (
            <Overview live={live} items={items} names={names} refresh={retry} />
          )}
        </div>
      </div>
    </>
  );
}
