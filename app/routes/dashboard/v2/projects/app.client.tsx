'use client';
import { NoRepository } from './repository-connect.client';
import { useState } from 'react';
import {
  Action,
  Banner,
  Dialog,
  Field,
  Group,
  Item,
  Setting,
  Skeleton,
  Status,
} from '@/components/ui';
import type {
  LiveApp,
  LiveAppResponse,
  Project,
  Release,
} from '../../../../../shared/v2/contracts';
import { request, useData, type Overview } from './data';
import { projectPath, projectSegment } from './routing';
import { useCoordinatorName } from '../data/hooks';
import { useLive } from '../live/data';
import { AppDetail } from '../live/page.client';
import { trafficMetrics, memoryMetric } from '../live/measurements';
import { releaseLabel } from '../live/presentation';
export function Health({ app }: { app?: LiveApp }) {
  return (
    <Status
      kind={
        !app || app.state === 'stopped'
          ? 'inactive'
          : app.state === 'failing'
            ? 'failed'
            : app.state === 'warning'
              ? 'attention'
              : 'healthy'
      }
    >
      {app
        ? {
            healthy: 'Healthy',
            warning: 'Needs attention',
            failing: 'Failing',
            stopped: 'Stopped',
          }[app.state]
        : 'Unavailable'}
    </Status>
  );
}
export function ReleaseList({ project, releases }: { project: Project; releases: Release[] }) {
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Recent releases</h2>
      <Group>
        {releases.slice(0, 5).map((release) => (
          <Item
            key={release.id}
            title={releaseLabel(release.id, release.source)}
            description={release.source.message || release.source.ref}
            end={release.state === 'live' ? <Status>Live</Status> : release.state}
            href={`${projectPath(project.id)}/releases/${projectSegment(release.id)}`}
          />
        ))}
        {!releases.length && (
          <Item
            title="No releases yet"
            description="A release moves every app in the project together."
          />
        )}
      </Group>
    </section>
  );
}
type AppProps = {
  project: Project;
  app: Project['apps'][number];
  overview: Overview;
  releases: Release[];
};
export function AppOverview({
  settings = false,
  single = false,
  ...props
}: AppProps & { settings?: boolean; single?: boolean }) {
  if (settings) return <AppSettings {...props} />;
  // OneAppProject keeps its compact web-app overview; workers use the health detail board.
  return single && props.app.kind === 'web' ? (
    <SingleAppOverview {...props} />
  ) : (
    <AppHealthOverview {...props} />
  );
}

