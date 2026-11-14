'use client';
import './projects.css';
import { useState } from 'react';
import { Action, Banner, Dialog, Field, Glyph, Group, Icon, Item } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import type { RepositoryPreview } from '../../../../../server/v2/start';
import { repositoryAddress } from '../../../../../shared/repository-address';
import { useCoordinatorName } from '../data/hooks';
import { request, useData, useBrowserHost } from './data';

/**
 * New project: a name, and a remote to keep in sync if there is one. Every project is hosted on
 * deploy.local, so leaving the remote empty is a project of its own, not a missing field.
 */
export function NewProjectDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (project: Project) => void | Promise<void>;
}) {
  const coordinator = useCoordinatorName();
  const available = useData<{ apps: Project['apps'] }>(
    open ? '/api/projects/unlinked-apps' : undefined,
  );
  const host = useBrowserHost();
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState<RepositoryPreview>();
  const [inspecting, setInspecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remote = source.trim();
  const folder = remote.startsWith('/');
  const called = name.trim() || 'it';
  const address = repositoryAddress(name.trim());
  const existing = available.data?.apps.some((app) => app.name === name.trim());
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  async function inspect() {
    setInspecting(true);
    setError('');
    try {
      setPreview(
        await request('/api/start/inspect', {
          method: 'POST',
          body: JSON.stringify({ sourcePath: remote }),
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not inspect the repository.');
    } finally {
      setInspecting(false);
    }
  }
  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const project = await request<Project>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          name,
          sourcePath: remote,
          operationId: operation,
        }),
      });
      await onCreated(project);
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="New project"
      className="v2-new-project-dialog"
      actions={
        <>
          <Action variant="quiet" disabled={busy} onClick={onClose}>
            Cancel
          </Action>
          <Action
            variant="primary"
            disabled={!name.trim() || inspecting}
            loading={busy}
            onClick={() => void create()}
          >
            {existing ? `Add repository to ${name.trim()}` : 'Create project'}
          </Action>
        </>
      }
    >
      <form
        className="v2-new-project"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) void create();
        }}
      >
        <div>
          <Field
            label="Name"
            value={name}
            required
            disabled={busy}
            onChange={(event) => {
              setName(event.target.value);
              setOperation(crypto.randomUUID());
            }}
          />
          {address && host && (
            <p className="dl-meta v2-field-help">
              {existing
                ? `${name.trim()} is already an app here, with no repository. This adds one to it at `
                : 'Hosted on deploy.local at '}
              <span className="dl-mono">
                {host}/{address}.git
              </span>
              {existing && ' instead of starting a second project.'}
            </p>
          )}
        </div>
        <div>
          <Field
            label={
              <>
                Remote <span className="dl-meta">Optional</span>
              </>
            }
            value={source}
            disabled={inspecting || busy}
            className="dl-mono"
            placeholder={`git@github.com:you/${address || 'app'}.git or a folder on ${coordinator}`}
            onChange={(event) => {
              setSource(event.target.value);
              setOperation(crypto.randomUUID());
              setPreview(undefined);
            }}
          />
          <p className="dl-meta v2-field-help">
            {existing || !remote
              ? `Leave it empty to keep ${called} only on deploy.local. You can add a remote later in Settings.`
              : folder
                ? `deploy.local hosts ${called} and fetches from this folder on ${coordinator} when you sync. Nothing runs until you create the project.`
                : `deploy.local hosts ${called} and keeps it in sync with this remote, using the SSH key on ${coordinator}. Nothing runs until you create the project.`}
          </p>
        </div>
        {remote && !preview && (
          <Action
            className="v2-new-project-inspect"
            disabled={inspecting || busy}
            loading={inspecting}
            onClick={() => void inspect()}
          >
            Inspect repository
          </Action>
        )}
        {preview && (
          <section>
            <span className="dl-field-label">Found in the repository</span>
            <Group>
              {preview.found.map((item, index) => (
                <Item
                  key={`${item.name}:${index}`}
                  title={item.name}
                  description={item.detail}
                  lead={
                    <Glyph kind="plain">
                      <Icon name="folder" size={12} />
                    </Glyph>
                  }
                  end="Found"
                />
              ))}
            </Group>
            {!preview.found.length && (
              <p className="dl-meta v2-field-help">
                No app configuration found. A task can write deploy.yaml for you.
              </p>
            )}
          </section>
        )}
        {preview && (
          <div className="v2-new-project-columns">
            <Field label="Runs on" value={preview.runsOn || 'Choose when you ship'} readOnly />
            <Field
              label="Address"
              value={preview.address || 'Set in deploy.yaml before shipping'}
              readOnly
            />
          </div>
        )}
        {error && <Banner kind="danger" title={error} />}
      </form>
    </Dialog>
  );
}
