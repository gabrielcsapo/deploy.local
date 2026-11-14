'use client';
import { useProjectFormatting } from './formatting.ts';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Field, Group, Setting } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { useCoordinatorName } from '../data/hooks';

import { pullHref } from '../tasks/pull-presentation';
import { request, useData, useBrowserHost, type Overview } from './data';
import { projectSegment } from './routing';

type Repository = NonNullable<Overview['repository']> & {
  operation?: {
    id: string;
    kind: string;
    status: string;
    completedAt?: string;
  } | null;
};

/** Where the repository lives: hosted here, and the remote it keeps in sync, if any. */
export function RepositorySettings({ project }: { project: Project }) {
  const { formatTime } = useProjectFormatting();
  const host = useBrowserHost();
  const coordinator = useCoordinatorName();
  const base = `/api/projects/${projectSegment(project.id)}/repository`;
  const repository = useData<Repository>(base);
  const [adding, setAdding] = useState(false);
  const [remote, setRemote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const data = repository.data;
  const syncing =
    !!data?.operation &&
    ['sync', 'fetch'].includes(data.operation.kind) &&
    ['queued', 'running'].includes(data.operation.status);
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(repository.refresh, 2000);
    return () => clearInterval(timer);
  }, [syncing, repository.refresh]);
  if (!data) return null;
  const location = data.source?.location;
  const both = data.source?.syncPolicy === 'both-ways';
  const branch = data.defaultBranch || 'main';
  const sync = data.sync;
  const state =
    sync?.state === 'paused'
      ? `Paused ${formatTime(sync.changedAt)}`
      : sync?.state === 'failed'
        ? `Sync failed ${formatTime(sync.at)}`
        : sync?.state === 'in-sync'
          ? `In sync ${formatTime(sync.at)}`
          : !both && data.operation?.kind === 'fetch' && data.operation.status === 'succeeded'
            ? `Fetched ${formatTime(data.operation.completedAt)}`
            : '';
  async function act(path: string, body: object = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await request(`${base}/${path}`, {
        method: 'POST',
        body: JSON.stringify({ operationId: crypto.randomUUID(), ...body }),
      });
      repository.refresh();
      return result;
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">Repository</h2>
      {sync?.state === 'paused' && location && (
        <Banner
          title="Sync is paused"
          action={
            <Action
              variant="quiet"
              loading={busy}
              onClick={async () => {
                const pull = await act('remote-pull');
                if (pull) window.location.assign(pullHref(project.id, pull));
              }}
            >
              Open a pull request
            </Action>
          }
        >
          {branch} changed here and on the remote since the last sync. Nothing was pushed or
          overwritten.
        </Banner>
      )}
      {error && <Banner kind="danger" title={error} />}
      <Group>
        <Setting
          label="Hosted on deploy.local"
          description="Tasks, reviews and releases work from this copy"
        >
          <code>
            {host}
            {data.clonePath}
          </code>
        </Setting>
        <Setting
          label="Remote"
          description={
            location ? (
              <>
                <code>{location}</code>
                {state && ` · ${state}`}
              </>
            ) : (
              `None · ${project.name} lives only on deploy.local`
            )
          }
        >
          {location ? (
            <Action loading={syncing} disabled={busy} onClick={() => void act('fetch')}>
              Sync now
            </Action>
          ) : (
            <Action onClick={() => setAdding(true)}>Add remote</Action>
          )}
        </Setting>
        {location && (
          <Setting
            label="Sync"
            description={
              both
                ? 'Merges here push to the remote. Commits pushed there arrive within 5 minutes.'
                : "Sync now brings in the remote's branches. Nothing is pushed."
            }
          >
            <span className="dl-tag">{both ? 'Both ways' : 'Fetch only'}</span>
          </Setting>
        )}
        <Setting label="Releases from" description="Merges to this branch become releases">
          <code>{data.defaultBranch || 'Unavailable'}</code>
        </Setting>
        <Setting label="Deploy file">deploy.yaml</Setting>
      </Group>
      {both && (
        <p className="dl-list-note">
          If {branch} changes in both places, sync pauses and asks you here. Without a remote,{' '}
          {project.name} lives only on deploy.local.
        </p>
      )}
      <Dialog
        open={adding}
        onClose={() => {
          if (!busy) setAdding(false);
        }}
        title="Add remote"
        className="v2-new-project-dialog"
        actions={
          <>
            <Action disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Action>
            <Action
              variant="primary"
              disabled={!remote.trim()}
              loading={busy}
              onClick={async () => {
                if (await act('remote', { sourcePath: remote.trim() })) setAdding(false);
              }}
            >
              Add remote
            </Action>
          </>
        }
      >
        <div className="v2-new-project">
          <div>
            <Field
              label="Remote"
              value={remote}
              className="dl-mono"
              placeholder={`git@github.com:you/${project.name}.git`}
              onChange={(event) => setRemote(event.target.value)}
            />
            <p className="dl-meta v2-field-help">
              {remote.trim().startsWith('/')
                ? `deploy.local fetches from this folder on ${coordinator} when you sync.`
                : `deploy.local pushes ${branch} there and brings in commits pushed to it, using the SSH key on ${coordinator}. Use an empty remote, or one that already shares its history.`}
            </p>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
