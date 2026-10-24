// Capabilities are minted only by the coordinator, never exposed to a worker.
// They authorize one loopback upload, not the owner's general API surface.
import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { readDeploymentRecord as getDeployment } from './store.ts';
import { db, get, save, now } from './workspace/store.ts';

export type AgentUpload = {
  owner: string;
  taskId?: string;
  taskTitle?: string;
  projectId?: string;
  pipelineId?: string;
  application: string;
  deploymentRecordId: string;
};
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export function issueAgentUpload(scope: AgentUpload) {
  db.prepare(
    "DELETE FROM records WHERE kind='upload-capability' AND json_extract(data, '$.expires') < ?",
  ).run(Date.now());
  const token = randomBytes(32).toString('hex');
  // Durable hashes let the isolated pipeline worker mint capabilities consumed by control.
  save('upload-capability', '', { id: hash(token), scope, expires: Date.now() + 60000 });
  return {
    token,
    close: () =>
      db
        .prepare("DELETE FROM records WHERE kind='upload-capability' AND owner='' AND id=?")
        .run(hash(token)),
  };
}
export function consumeAgentUpload(req: IncomingMessage): AgentUpload | undefined {
  const token = req.headers['x-deploy-internal-upload'];
  if (!token) return;
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const row =
    typeof token === 'string'
      ? (db
          .prepare("SELECT data FROM records WHERE kind='upload-capability' AND owner='' AND id=?")
          .get(hash(token)) as { data: string } | undefined)
      : undefined;
  const entry = row ? JSON.parse(row.data) : undefined;
  if (
    !local ||
    !entry ||
    entry.expires < Date.now() ||
    req.url !== '/api/upload' ||
    req.method !== 'POST'
  )
    throw Object.assign(new Error('Invalid internal upload capability'), { status: 403 });
  const consumed = db
    .prepare("DELETE FROM records WHERE kind='upload-capability' AND owner='' AND id=?")
    .run(hash(token as string));
  if (consumed.changes !== 1) throw new Error('Internal upload capability already consumed');
  return entry.scope;
}
export function assertAgentApplication(
  scope: Pick<AgentUpload, 'owner' | 'taskId' | 'application' | 'projectId' | 'pipelineId'>,
) {
  if (scope.pipelineId) {
    const project = get('project', scope.owner, scope.projectId!);
    const run = get('pipeline-run', scope.owner, scope.pipelineId);
    if (
      project.owner !== scope.owner ||
      run.projectId !== project.id ||
      run.pullId ||
      run.trigger === 'pull_request'
    )
      throw new Error("Only the repository owner's pipelines may deploy");
  }
  const deployment = getDeployment(scope.application);
  if (!deployment) return;
  let origin: any;
  try {
    origin = get('application-origin', scope.owner, scope.application);
  } catch {
    /* No agent origin. */
  }
  if (scope.pipelineId && origin?.taskId && !origin.projectId) {
    try {
      origin.projectId = get('task', scope.owner, origin.taskId).projectId;
    } catch {
      /* Deleted task cannot authorize. */
    }
  }
  if (
    deployment.username === scope.owner &&
    (scope.pipelineId
      ? origin?.projectId === scope.projectId
      : Boolean(scope.taskId) && origin?.taskId === scope.taskId) &&
    origin.owner === scope.owner &&
    origin.appId === deployment.appId &&
    origin.buildLogId === deployment.currentBuildLogId &&
    origin.sourceArtifactDigest === deployment.sourceArtifactDigest
  )
    return;
  throw Object.assign(
    new Error(
      scope.pipelineId
        ? `Application "${scope.application}" was not last deployed from this repository by its owner. Deploy it once yourself from this repository or rename it; pipelines cannot overwrite another application's deployment.`
        : `Application "${scope.application}" was not last deployed by this task. Ask the user via deploy_ask_user before proceeding; do not pick another application's name. The user must deploy an existing application themselves.`,
    ),
    { status: 403 },
  );
}
export function assertRepositoryOwner(owner: string, projectId: string) {
  if (get('project', owner, projectId).owner !== owner)
    throw new Error('Only the repository owner may authorize pipeline deployment');
}

// An authenticated manual upload can explicitly associate its source with an owned
// repository. A name or matching manifest alone is never proof of provenance.
export function recordApplicationOrigin(
  scope: Pick<AgentUpload, 'owner' | 'application' | 'projectId' | 'pipelineId' | 'taskId'>,
  buildLogId: number,
) {
  const deployment = getDeployment(scope.application)!;
  save('application-origin', scope.owner, {
    id: scope.application,
    app: scope.application,
    taskId: scope.taskId,
    projectId:
      scope.projectId ||
      (scope.taskId ? get('task', scope.owner, scope.taskId).projectId : undefined),
    pipelineId: scope.pipelineId,
    owner: scope.owner,
    appId: deployment.appId,
    buildLogId,
    sourceArtifactDigest: deployment.sourceArtifactDigest,
    status: 'building',
    updatedAt: now(),
  });
}

export function recordAgentUpload(scope: AgentUpload, buildLogId: number) {
  // Record failed first attempts too, so this task can fix and retry its own app.
  recordApplicationOrigin(scope, buildLogId);
  if (scope.pipelineId) {
    const run = get('pipeline-run', scope.owner, scope.pipelineId);
    save('pipeline-run', scope.owner, {
      ...run,
      deployment: { ...run.deployment, buildLogId },
      updatedAt: now(),
    });
  } else {
    const record = get('application-deployment', scope.owner, scope.deploymentRecordId);
    save('application-deployment', scope.owner, { ...record, buildLogId, updatedAt: now() });
  }
}
export function finishAgentUpload(scope: AgentUpload) {
  const origin = get('application-origin', scope.owner, scope.application);
  const deployment = getDeployment(scope.application)!;
  if (
    (scope.pipelineId ? origin.pipelineId === scope.pipelineId : origin.taskId === scope.taskId) &&
    origin.buildLogId === deployment.currentBuildLogId
  )
    save('application-origin', scope.owner, { ...origin, status: 'running', updatedAt: now() });
}
