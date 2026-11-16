import { requireWorkspaceDesignTool } from '../../workspace/design-tool-port.ts';
import { requireTaskTools } from '../../workspace/task-workspace.ts';
import { sendJson } from '../../kernel/http.ts';
import { updateBase } from '../../workspace/update-base.ts';
import { applicationTool } from '../../workspace/application-deployment.ts';
import { createRepository } from '../../workspace/repository-creation.ts';
import { commitCheckpoint } from '../../workspace/checkpoint-commit.ts';
import { get } from '../../workspace/store.ts';
import {
  attachmentBytes,
  createAttachment,
  streamAttachment,
} from '../../workspace/attachments.ts';
import { interactiveTool } from '../../workspace/interactive.ts';
import { readJobArtifact } from '../../workspace/job-artifacts.ts';
import { projectTool } from '../../workspace/project-tools.ts';
import { questionTool } from '../../workspace/questions.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateAgent, coordinationTool } from '../../workspace/coordination.ts';
import { snapshotRequestLimit } from '../../workspace/checkpoint.ts';
export async function coordinationApi(req: IncomingMessage, res: ServerResponse) {
  const send = (body: any, status: number) => {
    sendJson(res, body, status);
  };
  try {
    const scope = authenticateAgent(String(req.headers['x-deploy-agent-token'] || ''));
    if (!scope) return send({ error: 'Agent run credential expired or invalid' }, 401);
    const url = new URL(req.url!, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/agent/attachments') {
      const operationId = String(
        req.headers['x-operation-id'] || url.searchParams.get('operationId') || '',
      );
      if (!operationId) throw new Error('operationId required');
      return send(
        await streamAttachment(req, scope.owner, scope.taskId, {
          operationId: `${scope.runId}:${operationId}`,
          name: url.searchParams.get('name') || 'attachment',
          caption: url.searchParams.get('caption') || '',
          source: 'agent',
          runId: scope.runId,
        }),
        200,
      );
    }
    if (req.method !== 'POST' || req.url !== '/api/agent/tools')
      return send({ error: 'Agent credentials only authorize the task tool endpoint' }, 403);
    // A repository checkpoint sends its changed files as base64 JSON, so the cap follows the
    // delta limit rather than the old whole-workspace one.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > snapshotRequestLimit) throw new Error('Request too large');
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.name === 'deploy_attachment_read') {
      const row = get('attachment', scope.owner, body.args.id);
      const run = get('run', scope.owner, scope.runId);
      if (row.taskId !== scope.taskId || !run.attachmentIds?.includes(row.id))
        return send({ error: 'Attachment is not input for this run' }, 403);
      if (row.kind === 'video')
        return send({ id: row.id, kind: 'video', name: row.name, duration: row.duration }, 200);
      const { data } = await attachmentBytes(scope.owner, row.id);
      return send({ id: row.id, mimeType: row.mimeType, data: data.toString('base64') }, 200);
    }
    if (body.name === 'deploy_attach')
      return send(
        createAttachment(
          scope.owner,
          scope.taskId,
          Buffer.from(String(body.args?.data || ''), 'base64'),
          {
            ...body.args,
            operationId: `${scope.runId}:${body.args.operationId}`,
            source: 'agent',
            runId: scope.runId,
          },
        ),
        200,
      );
    return send(
      body.name === 'deploy_require_tools'
        ? await requireTaskTools(scope, body.args || {})
        : body.name === 'deploy_update_base'
          ? await updateBase(scope.owner, scope.taskId, body.args || {}, scope.runId)
          : body.name === 'deploy_commit'
            ? await commitCheckpoint(scope, body.args || {})
            : body.name === 'deploy_create_repository'
              ? await createRepository(scope, body.args || {})
              : body.name === 'deploy_application'
                ? await applicationTool(scope, body.args || {})
                : body.name === 'deploy_ask_user'
                  ? questionTool(scope, body.args || {})
                  : body.name === 'deploy_control'
                    ? interactiveTool(scope, body.args || {})
                    : body.name === 'deploy_project'
                      ? await projectTool(scope, body.args || {})
                      : body.name === 'deploy_design'
                        ? // Loaded when used: the design module registers itself with the v2 inbox.
                          await requireWorkspaceDesignTool('workspace')(scope, body.args || {})
                        : body.name === 'deploy_read_artifact'
                          ? readJobArtifact(scope, body.args || {})
                          : await coordinationTool(scope, body.name, body.args || {}),
      200,
    );
  } catch (error: any) {
    return send({ error: error.message }, error.status || 400);
  }
}
