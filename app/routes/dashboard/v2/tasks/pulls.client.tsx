'use client';
import { useProjectFormatting } from '../projects/formatting.ts';
import { useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner, Empty, Icon, Item, Seg, Skeleton } from '@/components/ui';
import type { TaskPull } from './types';
import { useData } from '../projects/data';
import { projectSegment } from '../projects/routing';
import { pullHref, pullMeta } from './pull-presentation';
import PullRequest from './pull.client';
import './style.css';
import './pulls.css';

export default function PullRequests() {
  const { pathname } = useLocation();
  const project = decodeURIComponent(pathname.split('/')[3] || '');
  const pullId = decodeURIComponent(pathname.split('/')[5] || '');
  return pullId ? (
    <PullRequest key={`${project}/${pullId}`} project={project} id={pullId} />
  ) : (
    <PullList key={project} project={project} />
  );
}

function PullList({ project }: { project: string }) {
  const { pullElapsed } = useProjectFormatting();
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [before, setBefore] = useState<number>();
  const [older, setOlder] = useState<TaskPull[]>([]);
  const base = `/api/projects/${projectSegment(project)}/pulls`;
  const page = useData<{
    items: TaskPull[];
    counts: Record<string, number>;
    nextBefore: number | null;
  }>(
    `${base}?status=${status}&q=${encodeURIComponent(search)}${before ? `&before=${before}` : ''}`,
  );
  const recent = useData<{ items: TaskPull[] }>(
    status === 'open' ? `${base}?status=merged&limit=5&q=${encodeURIComponent(search)}` : undefined,
  );
  useEffect(() => {
    setOlder([]);
    setBefore(undefined);
  }, [status, search]);
  const items = [
    ...new Map([...older, ...(page.data?.items ?? [])].map((pull) => [pull.id, pull])).values(),
  ].filter((pull) => pull.status === status);
  const matches = (pull: TaskPull) =>
    `${pull.title} #${pull.number} ${pull.sourceBranch}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const shown = items.filter(matches);
  function row(pull: TaskPull) {
    return (
      <Item
        key={pull.id}
        href={pullHref(project, pull)}
        lead={<Icon name="merge" />}
        title={pull.title}
        description={pullMeta(pull)}
        end={pullElapsed(pull.mergedAt || pull.closedAt || pull.updatedAt)}
      />
    );
  }
  const empty = status === 'open' && page.data?.counts.open === 0 && !search;
  return (
    <>
      <div className="dl-pulls-filter">
        <Seg
          label="Pull request state"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setBefore(undefined);
            setOlder([]);
          }}
          options={['open', 'merged', 'closed'].map((state) => ({
            value: state,
            label: `${state[0].toUpperCase() + state.slice(1)}${page.data?.counts[state] ? ` ${page.data.counts[state]}` : ''}`,
          }))}
        />
        <label className="dl-field v2-pulls-search">
          <span className="dl-sr">Search pull requests</span>
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Search"
            value={search}
            onChange={(event) => {
              setBefore(undefined);
              setOlder([]);
              setSearch(event.target.value);
            }}
          />
        </label>
      </div>
      {!empty && (
        <p className="dl-section-sub">
          A pull request is the last stage of a task: its changes, waiting for you to merge. Open
          one to see its changes and checks, and the task's chat when a task opened it.
        </p>
      )}
      {page.error && (
        <Banner title={page.error} action={<Action onClick={page.refresh}>Retry</Action>} />
      )}
      {!page.data && !page.error ? (
        <Skeleton rows={3} />
      ) : (
        page.data &&
        (shown.length ? (
          <div className="dl-group">{shown.map(row)}</div>
        ) : (
          <div className="dl-group">
            <Empty
              className="v2-pulls-empty"
              icon="merge"
              title={
                search
                  ? `No ${status} pull requests match “${search}”`
                  : `No ${status} pull requests`
              }
              actions={
                empty ? (
                  <a className="dl-btn secondary" href="/dashboard">
                    New task
                  </a>
                ) : undefined
              }
            >
              {empty
                ? 'A pull request is the last stage of a task: its changes, waiting for you to merge. Tasks open one when their work is ready.'
                : undefined}
            </Empty>
          </div>
        ))
      )}
      {page.data?.nextBefore && (
        <Action
          disabled={before === page.data.nextBefore}
          onClick={() => {
            setOlder(items);
            setBefore(page.data!.nextBefore!);
          }}
        >
          Load more
        </Action>
      )}
      {status === 'open' && recent.error && (
        <Banner
          title="Merged pull requests are unavailable"
          action={<Action onClick={recent.refresh}>Retry</Action>}
        />
      )}
      {status === 'open' && !!recent.data?.items.length && (
        <section className="dl-section">
          <div className="v2-pulls-section-head">
            <h2 className="dl-section-title">Merged recently</h2>
            <button
              type="button"
              className="dl-link v2-pulls-all"
              onClick={() => setStatus('merged')}
            >
              All {page.data?.counts.merged ?? '…'} merged
            </button>
          </div>
          <div className="dl-group">{recent.data.items.filter(matches).map(row)}</div>
        </section>
      )}
    </>
  );
}
