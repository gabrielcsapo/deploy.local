'use client';
import { useEffect, useMemo, useState } from 'react';
import { Button, IconButton, WorkspaceIcon } from '@/components/ui';
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
  detail,
  patch,
  workers,
  project,
  changes,
  activity,
  sources,
}: {
  detail: Row;
  patch: Row | null;
  workers: Row[];
  project?: string;
  changes: () => void;
  activity: () => void;
  sources: () => void;
}) {
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
  const sourceCount = activitySources(detail.activity).length;
  const deployment = [...(detail.messages ?? [])]
    .reverse()
    .find(
      (message) =>
        message.deployment?.status === 'running' &&
        /^https?:\/\//.test(message.deployment.url ?? ''),
    )?.deployment;
  return (
    <aside className="pw-task-card" data-collapsed={collapsed || undefined} aria-label="Task card">
      {collapsed ? (
        <IconButton icon="panel-right" label="Expand task card" onClick={toggle} />
      ) : (
        <>
          <header>
            <span>{project || 'Task'}</span>
            <IconButton
              icon="collapse"
              label="Collapse task card"
              size="compact"
              onClick={toggle}
            />
          </header>
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
              <span>Unavailable</span>
            )}
          </button>
          <button className="pw-task-card-row" onClick={activity}>
            <WorkspaceIcon name="panel-right" />
            <span>Activity</span>
            <span
              aria-label={`${summary.running} running, ${summary.failing} failing, ${summary.passed} passed`}
            >
              ◐ {summary.running}{' '}
              <span className={summary.failing ? 'pw-card-removed' : ''}>✕ {summary.failing}</span>{' '}
              ✓ {summary.passed}
            </span>
          </button>
          {live.length > 0 && (
            <section>
              <h3>Running now</h3>
              {live.map((job) => (
                <p
                  key={job.id}
                  title={`${jobTitle(job)} · ${workers.find((worker) => worker.id === job.workerId)?.name ?? job.workerId ?? 'Waiting for computer'} · ${jobDuration(job, now)}`}
                >
                  {jobTitle(job)} ·{' '}
                  {workers.find((worker) => worker.id === job.workerId)?.name ??
                    job.workerId ??
                    'Waiting for computer'}{' '}
                  · {jobDuration(job, now)}
                </p>
              ))}
            </section>
          )}
          {sourceCount > 0 && (
            <div className="pw-task-card-row">
              <WorkspaceIcon name="file" />
              <span>Sources · {sourceCount}</span>
              <Button variant="link" onClick={sources}>
                View all
              </Button>
            </div>
          )}
          {deployment && (
            <section>
              <h3>Deployed</h3>
              <a href={deployment.url} target="_blank" rel="noreferrer">
                {deployment.url}
              </a>
            </section>
          )}
        </>
      )}
    </aside>
  );
}
