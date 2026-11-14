'use client';
import { useState } from 'react';
import { Action, Banner, Dialog, Field, Group, Item, Setting, Skeleton } from '@/components/ui';
import type { LiveResponse, Project } from '../../../../../shared/v2/contracts';
import { repositoryAddress } from '../../../../../shared/repository-address';
import { useCoordinatorName, useResource } from '../data/hooks';
import { appAddress } from '../live/presentation';
import { request, useData, useBrowserHost } from './data';
import { projectPath, projectSegment } from './routing';
import { orderUnlinkedApps } from './presentation';

export function NoRepository({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Repository</h2>
      <Group>
        <div className="dl-inset">
          <Setting
            label="No repository"
            description={`${project.name} was shipped from a folder. Add a repository to start tasks on it, review pull requests and release from merges.`}
          >
            <Action variant="secondary" onClick={() => setOpen(true)}>
              Add a repository
            </Action>
          </Setting>
        </div>
      </Group>
      {open && <AddRepositoryDialog project={project} onClose={() => setOpen(false)} />}
    </section>
  );
}

export function AddRepositoryDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}) {
  const coordinator = useCoordinatorName();
  const host = useBrowserHost();
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  const address = repositoryAddress(project.name);
  async function add() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const created = await request<Project>(
        `/api/projects/${projectSegment(project.id)}/repository`,
        {
          method: 'POST',
          body: JSON.stringify({ sourcePath: source.trim(), operationId: operation }),
        },
      );
      window.location.assign(projectPath(created.id));
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={`Add a repository to ${project.name}`}
      className="v2-new-project-dialog"
      actions={
        <>
          <Action variant="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </Action>
          <Action variant="primary" loading={busy} onClick={() => void add()}>
            Add repository
          </Action>
        </>
      }
    >
      <form
        className="v2-new-project"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <p className="dl-meta">
          deploy.local hosts it at{' '}
          <span className="dl-mono">
            {host}/{address}.git
          </span>
          . {project.name} keeps running as it is, and stays one project.
        </p>
        <div>
          <Field
            label={
              <>
                Remote <span className="dl-meta">Optional</span>
              </>
            }
            value={source}
            disabled={busy}
            className="dl-mono"
            placeholder={`git@github.com:you/${address}.git or a folder on ${coordinator}`}
            onChange={(event) => {
              setSource(event.target.value);
              setOperation(crypto.randomUUID());
            }}
          />
          <p className="dl-meta v2-field-help">
            Leave it empty and push the code from its folder afterwards. You can add a remote later
            in Settings.
          </p>
        </div>
        {error && <Banner kind="danger" title={error} />}
      </form>
    </Dialog>
  );
}

export function AddExistingAppDialog({
  project,
  onClose,
  onAdded,
}: {
  project: Project;
  onClose: () => void;
  onAdded: () => void;
}) {
  const available = useData<{ apps: Project['apps'] }>('/api/projects/unlinked-apps');
  const live = useResource<LiveResponse>('/api/live');
  const coordinator = useCoordinatorName();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function add(app: string) {
    if (busy) return;
    setBusy(app);
    setError('');
    try {
      await request(`/api/projects/${projectSegment(project.id)}/apps`, {
        method: 'POST',
        body: JSON.stringify({ app }),
      });
      onAdded();
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
      available.refresh();
    } finally {
      setBusy('');
    }
  }
  return (
    <Dialog
      open
      title={`Add an app to ${project.name}`}
      className="v2-new-project-dialog"
      onClose={() => {
        if (!busy) onClose();
      }}
      actions={
        <Action variant="quiet" disabled={!!busy} onClick={onClose}>
          Cancel
        </Action>
      }
    >
      <p className="dl-meta">
        Apps you shipped from a folder that have no repository yet. The app keeps running, and its
        variables, secrets and releases move into {project.name}.
      </p>
      {!available.data && !available.error && <Skeleton rows={2} />}
      <Group>
        {orderUnlinkedApps(available.data?.apps || [], project.name).map((app) => {
          const computer = live.data?.computers.find((entry) =>
            entry.apps.some((item) => item.appId === app.id),
          );
          const health = computer?.apps.find((entry) => entry.appId === app.id);
          return (
            <Item
              key={app.id}
              title={app.name}
              description={`${health ? appAddress(health) : 'Address unavailable'} · on ${computer?.id === 'coordinator' ? coordinator : computer?.name || 'computer unavailable'}${app.name === project.name ? ' · same name as this project' : ''}`}
              end={
                <Action
                  variant="secondary"
                  disabled={!!busy}
                  loading={busy === app.name}
                  onClick={() => void add(app.name)}
                >
                  Add
                </Action>
              }
            />
          );
        })}
      </Group>
      {available.data?.apps.length === 0 && <p className="dl-meta">No apps with no repository.</p>}
      {available.error && (
        <Banner
          title={available.error}
          action={<Action onClick={available.refresh}>Retry</Action>}
        />
      )}
      {error && <Banner kind="danger" title={error} />}
    </Dialog>
  );
}
