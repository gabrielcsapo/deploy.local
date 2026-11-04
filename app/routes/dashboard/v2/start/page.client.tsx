'use client';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Composer,
  Field,
  Glyph,
  Group,
  Head,
  IconButton,
  Item,
} from '@/components/ui';
import { api } from '../../../v2-public/client';
import { PasskeyOffer } from './account.client';
import './start.css';
import { NewProjectDialog } from '../projects/new-project.client';
import { shouldShowFirstTask } from './first-task';
import { useCoordinatorName } from '../data/hooks';

export function FirstTask() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let mounted = true;
    setVisible(false);
    const taskId = pathname.match(/^\/dashboard\/tasks\/([^/]+)$/)?.[1];
    if (!taskId) return;
    void Promise.all([api('/api/v2/auth/account'), api(`/api/v2/tasks/${taskId}`)])
      .then(async ([account, task]) => {
        if (!mounted || !shouldShowFirstTask(account.firstTaskSeen, task.firstTask)) return;
        await api('/api/v2/auth/account', { firstTaskSeen: true });
        if (mounted) setVisible(true);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, [pathname]);
  async function dismiss() {
    await api('/api/v2/auth/account', { firstTaskSeen: true });
    setVisible(false);
  }
  return visible ? (
    <aside className="v2-first-task">
      <div className="v2-first-task-head">
        <strong>Your first task</strong>
        <Action variant="quiet" onClick={() => void dismiss()}>
          Got it
        </Action>
      </div>
      <div className="v2-first-task-grid">
        {[
          ['Task', 'The agent works in its own copy of the code, on a free computer'],
          ['Pull request', 'You review the change; a second model reviews it first'],
          ['Release', 'Merging ships it, and every app in the project moves together'],
        ].map(([title, text], index) => (
          <div key={title}>
            <span className="dl-meta">{index + 1} of 3</span>
            <p>
              <strong>{title}</strong>
            </p>
            <p className="dl-meta">{text}</p>
          </div>
        ))}
      </div>
    </aside>
  ) : null;
}
function NewProject() {
  return (
    <>
      <Head title="Projects" />
      <div className="dl-page v2-start-page">
        <h1 className="dl-title">Projects</h1>
        <p className="dl-soft">Repositories, and apps installed from Discover</p>
      </div>
      <NewProjectDialog
        open
        onClose={() => window.location.assign('/dashboard/start')}
        onCreated={async (project) => {
          await api('/api/v2/auth/account', { welcomed: true });
          window.location.assign(`/dashboard/projects/${encodeURIComponent(project.id)}`);
        }}
      />
    </>
  );
}
function Welcome() {
  const coordinator = useCoordinatorName();
  const [error, setError] = useState('');
  return (
    <>
      <Head
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <PasskeyOffer />
      <div className="dl-scroll dl-home-scroll">
        <div className="dl-col dl-home-col">
          <div className="dl-greeting">
            <span className="dl-mark dl-home-mark">d</span>
            <h1 className="dl-title">Welcome to deploy.local</h1>
            <span className="dl-soft">
              {coordinator[0].toUpperCase() + coordinator.slice(1)} is running and ready. Start with
              a project or an app, then add agents to keep working on it in the background.
            </span>
          </div>
          <div className="dl-home-composer">
            <Composer
              project="New task"
              model="Default"
              onSend={(text) => {
                void api('/api/workspace/tasks', {
                  title: text,
                  prompt: text,
                  operationId: crypto.randomUUID(),
                })
                  .then((task) =>
                    window.location.assign(`/dashboard/tasks/${encodeURIComponent(task.id)}`),
                  )
                  .catch((error) => setError(error.message));
              }}
            />
          </div>
          <Group aria-label="Quick actions">
            <Item
              title="Add a project"
              description="A repository and the apps it runs. A task writes the deploy file for you."
              href="/dashboard/start/project"
              end="New project"
            />
            <Item
              title="Or install an app"
              description="Immich, Vaultwarden, Miniflux and more, on your own computer"
              href="/dashboard/start/apps"
              end="Discover apps"
            />
            <Item
              title="Add another computer"
              description="Optional. Install the app on a laptop or desktop and it can take tasks"
              href="/dashboard/computers/add"
              end="Add a computer"
            />
          </Group>
          {error && <Banner kind="danger" title={error} />}
        </div>
      </div>
    </>
  );
}
function InstallApp() {
  const coordinator = useCoordinatorName();
  const { pathname } = useLocation();
  const [releases, setReleases] = useState<any[]>([]);
  const [targets, setTargets] = useState<any[]>([]);
  const [release, setRelease] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>();
  useEffect(() => {
    void Promise.all([api('/api/catalog'), api('/api/catalog/targets')])
      .then(([catalog, computers]) => {
        setReleases(catalog.releases);
        const selected = catalog.releases.find((item: any) =>
          pathname.endsWith(`/discover/${encodeURIComponent(item.id)}`),
        );
        if (selected) setRelease(selected);
        setTargets(computers.targets);
      })
      .catch((error) => setError(error.message));
  }, [pathname]);
  useEffect(() => {
    if (!release) return;
    setDetail(undefined);
    void api(
      `/api/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}`,
    )
      .then(setDetail)
      .catch((error) => setError(error.message));
  }, [release]);
  async function install(form: HTMLFormElement) {
    setBusy(true);
    setError('');
    const fields = Object.fromEntries(new FormData(form));
    const answers = Object.fromEntries(
      Object.entries(fields)
        .filter(([key]) => key.startsWith('answer:'))
        .map(([key, value]) => [key.slice(7), value]),
    );
    try {
      const value = await api(
        `/api/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}/install`,
        { applicationName: fields.applicationName, targetSiteId: fields.targetSiteId, answers },
      );
      setResult(value);
      await api('/api/v2/auth/account', { welcomed: true });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const blueprint = detail?.release;
  const resources = Object.entries(blueprint?.application?.resources || {}) as [string, any][];
  return (
    <>
      <Head title="Discover" subtitle={release?.name} />
      <div className="dl-page v2-start-page v2-install-page">
        {result ? (
          <>
            <h1 className="dl-title">{result.installation.applicationName}</h1>
            <p className="dl-soft">{result.operation.status}</p>
            <a className="dl-btn primary" href="/dashboard/live">
              Open Live
            </a>
          </>
        ) : !release ? (
          <>
            <h1 className="dl-title">Discover apps</h1>
            <Group>
              {releases.map((item) => (
                <Item
                  key={`${item.id}:${item.release}`}
                  title={item.name}
                  description={item.summary}
                  end={<Action onClick={() => setRelease(item)}>Install…</Action>}
                />
              ))}
            </Group>
          </>
        ) : (
          <>
            <div className="v2-install-heading">
              <Glyph>{release.name[0]}</Glyph>
              <div>
                <h1 className="dl-title">Install {release.name}</h1>
                <p className="dl-meta">
                  {release.summary} · {release.release} · published image, no code to change
                </p>
              </div>
            </div>
            <form
              className="v2-start-form"
              onSubmit={(event) => {
                event.preventDefault();
                void install(event.currentTarget);
              }}
            >
              <div>
                <h2 className="dl-section-title">Where it runs</h2>
                <p className="dl-meta">Other computers appear here once you add them.</p>
                <Group>
                  {targets.map((target, index) => (
                    <label className="dl-item" key={target.siteId}>
                      <input
                        type="radio"
                        name="targetSiteId"
                        value={target.siteId}
                        defaultChecked={index === 0}
                        required
                      />
                      <span className="dl-t">
                        <span>
                          {target.name ||
                            (target.siteId === 'coordinator' ? 'Coordinator' : target.siteId)}
                        </span>
                        <span className="dl-meta">
                          {[
                            target.siteKind === 'coordinator' ? 'Coordinator' : '',
                            target.memoryMiB
                              ? `${Math.round(target.memoryMiB / 1024)} GB memory`
                              : '',
                            target.storageMiB
                              ? `${Math.round(target.storageMiB / 1024)} GB disk available`
                              : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                      {targets.length === 1 && <span className="dl-tag">Only computer</span>}
                    </label>
                  ))}
                </Group>
              </div>
              <Field
                label="App name"
                name="applicationName"
                defaultValue={release.id}
                required
                pattern="[a-z0-9][a-z0-9-]*"
              />
              <p className="dl-meta">Gets an address and a certificate from {coordinator}.</p>
              {blueprint?.questions?.map((question: any) => (
                <div key={question.key}>
                  <Field
                    label={question.label}
                    name={`answer:${question.key}`}
                    type={question.secret ? 'password' : 'text'}
                    required={question.required}
                  />
                  <p className="dl-meta">{question.help}</p>
                </div>
              ))}
              <section>
                <h2 className="dl-section-title">Your data</h2>
                <p className="dl-section-sub">Kept outside the app, so updates preserve it.</p>
                <Group>
                  {resources.map(([name, resource]) => (
                    <Item
                      key={name}
                      title={resource.displayName || name}
                      description={
                        resource.source?.hostPath || 'Persistent volume on the selected computer'
                      }
                      end={
                        resource.backup?.policy === 'exclude'
                          ? 'Not backed up'
                          : 'Included in backups'
                      }
                    />
                  ))}
                </Group>
                {!resources.length && (
                  <p className="dl-meta">
                    {detail
                      ? 'This app declares no persistent data.'
                      : 'Loading data requirements…'}
                  </p>
                )}
              </section>
              <div>
                <h2 className="dl-section-title">First account</h2>
                <p className="dl-meta">
                  {release.name} asks for an admin on first open. deploy.local does not create
                  accounts inside apps.
                </p>
              </div>
              <div className="v2-start-tabs">
                <Action onClick={() => setRelease(undefined)}>Cancel</Action>
                <Action
                  variant="primary"
                  type="submit"
                  loading={busy}
                  disabled={!detail || !targets.length}
                >
                  Install {release.name}
                </Action>
              </div>
            </form>
          </>
        )}
        {error && <Banner kind="danger" title={error} />}
      </div>
    </>
  );
}
export default function StartPage() {
  const { pathname } = useLocation();
  return pathname.endsWith('/project') ? (
    <NewProject />
  ) : pathname.endsWith('/apps') || pathname.startsWith('/dashboard/discover') ? (
    <InstallApp />
  ) : (
    <Welcome />
  );
}
