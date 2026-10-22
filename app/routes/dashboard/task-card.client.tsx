'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconButton, OverflowMenu, WorkspaceIcon } from '@/components/ui';
import {
  activitySources,
  activitySummary,
  activeJob,
  jobDuration,
  jobTitle,
} from './task-activity-summary';
import { parseTaskDiff } from './task-diff';

type Row = Record<string, any>;
export function TaskCard({
  visible = true,
  width = 260,
  detail,
  patch,
  workers,
  project,
  changes,
  activity,
  sources,
}: {
  visible?: boolean;
  width?: number;
  detail: Row;
  patch: Row | null;
  workers: Row[];
  project?: string;
  changes: () => void;
  activity: () => void;
  sources: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('deploy:task-card-collapsed') === 'true');
    } catch {}
  }, []);
  const jobs: Row[] = detail.jobs ?? [];
  const live = jobs.filter(activeJob).slice(0, 3);
  useEffect(() => {
    if (!live.length) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live.length]);
  function toggle() {
    setCollapsed(!collapsed);
    requestAnimationFrame(() =>
      root.current
        ?.querySelector<HTMLButtonElement>(
          collapsed ? '[aria-label="Task card options"]' : '[aria-label="Expand task card"]',
        )
        ?.focus({ preventScroll: true }),
    );
    try {
      localStorage.setItem('deploy:task-card-collapsed', String(!collapsed));
    } catch {}
  }
  const counts = useMemo(
    () =>
      parseTaskDiff(patch?.patch ?? '')
        .flatMap((file) => file.lines)
        .reduce(
          (sum, line) => ({
            added: sum.added + Number(line.kind === 'added'),
            removed: sum.removed + Number(line.kind === 'removed'),
          }),
          { added: 0, removed: 0 },
        ),
    [patch?.patch],
  );
  const summary = activitySummary(jobs);
  const sourceList = activitySources(detail.activity);
  const deployment = [...(detail.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.deployment?.status === 'running' &&
        /^https?:\/\//.test(message.deployment.url ?? ''),
    )?.deployment;
  return (
    <aside
      ref={root}
      className="pw-task-card"
      data-visible={visible}
      inert={!visible}
      aria-hidden={!visible}
      style={{ '--task-card-width': `${width}px` } as React.CSSProperties}
      data-collapsed={collapsed || undefined}
      aria-label="Task card"
    >
      <div className="pw-task-card-expand" inert={!collapsed} aria-hidden={!collapsed}>
        <IconButton icon="panel-right" label="Expand task card" onClick={toggle} />
      </div>
      <div className="pw-task-card-body" inert={collapsed} aria-hidden={collapsed}>
        <div>
          <header>
            <span>{project || 'Task'}</span>
            <OverflowMenu label="Task card options">
              <button data-dismiss-menu onClick={activity}>
                Show activity
              </button>
              {sourceList.length > 0 && (
                <button data-dismiss-menu onClick={sources}>
                  Show sources
                </button>
              )}
              <button data-dismiss-menu onClick={toggle}>
                Collapse card
              </button>
            </OverflowMenu>
          </header>
          <div className="pw-task-card-group">
            <button className="pw-task-card-row" onClick={changes}>
              <WorkspaceIcon name="review" />
              <span>Changes</span>
              {patch ? (
                <span
                  title={
                    patch.truncated
                      ? 'Counts in the available, truncated patch'
                      : 'Lines in the recorded task patch'
                  }
                >
                  <span className="pw-card-added">+{counts.added.toLocaleString()}</span>{' '}
                  <span className="pw-card-removed">−{counts.removed.toLocaleString()}</span>
                  {patch.truncated ? '…' : ''}
                </span>
              ) : (
                <span className="pw-task-card-meta">Unavailable</span>
              )}
            </button>
            <button className="pw-task-card-row" onClick={activity}>
              <WorkspaceIcon name="panel-right" />
              <span>Activity</span>
              <span
                className="pw-task-card-meta"
                aria-label={`${summary.running} running, ${summary.failing} failing, ${summary.passed} passed`}
              >
                {summary.running > 0 && <>◐ {summary.running} </>}
                {summary.failing > 0 && (
                  <span className="pw-card-removed">✕ {summary.failing} </span>
                )}
                {summary.passed > 0 && <>✓ {summary.passed}</>}
              </span>
            </button>
          </div>
          {live.length > 0 && (
            <section className="pw-task-card-group">
              <h3>Running now</h3>
              {live.map((job) => {
                const computer =
                  workers.find((worker) => worker.id === job.workerId)?.name ??
                  job.workerId ??
                  'Waiting for computer';
                return (
                  <div
                    key={job.id}
                    className="pw-task-card-row"
                    title={`${jobTitle(job)} · ${computer} · ${jobDuration(job, now)}`}
                  >
                    <WorkspaceIcon name="terminal" />
                    <span>{jobTitle(job)}</span>
                    <span className="pw-task-card-meta">
                      {computer} · {jobDuration(job, now)}
                    </span>
                  </div>
                );
              })}
            </section>
          )}
          {sourceList.length > 0 && (
            <section className="pw-task-card-group">
              <h3>Sources</h3>
              {sourceList.slice(0, 3).map((source) => (
                <button key={source} className="pw-task-card-row" title={source} onClick={sources}>
                  <WorkspaceIcon name={/^https?:\/\//.test(source) ? 'external' : 'file'} />
                  <span>{sourceName(source)}</span>
                </button>
              ))}
              <button className="pw-task-card-row is-quiet" onClick={sources}>
                <WorkspaceIcon name="link" />
                <span>View all</span>
                {sourceList.length > 3 && (
                  <span className="pw-task-card-meta">{sourceList.length}</span>
                )}
              </button>
            </section>
          )}
          {deployment && (
            <section className="pw-task-card-group">
              <h3>Deployed</h3>
              <a
                className="pw-task-card-row"
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                title={deployment.url}
              >
                <WorkspaceIcon name="external" />
                <span>{deploymentHost(deployment.url)}</span>
              </a>
            </section>
          )}
        </div>
      </div>
    </aside>
  );
}

/** A file's name or a page's host and path, as the card shows sources. */
export function sourceName(source: string) {
  try {
    if (/^https?:\/\//.test(source)) {
      const url = new URL(source);
      return `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    }
  } catch {}
  return source.split('/').filter(Boolean).pop() ?? source;
}
function deploymentHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
