// Capabilities are minted only by the coordinator, never exposed to a worker.
// They authorize one loopback upload, not the owner's general API surface.
import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readDeploymentRecord as getDeployment } from './store.ts';
import { get, save, now } from './workspace/store.ts';

export type AgentUpload = {
  owner: string;
  taskId: string;
  taskTitle: string;
  application: string;
  deploymentRecordId: string;
};
const capabilities = new Map<string, { scope: AgentUpload; expires: number }>();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export function issueAgentUpload(scope: AgentUpload) {
  for (const [key, entry] of capabilities) if (entry.expires < Date.now()) capabilities.delete(key);
  const token = randomBytes(32).toString('hex');
  capabilities.set(hash(token), { scope, expires: Date.now() + 60000 });
  return { token, close: () => capabilities.delete(hash(token)) };
}
export function consumeAgentUpload(req: IncomingMessage): AgentUpload | undefined {
  const token = req.headers['x-deploy-internal-upload'];
  if (!token) return;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const entry = typeof token === 'string' ? capabilities.get(hash(token)) : undefined;
  if (
    !local ||
    !entry ||
    entry.expires < Date.now() ||
    req.url !== '/api/upload' ||
    req.method !== 'POST'
  )
    throw Object.assign(new Error('Invalid internal upload capability'), { status: 403 });
  capabilities.delete(hash(token as string));
  return entry.scope;
}
export function assertAgentApplication(
  scope: Pick<AgentUpload, 'owner' | 'taskId' | 'application'>,
) {
  const deployment = getDeployment(scope.application);
  if (!deployment) return;
  let origin: any;
  try {
    origin = get('application-origin', scope.owner, scope.application);
  } catch {
    /* No agent origin. */
  }
  if (
    deployment.username === scope.owner &&
    origin?.taskId === scope.taskId &&
    origin.owner === scope.owner &&
    origin.appId === deployment.appId &&
    origin.buildLogId === deployment.currentBuildLogId &&
    origin.sourceArtifactDigest === deployment.sourceArtifactDigest
  )
    return;
  throw Object.assign(
    new Error(
      `Application "${scope.application}" was not last deployed by this task. Ask the user via deploy_ask_user before proceeding; do not pick another application's name. The user must deploy an existing application themselves.`,
    ),
    { status: 403 },
  );
}
export function recordAgentUpload(scope: AgentUpload, buildLogId: number) {
  const deployment = getDeployment(scope.application)!;
  // Record failed first attempts too, so this task can fix and retry its own app.
  save('application-origin', scope.owner, {
    id: scope.application,
    app: scope.application,
    taskId: scope.taskId,
    owner: scope.owner,
    appId: deployment.appId,
    buildLogId,
    sourceArtifactDigest: deployment.sourceArtifactDigest,
    status: 'building',
    updatedAt: now(),
  });
  const record = get('application-deployment', scope.owner, scope.deploymentRecordId);
  save('application-deployment', scope.owner, { ...record, buildLogId, updatedAt: now() });
}
export function finishAgentUpload(scope: AgentUpload) {
  const origin = get('application-origin', scope.owner, scope.application);
  const deployment = getDeployment(scope.application)!;
  if (origin.taskId === scope.taskId && origin.buildLogId === deployment.currentBuildLogId)
    save('application-origin', scope.owner, { ...origin, status: 'running', updatedAt: now() });
}
