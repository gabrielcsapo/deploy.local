'use client';
import { IconLink, WorkspaceIcon } from '@/components/ui';
import { repositoryURL } from './repository-navigation';
type Row = Record<string, any>;
export const pullNeedsBar = (pull: Row) => !['merged', 'closed'].includes(pull.status);
export function pullEventText(pull: Row) {
  const verb = pull.status === 'merged' ? 'Merged' : pull.status === 'closed' ? 'Closed' : 'Opened';
  return `${verb} #${pull.number} ${pull.title}${pull.status === 'merged' ? `${pull.targetBranch ? ` into ${pull.targetBranch}` : ''}${pull.mergedCommit ? ` · ${pull.mergedCommit.slice(0, 7)}` : ''}` : ''}`;
}
const pullURL = (pull: Row) =>
  `${repositoryURL(pull.projectId, 'pulls')}?pull=${encodeURIComponent(pull.id)}`;
export function PullRequestEvent({ pull }: { pull: Row }) {
  return (
    <div className="pw-transcript-event">
      <WorkspaceIcon name="pull-request" />
      <a href={pullURL(pull)}>{pullEventText(pull)}</a>
    </div>
  );
}
export function PullRequestBar({ pull }: { pull: Row }) {
  if (!pullNeedsBar(pull)) return null;
  return (
    <div className="pw-pull-bar">
      <WorkspaceIcon name="pull-request" />
      <a href={pullURL(pull)}>
        #{pull.number} {pull.title}
      </a>
      <span>{pull.status}</span>
      <IconLink icon="review" label="Review pull request" href={pullURL(pull)} />
    </div>
  );
}
export function DeploymentEvent({ deployment }: { deployment: Row }) {
  return (
    <div className="pw-transcript-event">
      <WorkspaceIcon name="bolt" />
      <span>
        Deployed {deployment.application || 'application'}
        {deployment.status !== 'running' ? ` · ${deployment.status}` : ''}
      </span>
      {/^https?:\/\//.test(deployment.url || '') && (
        <IconLink
          icon="external"
          label="Open application"
          href={deployment.url}
          target="_blank"
          rel="noreferrer"
        />
      )}
      {deployment.application && (
        <IconLink
          icon="terminal"
          label="View deployment logs"
          href={`/dashboard/${encodeURIComponent(deployment.application)}/build`}
        />
      )}
    </div>
  );
}
