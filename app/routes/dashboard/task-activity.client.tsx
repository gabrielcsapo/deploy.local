'use client';
import { WorkspaceIcon } from './workspace-icon';
import { MessageContent } from './message-content.client';
type Row = Record<string, any>;
export function TaskActivity({ activity, progress = [] }: { activity: Row; progress?: Row[] }) {
  if (!activity.items.length && !progress.length) return null;
  const running = ['queued', 'starting', 'running'].includes(activity.status);
  return (
    <details className="pw-task-activity">
      <summary>
        <WorkspaceIcon name={running ? 'circle' : 'terminal'} />
        <span>{activity.summary}</span>
        {running && <span className="pw-activity-live">Working</span>}
        <WorkspaceIcon name="chevron-down" />
      </summary>
      <div className="pw-activity-body">
        {progress.map((message) => (
          <div className="pw-activity-note" key={message.id}>
            <MessageContent content={message.content} />
          </div>
        ))}
        {activity.items.map((item: Row) => (
          <details className="pw-action" key={item.id}>
            <summary>
              <WorkspaceIcon
                name={
                  item.kind === 'command' ? 'terminal' : item.kind === 'search' ? 'search' : 'file'
                }
              />
              <span>{item.title}</span>
              <small className={item.status === 'failed' ? 'pw-error' : ''}>
                {item.status === 'completed'
                  ? item.exitCode != null
                    ? `Exit ${item.exitCode}`
                    : ''
                  : item.status}
              </small>
            </summary>
            {item.detail && <pre>{item.detail}</pre>}
            {item.output && <pre>{item.output}</pre>}
          </details>
        ))}
      </div>
    </details>
  );
}
export function TaskSources({ activity }: { activity: Row[] }) {
  const sources = [
    ...new Set<string>(activity.flatMap((a) => a.items.map((i: Row) => i.source).filter(Boolean))),
  ];
  if (!sources.length) return null;
  return (
    <details className="pw-task-sources">
      <summary>
        <WorkspaceIcon name="file" />
        Sources <span>{sources.length}</span>
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
              <span title={source}>{source.split('/').pop() || source}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
