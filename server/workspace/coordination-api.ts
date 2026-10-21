import { applicationTool } from './application-deployment.ts';
import { createRepository } from './repository-creation.ts';
import { get } from './store.ts';
import { attachmentBytes, createAttachment, streamAttachment } from './attachments.ts';
import { interactiveTool } from './interactive.ts';
import { projectTool } from './project-tools.ts';
import { questionTool } from './questions.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authenticateAgent, coordinationTool } from './coordination.ts';
export async function coordinationApi(req: IncomingMessage, res: ServerResponse) {
  const send = (body: any, status: number) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const scope = authenticateAgent(String(req.headers['x-deploy-agent-token'] || ''));
    if (!scope) return send({ error: 'Agent run credential expired or invalid' }, 401);
    const url = new URL(req.url!, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/workspace/agent/attachments') {
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
    if (req.method !== 'POST' || req.url !== '/api/workspace/agent/tools')
      return send({ error: 'Agent credentials only authorize the task tool endpoint' }, 403);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 29 * 1024 * 1024) throw new Error('Request too large');
    }
    const body = JSON.parse(raw);
    if (body.name === 'deploy_attachment_read') {
      const row = get('attachment', scope.owner, body.args.id);
      const run = get('run', scope.owner, scope.runId);
      if (row.taskId !== scope.taskId || !run.attachmentIds?.includes(row.id))
        return send({ error: 'Attachment is not input for this run' }, 403);
      if (row.kind === 'video')
        return send({ id: row.id, kind: 'video', name: row.name, duration: row.duration }, 200);
      const { data } = attachmentBytes(scope.owner, row.id);
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
      body.name === 'deploy_create_repository'
        ? await createRepository(scope, body.args || {})
        : body.name === 'deploy_application'
          ? await applicationTool(scope, body.args || {})
          : body.name === 'deploy_ask_user'
            ? questionTool(scope, body.args || {})
            : body.name === 'deploy_control'
              ? interactiveTool(scope, body.args || {})
              : body.name === 'deploy_project'
                ? await projectTool(scope, body.args || {})
                : coordinationTool(scope, body.name, body.args || {}),
      200,
    );
  } catch (error: any) {
    return send({ error: error.message }, error.status || 400);
  }
}
