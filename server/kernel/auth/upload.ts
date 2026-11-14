// Coordinator-only, single-use loopback upload capabilities.
import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { namedDatabase } from '../db/named-store.ts';
import { workspaceRecords } from '../db/records.ts';
import type { PrincipalOf } from './principal.ts';
const database = () => namedDatabase('workspace');

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
  database()
    .prepare(
      "DELETE FROM records WHERE kind='upload-capability' AND json_extract(data, '$.expires') < ?",
    )
    .run(Date.now());
  const token = randomBytes(32).toString('hex');
  // Durable hashes let the isolated pipeline worker mint capabilities consumed by control.
  workspaceRecords.save('upload-capability', '', {
    id: hash(token),
    scope,
    expires: Date.now() + 60000,
  });
  return {
    token,
    close: () =>
      database()
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
      ? (database()
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
  const consumed = database()
    .prepare("DELETE FROM records WHERE kind='upload-capability' AND owner='' AND id=?")
    .run(hash(token as string));
  if (consumed.changes !== 1) throw new Error('Internal upload capability already consumed');
  return entry.scope;
}
export function verifyAgentUpload(
  req: IncomingMessage,
): (PrincipalOf<'upload'> & { scope: AgentUpload }) | undefined {
  const scope = consumeAgentUpload(req);
  if (!scope) return;
  return {
    kind: 'upload',
    owner: scope.owner,
    application: scope.application,
    taskId: scope.taskId,
    projectId: scope.projectId,
    pipelineId: scope.pipelineId,
    scope,
  };
}
