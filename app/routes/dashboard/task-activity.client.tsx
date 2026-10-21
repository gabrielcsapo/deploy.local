'use client';
import { Button } from '@/components/ui';
import { WorkspaceIcon } from './workspace-icon';
import { activitySources, activitySummary, jobStatus } from './task-activity-summary';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
export function TaskActivity({
  activity,
  progress = [],
  jobs = [],
  workers = [],
  openActivity,
}: {
  activity: Row;
  progress?: Row[];
  jobs?: Row[];
  workers?: Row[];
  openActivity?: () => void;
}) {
  if (!activity.items.length && !progress.length && !jobs.length) return null;
  const running = ['queued', 'starting', 'running'].includes(activity.status);
  return (
    <details className="pw-task-activity">
      <summary>
        <WorkspaceIcon name={running ? 'circle' : 'terminal'} />
        <span>{activity.summary}</span>
        {jobs.length > 0 && (
          <Button
            variant="link"
            onClick={(event) => {
              event.preventDefault();
              openActivity?.();
            }}
          >
            {activitySummary(jobs).text}
          </Button>
        )}
        {running && <span className="pw-activity-live">Working</span>}
        <WorkspaceIcon name="chevron-down" />
      </summary>
      <div className="pw-activity-body">
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