function AppHealthOverview({ project, app }: AppProps) {
  const healthDetail = useLive(app.name);
  return (
    <>
      {healthDetail.error && (
        <Banner
          title={healthDetail.error}
          action={<Action onClick={healthDetail.retry}>Retry</Action>}
        />
      )}
      {healthDetail.detail && healthDetail.live ? (
        <AppDetail
          detail={healthDetail.detail}
          live={healthDetail.live}
          items={healthDetail.items}
          projectName={project.name}
          refresh={healthDetail.retry}
        />
      ) : !healthDetail.error ? (
        <Skeleton rows={5} />
      ) : null}
    </>
  );
}
export function AppSettings({ project, app, overview }: Omit<AppProps, 'releases'>) {
  const coordinator = useCoordinatorName();
  const live = useData<LiveAppResponse>(`/api/v2/live/${projectSegment(app.name)}`);
  const [memory, setMemory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [savedLimit, setSavedLimit] = useState<string>();
  const health = live.data?.app;
  const runtime = overview.apps.find((entry) => entry.id === app.id);
  async function change() {
    setBusy(true);
    setError('');
    try {
      await request(`/api/deployments/${encodeURIComponent(app.name)}`, {
        method: 'PATCH',
        body: JSON.stringify({ memoryLimit: memory }),
      });
      setSaved(true);
      setSavedLimit(memory);
      live.refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {project.apps.length > 1 && (
        <Banner
          title="Variables, secrets, releases and logs belong to the project"
          action={
            <a className="dl-btn quiet" href={`${projectPath(project.id)}/settings`}>
              Project settings
            </a>
          }
        >
          The project's apps share them.
        </Banner>
      )}
      <section className="dl-section">
        <h2 className="dl-section-title">Address</h2>
        <Group>
          <Setting
            label="Domains"
            description="Addresses and health checks are declared in deploy.yaml"
          >
            {!live.data && !live.error ? (
              <Skeleton rows={1} />
            ) : health?.address ? (
              <a href={health.address}>{new URL(health.address).host}</a>
            ) : app.kind === 'worker' ? (
              'No address'
            ) : (
              'Unavailable'
            )}
          </Setting>
        </Group>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Health and resources</h2>
        <Group>
          <Setting label="Health check">
            {!live.data && !live.error ? (
              <Skeleton rows={1} />
            ) : health?.http ? (
              `GET ${health.http.path}`
            ) : (
              health?.summary || 'Health could not be loaded'
            )}
          </Setting>
          <Setting
            label="Memory limit"
            description={`Current limit: ${savedLimit ?? (runtime?.memoryLimit || 'No limit')}`}
          >
            <Field
              label="New memory limit"
              placeholder="1g"
              value={memory}
              onChange={(event) => setMemory(event.target.value)}
            />
            <Action disabled={!memory} loading={busy} onClick={() => void change()}>
              Save
            </Action>
          </Setting>
          <Setting label="Runs on">
            {runtime?.computer === 'coordinator' ? coordinator : runtime?.computer || 'Unavailable'}
          </Setting>
        </Group>
      </section>
      {error && <Banner title={error} />}
      {saved && <Banner title="Memory limit saved" />}
      {project.apps.length > 1 &&
        !project.fromDiscover &&
        !overview.repository &&
        !overview.repositoryError && <NoRepository project={project} />}
    </>
  );
}

function SingleAppOverview({ project, app, overview, releases }: AppProps) {
  const coordinator = useCoordinatorName();
  const live = useData<LiveAppResponse>(`/api/v2/live/${projectSegment(app.name)}`);
  const [restart, setRestart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const health = live.data?.app;
  const runtime = overview.apps.find((entry) => entry.id === app.id);
  async function restartApp() {
    setBusy(true);
    setError('');
    try {
      await request(`/api/deployments/${encodeURIComponent(app.name)}/restart`, { method: 'POST' });
      setRestart(false);
      live.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restart the app.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {live.error && (
        <Banner
          title="Health is unavailable"
          action={<Action onClick={live.refresh}>Retry</Action>}
        />
      )}
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title">
            {app.name} <Health app={health} />
          </h1>
          <span className="dl-meta">
            {health?.address && <a href={health.address}>{new URL(health.address).host}</a>}
            {health?.release && ` · ${health.release}`}{' '}
            {runtime?.computer &&
              ` · on ${runtime.computer === 'coordinator' ? coordinator : runtime.computer}`}
          </span>
        </div>
        <span className="dl-end">
          <Action onClick={() => setRestart(true)}>Restart</Action>
          {health?.address && (
            <a className="dl-btn primary" href={health.address} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
        </span>
      </div>
      {health?.state === 'warning' || health?.state === 'failing' ? (
        <Banner title={health.summary} />
      ) : null}
      {!health ? (
        !live.error && <Skeleton rows={2} />
      ) : (
        <div className="dl-stats">
          {[
            { label: 'Requests per minute', ...trafficMetrics(health).rate },
            { label: 'p95 latency', ...trafficMetrics(health).latency },
            { label: 'Memory', ...memoryMetric(health) },
          ].map((metric) => (
            <div className="dl-stat" key={metric.label}>
              <span className="dl-meta">{metric.label}</span>
              <span className="dl-v">{metric.value}</span>
              {metric.note && <span className="dl-meta">{metric.note}</span>}
            </div>
          ))}
        </div>
      )}
      <div className="dl-cols">
        <section className="dl-section">
          <h2 className="dl-section-title">Runtime</h2>
          <Group>
            <Setting label="Computer">
              {runtime?.computer === 'coordinator'
                ? coordinator
                : runtime?.computer || 'Unavailable'}
            </Setting>
            <Setting label="Health check">
              {health?.http ? `GET ${health.http.path}` : health?.summary || 'Unavailable'}
            </Setting>
            <Setting label="Memory limit">{runtime?.memoryLimit || 'No limit'}</Setting>
          </Group>
        </section>
        <ReleaseList project={project} releases={releases} />
      </div>
      <Dialog
        open={restart}
        onClose={() => {
          if (!busy) setRestart(false);
        }}
        title={`Restart ${app.name}?`}
        actions={
          <>
            <Action disabled={busy} onClick={() => setRestart(false)}>
              Cancel
            </Action>
            <Action variant="primary" loading={busy} onClick={() => void restartApp()}>
              Restart
            </Action>
          </>
        }
      >
        <p>The app will be briefly unavailable while it restarts.</p>
        {error && <Banner title={error} />}
      </Dialog>
    </>
  );
}
