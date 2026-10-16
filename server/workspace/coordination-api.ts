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
    if (req.method !== 'POST' || req.url !== '/api/workspace/agent/tools')
      return send({ error: 'Agent credentials only authorize the task tool endpoint' }, 403);
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 13 * 1024 * 1024) throw new Error('Request too large');
    }
    const body = JSON.parse(raw);
    return send(
      body.name === 'deploy_ask_user'
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
