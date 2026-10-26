'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';
import { activitySources, activitySummary, jobStatus, runDuration } from './task-activity-summary';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
export function TaskActivity({
  activity,
  run,
  progress = [],
  jobs = [],
  workers = [],
  openActivity,
}: {
  activity: Row;
  run?: Row;
  progress?: Row[];
  jobs?: Row[];
  workers?: Row[];
  openActivity?: () => void;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!['queued', 'starting', 'running'].includes(activity.status)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [activity.status]);
  const queued = run?.status === 'queued' || activity.status === 'queued';
  const duration = queued ? '' : runDuration(run, now);
  const summary = activitySummary(jobs);
  const running = ['queued', 'starting', 'running'].includes(activity.status);
  return (
    <details
      className="pw-task-activity"
      data-failed={summary.failing > 0 || activity.status === 'failed' || undefined}
    >
      <summary>
        <span>
          {queued ? 'Queued' : running ? 'Working' : 'Worked'}
          {duration ? ` for ${duration}` : ''}
        </span>
        {jobs.length > 0 && (
          <span className={summary.failing ? 'pw-activity-failed' : ''}>
            · {jobs.length} job{jobs.length === 1 ? '' : 's'}
            {summary.computers
              ? ` on ${summary.computers} computer${summary.computers === 1 ? '' : 's'}`
              : ''}
          </span>
        )}
        <WorkspaceIcon name="chevron-down" />
      </summary>
      <div className="pw-activity-body">
        <p>{activity.summary}</p>
        {jobs.length > 0 && (
          <Button variant="link" onClick={openActivity}>
            {summary.text}
          </Button>
        )}
        {progress.map((message) => (
          <div className="pw-activity-note" key={message.id}>
            <MessageContent content={message.content} />
          </div>
        ))}
        {activity.items.map((item: Row) => {
          const job = jobs.find((candidate) =>
            [item.detail, item.output].some(
              (text) =>
                text &&
                (text.includes(candidate.id) ||
                  (candidate.command && text.includes(candidate.command))),
            ),
          );
          return (
            <details className="pw-action" key={item.id}>
              <summary>
                <WorkspaceIcon
                  name={
                    item.kind === 'command'
                      ? 'terminal'
                      : item.kind === 'search'
                        ? 'search'
                        : 'file'
                  }
                />
                <span>
                  {job
                    ? `${workers.find((w) => w.id === job.workerId)?.name ?? job.workerId ?? 'Waiting for computer'} · ${jobStatus(job)}`
                    : item.title}
                </span>
                <small className={item.status === 'failed' ? 'pw-error' : ''}>
                  {item.status === 'completed'
                    ? item.exitCode != null
                      ? item.exitCode === 0
                        ? ''
                        : `Exit ${item.exitCode}`
                      : ''
                    : item.status}
                </small>
                <WorkspaceIcon name="chevron-down" />
              </summary>
              {item.detail && <pre>{item.detail}</pre>}
              {item.output && <pre>{item.output}</pre>}
            </details>
          );
        })}
      </div>
    </details>
  );
}
export function TaskSources({
  activity,
  expanded = false,
  roots = [],
}: {
  activity: Row[];
  expanded?: boolean;
  roots?: string[];
}) {
  const sources = activitySources(activity).map((source) => {
    const root = roots
      .filter(Boolean)
      .find((path) => source.startsWith(path.replace(/\/$/, '') + '/'));
    return root ? source.slice(root.replace(/\/$/, '').length + 1) : source;
  });
  if (!sources.length) return null;
  return (
    <details className="pw-task-sources" open={expanded || undefined}>
      <summary>
        <WorkspaceIcon name="file" />
        Read {sources.length} file{sources.length === 1 ? '' : 's'}
        <WorkspaceIcon name="chevron-down" />
      </summary>
      <ul>
        {sources.map((source) => (
          <li key={source}>
            <WorkspaceIcon name="file" />
            {/^https?:\/\//i.test(source) ? (
              <a href={source} target="_blank" rel="noreferrer">
                {source}
              </a>
            ) : (
              <span title={source}>
                <span className="pw-muted">
                  {source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : ''}
                </span>
                <strong>{source.split('/').pop() || source}</strong>
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
