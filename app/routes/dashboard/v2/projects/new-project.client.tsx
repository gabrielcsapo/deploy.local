'use client';
import { useState, useSyncExternalStore } from 'react';
import { Action, Banner, Dialog, Field, Glyph, Group, Icon, Item } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import type { RepositoryPreview } from '../../../../../server/v2/start';
import { repositoryAddress } from '../../../../../shared/repository-address';
import { useCoordinatorName } from '../data/hooks';
import { request } from './data';

// The host never changes while a page is open, so there is nothing to subscribe to.
const subscribeToNothing = () => () => {};

/** The address bar's host, or nothing on the server, which has no window to read it from. */
function useBrowserHost() {
  return useSyncExternalStore(
    subscribeToNothing,
    () => window.location.host,
    () => '',
  );
}

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
  async function inspect() {
    setInspecting(true);
    setError('');
    try {
      setPreview(
        await request('/api/v2/start/inspect', {
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
    setBusy(true);
    setError('');
    try {
      const project = await request<Project>('/api/workspace/projects', {
        method: 'POST',
        body: JSON.stringify({
          name,
          sourcePath: remote,
          operationId: crypto.randomUUID(),
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
          <Action disabled={busy} onClick={onClose}>
            Cancel
          </Action>
          <Action
            variant="primary"
            disabled={!name.trim() || inspecting}
            loading={busy}
            onClick={() => void create()}
          >
            Create project
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
            onChange={(event) => setName(event.target.value)}
          />
          {address && host && (
            <p className="dl-meta v2-field-help">
              Hosted on deploy.local at{' '}
              <span className="dl-mono">
                {host}/{address}.git
              </span>
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
            disabled={inspecting}
            className="dl-mono"
            placeholder={`git@github.com:you/${address || 'app'}.git or a folder on ${coordinator}`}
            onChange={(event) => {
              setSource(event.target.value);
              setPreview(undefined);
            }}
          />
          <p className="dl-meta v2-field-help">
            {!remote
              ? `Leave it empty to keep ${called} only on deploy.local. You can add a remote later in Settings.`
              : folder
                ? `deploy.local hosts ${called} and fetches from this folder on ${coordinator} when you sync. Nothing runs until you create the project.`
                : `deploy.local hosts ${called} and keeps it in sync with this remote, using the SSH key on ${coordinator}. Nothing runs until you create the project.`}
          </p>
        </div>
        {remote && !preview && (
          <Action
            className="v2-new-project-inspect"
            disabled={inspecting}
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
