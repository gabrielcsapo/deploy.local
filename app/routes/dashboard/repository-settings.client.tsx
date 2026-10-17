'use client';
import { Button, TextField } from '@/components/ui';
import { useEffect, useState } from 'react';
import './repository-management.css';
type Row = Record<string, any>;
type Draft = { name: string; description: string; revision: number };
const drafts = new Map<string, Draft>();
export function RepositorySettings({
  project,
  repository,
  api,
  refresh,
  updateProject,
}: {
  project: Row;
  repository: Row | null;
  api: (path: string, body?: Row) => Promise<any>;
  refresh: () => Promise<void>;
  updateProject: (project: Row) => void;
}) {
  const [draft, setDraft] = useState<Draft>(
    () =>
      drafts.get(project.id) || {
        name: project.name,
        description: project.description || '',
        revision: project.settingsRevision || 0,
      },
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const base = `/projects/${project.id}`;
  const changed =
    draft.name.trim() !== project.name || draft.description.trim() !== (project.description || '');
  const conflict = !busy && draft.revision !== (project.settingsRevision || 0);
  const cloneURL =
    typeof window !== 'undefined' && repository?.clonePath
      ? window.location.origin + repository.clonePath
      : '';
  const operation = repository?.operation;
  const activeOperation = operation && ['queued', 'running'].includes(operation.status);
  useEffect(() => {
    drafts.set(project.id, draft);
  }, [project.id, draft]);
  function reload() {
    setDraft({
      name: project.name,
      description: project.description || '',
      revision: project.settingsRevision || 0,
    });
    setError('');
    setFeedback('');
  }
  async function action(name: string, run: () => Promise<void>) {
    setBusy(name);
    setError('');
    setFeedback('');
    try {
      await run();
    } catch (failure: any) {
      setError(failure.message);
      if (failure.status === 409) {
        const refreshed = await refresh().then(
          () => true,
          () => false,
        );
        if (refreshed && name === 'save') setError('');
      }
    } finally {
      setBusy('');
    }
  }
  return (
    <section className="rm-pane" aria-label="Repository settings">
      <header className="rm-toolbar">
        <strong>Settings</strong>
      </header>
      <div
        className="rm-scroll rm-settings-scroll"
        tabIndex={0}
        aria-label="Repository configuration"
      >
        <form
          className="rm-settings-section"
          onSubmit={(event) => {
            event.preventDefault();
            void action('save', async () => {
              const saved = await api(base + '/settings', {
                name: draft.name.trim(),
                description: draft.description.trim(),
                settingsRevision: draft.revision,
              });
              setDraft({
                name: saved.name,
                description: saved.description || '',
                revision: saved.settingsRevision,
              });
              updateProject(saved);
              setFeedback('Changes saved');
            });
          }}
        >
          <h2>General</h2>
          <TextField
            label="Repository name"
            value={draft.name}
            maxLength={120}
            required
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              setFeedback('');
            }}
          />
          <TextField
            label="Description"
            placeholder="What this repository is for"
            value={draft.description}
            maxLength={240}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
              setFeedback('');
            }}
          />
          {conflict && (
            <div className="rm-feedback" role="alert">
              <p>
                Repository settings changed in another session. Reload the saved values before
                saving again.
              </p>
              <Button
                onClick={() =>
                  void action('reload', async () => {
                    const saved = await api(base + '/settings');
                    setDraft({
                      name: saved.name,
                      description: saved.description,
                      revision: saved.settingsRevision,
                    });
                    await refresh();
                    setFeedback('Saved values loaded');
                  })
                }
              >
                Reload saved values
              </Button>
            </div>
          )}
          <div className="rm-form-actions">
            <Button
              type="submit"
              variant="primary"
              disabled={!changed || !draft.name.trim() || !!busy || conflict}
            >
              {busy === 'save' ? 'Saving…' : 'Save changes'}
            </Button>
            {changed && (
              <Button variant="quiet" disabled={!!busy} onClick={reload}>
                Discard changes
              </Button>
            )}
          </div>
        </form>
        {error && (
          <div className="rm-feedback" role="alert">
            <p>{error}</p>
          </div>
        )}
        {feedback && (
          <p className="rm-save-feedback" role="status">
            {feedback}
          </p>
        )}
        <section className="rm-settings-section">
          <h2>Git connection</h2>
          {!repository ? (
            <p role="status">Loading repository configuration…</p>
          ) : (
            <>
              <TextField
                label="HTTPS clone URL"
                value={cloneURL}
                readOnly
                onFocus={(event) => event.target.select()}
              />
              <Button
                disabled={!cloneURL || !!busy}
                onClick={() =>
                  void action('copy', async () => {
                    await navigator.clipboard.writeText(`git clone ${cloneURL}`);
                    setFeedback('Clone command copied');
                  })
                }
              >
                Copy clone command
              </Button>
              <dl className="rm-facts">
                <div>
                  <dt>Status</dt>
                  <dd>{repository.status === 'ready' ? 'Ready' : repository.status}</dd>
                </div>
                {repository.defaultBranch && (
                  <div>
                    <dt>Default branch</dt>
                    <dd>
                      <code>{repository.defaultBranch}</code>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>Repository ID</dt>
                  <dd>
                    <code>{project.id}</code>
                  </dd>
                </div>
              </dl>
              {repository.source?.location ? (
                <>
                  <TextField
                    label="Import source"
                    value={repository.source.location}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                  <p className="rm-note">
                    Imported changes are fetched manually. Push your work to the hosted clone URL
                    above.
                  </p>
                  {repository.status === 'ready' && (
                    <Button
                      disabled={!!busy || !!activeOperation}
                      onClick={() =>
                        void action('fetch', async () => {
                          await api(base + '/repository/fetch', {});
                          await refresh();
                          setFeedback('Fetch queued');
                        })
                      }
                    >
                      {busy === 'fetch' ? 'Queuing fetch…' : 'Fetch import source'}
                    </Button>
                  )}
                </>
              ) : (
                <p className="rm-note">
                  This repository is hosted on deploy.local and has no import source.
                </p>
              )}
              {operation && (
                <p className="rm-note" role={operation.error ? 'alert' : 'status'}>
                  {operation.kind === 'prepare' ? 'Setup' : 'Fetch'}: {operation.status}
                  {operation.error ? ` · ${operation.error}` : ''}
                </p>
              )}
              <div className="rm-form-actions">
                {activeOperation && (
                  <Button
                    disabled={!!busy || !!operation.cancelRequested}
                    onClick={() =>
                      void action('cancel', async () => {
                        await api(base + '/repository/cancel', {});
                        await refresh();
                        setFeedback('Cancellation requested');
                      })
                    }
                  >
                    {operation.cancelRequested ? 'Cancelling…' : 'Cancel operation'}
                  </Button>
                )}
                {operation && ['failed', 'unknown', 'cancelled'].includes(operation.status) && (
                  <Button
                    disabled={!!busy}
                    onClick={() =>
                      void action('retry', async () => {
                        await api(base + '/repository/retry', {});
                        await refresh();
                        setFeedback('Retry queued');
                      })
                    }
                  >
                    Retry {operation.kind === 'prepare' ? 'setup' : 'fetch'}
                  </Button>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </section>
  );
}
