import type { DeploymentMessage } from '../../../server/deployment-notification-message.ts';

export interface RecentNotification {
  name: string;
  nodeId: string;
  status: DeploymentMessage['status'];
  shownAt: number;
}

export function deploymentNotification(
  message: DeploymentMessage,
  recent: readonly RecentNotification[],
  now = Date.now(),
) {
  const history = recent.filter(
    (entry) => entry.name === message.name && entry.nodeId === message.nodeId,
  );
  if (history.some((entry) => entry.status === message.status && now - entry.shownAt < 10_000))
    return null;
  if (message.status === 'building' && history.at(-1)?.status === 'building') return null;
  const title =
    message.status === 'building'
      ? `Deploying ${message.name} to ${message.nodeName}…`
      : message.status === 'running'
        ? `${message.name} is running on ${message.nodeName}`
        : `${message.name} failed on ${message.nodeName}`;
  return { title, key: message.name };
}
