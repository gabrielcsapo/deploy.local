'use client';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner, Composer, Dialog, Field, Group, Head, Item } from '@/components/ui';
import { api } from '../../../v2-public/client';
import { PasskeyOffer } from './account.client';
import './start.css';

export function FirstTask() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let mounted = true;
    void api('/api/v2/auth/account')
      .then(async (account) => {
        if (!mounted || account.firstTaskSeen) return;
        await api('/api/v2/auth/account', { firstTaskSeen: true });
        if (mounted) setVisible(true);
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);
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
          ['Task', 'Scout works in its own copy of the code, on a free computer'],
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
  const [mode, setMode] = useState('repository');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function create(form: HTMLFormElement) {
    setBusy(true);
    setError('');
    try {
      const fields = Object.fromEntries(new FormData(form));
      const project = await api('/api/workspace/projects', {
        ...fields,
        operationId: crypto.randomUUID(),
      });
      await api('/api/v2/auth/account', { welcomed: true });
      window.location.assign(`/dashboard/projects/${encodeURIComponent(project.id)}`);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Head title="Projects" />
      <div className="dl-page v2-start-page">
        <h1 className="dl-title">Projects</h1>
        <p className="dl-soft">Repositories, and apps installed from Discover</p>
      </div>
      <Dialog open title="New project" onClose={() => window.location.assign('/dashboard/start')}>
        <form
          className="v2-start-form"
          onSubmit={(event) => {
            event.preventDefault();
            void create(event.currentTarget);
          }}
        >
          <div className="v2-start-tabs">
            {[
              ['repository', 'From a repository'],
              ['folder', 'From a folder'],
              ['empty', 'Empty'],
            ].map(([value, label]) => (
              <Action key={value} aria-pressed={mode === value} onClick={() => setMode(value)}>
                {label}
              </Action>
            ))}
          </div>
          <Field label="Project name" name="name" required />
          {mode !== 'empty' && (
            <Field
              label={mode === 'folder' ? 'Folder on SER' : 'Repository'}
              name="sourcePath"
              placeholder={
                mode === 'folder' ? '/srv/projects/home-gym' : 'git@github.com:gabriel/home-gym.git'
              }
              required
            />
          )}
          <p className="dl-meta">
            {mode === 'folder'
              ? 'Use a folder on SER. Your browser cannot read folders on another computer.'
              : 'Read with the SSH key on SER. Nothing runs until you create the project.'}
          </p>
          <p className="dl-soft">
            Scout can help write deploy.yaml after the repository is ready. You review it before
            shipping.
          </p>
          {error && <Banner kind="danger" title={error} />}
          <div className="v2-start-tabs">
            <Action onClick={() => window.location.assign('/dashboard/start')}>Cancel</Action>
            <Action variant="primary" type="submit" loading={busy}>
              Create project
            </Action>
          </div>
        </form>
      </Dialog>
    </>
  );
}
function Welcome() {
  const [error, setError] = useState('');
  return (
    <>
      <Head />
      <PasskeyOffer />
      <div className="dl-scroll dl-home-scroll">
        <div className="dl-col dl-home-col">
          <div className="dl-greeting">
            <span className="dl-mark dl-home-mark">d</span>
            <h1 className="dl-title">Welcome to deploy.local</h1>
            <span className="dl-soft">
              SER is running and ready. Start with a project or an app; Scout and Warden begin once
              there is something to work on.
            </span>
          </div>
          <Group>
            <Item
              title="Add a project"
              description="A repository and the apps it runs. Scout writes the deploy file for you."
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
          {error && <Banner kind="danger" title={error} />}
        </div>
      </div>
    </>
  );
}
function InstallApp() {
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
        setTargets(computers.targets);
      })
      .catch((error) => setError(error.message));
  }, []);
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
  return (
    <>
      <Head title="Discover" subtitle={release?.name} />
      <div className="dl-page v2-start-page">
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
            <h1 className="dl-title">Install {release.name}</h1>
            <p className="dl-soft">
              {release.summary} · {release.release} · published image, no code to change
            </p>
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
                <label className="dl-field-label" htmlFor="target">
                  Computer
                </label>
                <select className="dl-field" name="targetSiteId" id="target" required>
                  {targets.map((target) => (
                    <option key={target.siteId} value={target.siteId}>
                      {target.name || target.siteId}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                label="App name"
                name="applicationName"
                defaultValue={release.id}
                required
                pattern="[a-z0-9][a-z0-9-]*"
              />
              <p className="dl-meta">Gets an address and a certificate from SER.</p>
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
