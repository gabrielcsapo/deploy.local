export interface DeploymentMessage {
  type: 'deployment';
  name: string;
  status: 'building' | 'running' | 'failed';
  nodeId: string;
  nodeName: string;
  username: string;
  at: number;
  trigger?: string;
}

export function isDeploymentMessage(value: unknown): value is DeploymentMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as DeploymentMessage;
  return (
    message.type === 'deployment' &&
    ['building', 'running', 'failed'].includes(message.status) &&
    ['name', 'nodeId', 'nodeName', 'username'].every(
      (key) => typeof message[key as keyof DeploymentMessage] === 'string',
    ) &&
    !!message.name &&
    !!message.nodeId &&
    Number.isFinite(message.at)
  );
}
