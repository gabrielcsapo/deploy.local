'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Field,
  Head,
  Icon,
  IconButton,
  Seg,
  Skeleton,
  Tabs,
} from '@/components/ui';
import { authenticatedFetch } from '../data/hooks';
import { requestJson, workspaceCommand } from './api';
import type { TaskPull } from './types';
import './style.css';

export default function PullRequests() {
  const { pathname } = useLocation();
  const project = decodeURIComponent(pathname.split('/')[3] || '');
  const base = `/dashboard/projects/${encodeURIComponent(project)}`;
  const [items, setItems] = useState<TaskPull[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const createdTasks = useRef(new Map<string, string>());
  const load = useCallback(
    async (before?: number, signal?: AbortSignal) => {
      const page = await requestJson<{ items: TaskPull[]; nextBefore: number | null }>(
        authenticatedFetch,
        `/api/workspace/projects/${encodeURIComponent(project)}/pulls?status=all${before ? `&before=${before}` : ''}`,
        { signal },
      );
      if (signal?.aborted) return;
      setItems((old) => (before ? [...(old || []), ...page.items] : page.items));
      setNext(page.nextBefore);
      setError('');
    },
    [project],
  );
  useEffect(() => {
    const controller = new AbortController();
    setItems(null);
    void load(undefined, controller.signal).catch(() => {
      if (!controller.signal.aborted) setError('Pull requests are unavailable. Try again.');
    });
    return () => controller.abort();
  }, [project, version, load]);
  async function openUnlinked(pull: TaskPull) {
    setBusy(true);
    setError('');
    try {
      let id = createdTasks.current.get(pull.id);
      if (!id) {
        const result = await workspaceCommand<{ id: string }>(authenticatedFetch, '/tasks', {
          projectId: project,
          title: pull.title,
          ref: pull.sourceBranch,
        });
        id = result.id;
        createdTasks.current.set(pull.id, id);
      }
      await workspaceCommand(
        authenticatedFetch,
        `/projects/${encodeURIComponent(project)}/pulls/${encodeURIComponent(pull.id)}/update`,
        {
          revision: pull.revision,
          taskIds: [...pull.taskIds, id],
        },
      );
      window.location.assign(`/dashboard/tasks/${encodeURIComponent(id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open task.');
    } finally {
      setBusy(false);
    }
  }
  function row(pull: TaskPull) {
    const content = (
      <>
        <Icon name="merge" />
        <span className="dl-t">
          {pull.title}
          <span>
            #{pull.number} · {pull.sourceBranch} → {pull.targetBranch}
          </span>
        </span>
        <span className="dl-meta">{pull.status}</span>
      </>
    );
    return pull.taskIds.length ? (
      <a
        className="dl-pull-row"
        key={pull.id}
        href={`/dashboard/tasks/${encodeURIComponent(pull.taskIds.at(-1)!)}`}
      >
        {content}
      </a>
    ) : (
      <button
        className="dl-pull-row"
        disabled={busy || pull.status !== 'open'}
        title={
          pull.status !== 'open'
            ? 'This historical pull request has no linked task'
            : 'Open as a task'
        }
        key={pull.id}
        onClick={() => void openUnlinked(pull)}
      >
        {content}
      </button>
    );
  }
  const filtered = (items || []).filter((pull) =>
    pull.title.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <Head
        title={project}
        subtitle="Project"
        menu={
          <IconButton
            className="dl-menu-btn"
            icon="menu"
            label="Open navigation"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <div className="dl-scroll">
        <div className="dl-page">
          <Tabs
            value={`${base}/pulls`}
            items={[
              { label: 'Overview', href: base },
              { label: 'Code', href: `${base}/code` },
              { label: 'Pull requests', href: `${base}/pulls` },
              { label: 'Settings', href: `${base}/settings` },
            ]}
          />
          <div className="dl-pulls-filter">
            <Seg
              label="Pull request state"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'merged', label: 'Merged' },
                { value: 'closed', label: 'Closed' },
              ]}
            />
            <Field
              label="Search pull requests"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <p className="dl-meta">
            A pull request is the last stage of a task. Open one to see its chat, changes and checks
            in one place.
          </p>
          {error && (
            <Banner
              title={error}
              action={<Action onClick={() => setVersion((value) => value + 1)}>Retry</Action>}
            />
          )}
          {!items && !error ? (
            <Skeleton rows={3} />
          ) : (
            <div className="dl-group">
              {filtered.filter((pull) => pull.status === status).map(row)}
              {!filtered.some((pull) => pull.status === status) && (
                <p className="dl-meta">No {status} pull requests.</p>
              )}
            </div>
          )}
          {status === 'open' && filtered.some((pull) => pull.status === 'merged') && (
            <>
              <h2 className="dl-section-title">Merged recently</h2>
              <div className="dl-group">
                {filtered
                  .filter((pull) => pull.status === 'merged')
                  .slice(0, 5)
                  .map(row)}
              </div>
            </>
          )}
          {next && (
            <Action
              onClick={() =>
                void load(next).catch(() => setError('Could not load more pull requests.'))
              }
            >
              Load more
            </Action>
          )}
        </div>
      </div>
    </>
  );
}
