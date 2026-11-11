'use client';
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
import { useLive } from '../live/data';
import { AppDetail } from '../live/page.client';
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
function AppSettings({ project, app, overview }: AppProps) {
  const live = useData<LiveAppResponse>(`/api/v2/live/${projectSegment(app.name)}`);
  const [memory, setMemory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
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
      live.refresh();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
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
      <section className="dl-section">
        <h2 className="dl-section-title">Address</h2>
        <Group>
          <Setting
            label="Domains"
            description="Addresses and health checks are declared in deploy.yaml"
          >
            {health?.address ? (
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
            {health?.http ? `GET ${health.http.path}` : health?.summary || 'Unavailable'}
          </Setting>
          <Setting
            label="Memory limit"
            description={`Current limit: ${runtime?.memoryLimit || 'Unavailable'}`}
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
          <Setting label="Runs on">{runtime?.computer || 'Unavailable'}</Setting>
        </Group>
      </section>
      {error && <Banner title={error} />}
      {saved && <Banner title="Memory limit saved" />}
    </>
  );
}

function SingleAppOverview({ project, app, overview, releases }: AppProps) {
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
            {runtime?.computer && ` · on ${runtime.computer}`}
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
      {!health && !live.error ? (
        <Skeleton rows={2} />
      ) : (
        <div className="dl-stats">
          <div className="dl-stat">
            <span className="dl-meta">
              {app.kind === 'worker' ? 'Jobs per minute' : 'Requests per minute'}
            </span>
            <span className="dl-v">
              {health?.http?.reqPerMin ?? health?.jobs?.perMin ?? 'Unavailable'}
            </span>
          </div>
          <div className="dl-stat">
            <span className="dl-meta">
              {app.kind === 'worker' ? 'Job failures' : 'p95 latency'}
            </span>
            <span className="dl-v">
              {health?.http
                ? `${health.http.p95ms} ms`
                : health?.jobs
                  ? `${Math.round(health.jobs.failRate * 100)}%`
                  : 'Unavailable'}
            </span>
          </div>
          {app.kind === 'worker' && (
            <div className="dl-stat">
              <span className="dl-meta">Queue</span>
              <span className="dl-v">{health?.queue?.depth ?? 'Unavailable'}</span>
            </div>
          )}
        </div>
      )}
      <div className="dl-cols">
        <section className="dl-section">
          <h2 className="dl-section-title">Runtime</h2>
          <Group>
            <Setting label="Computer">{runtime?.computer || 'Unavailable'}</Setting>
            <Setting label="Health check">
              {health?.http ? `GET ${health.http.path}` : health?.summary || 'Unavailable'}
            </Setting>
            <Setting label="Memory limit">{runtime?.memoryLimit || 'Unavailable'}</Setting>
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
