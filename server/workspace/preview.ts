import { sendJson } from '../kernel/http.ts';
import { spawn } from 'node:child_process';
import { coordinationApi } from './coordination-api.ts';
import { workerAuthentication } from './credentials.ts';
// Disposable local harness preview; never starts deployment/fleet reconciliation.
import { createServer } from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { authenticate, registerUser, loginUser, getUser } from '../store.ts';
import { workspaceApi } from './api.ts';
import { root } from './store.ts';
if (!process.env.DEPLOY_DATA_DIR || !process.env.DEPLOY_DATA_DIR.startsWith('/tmp/'))
  throw new Error('Preview requires explicit disposable /tmp/ DEPLOY_DATA_DIR');
const credentials = resolve(root, 'preview-credentials.json');
if (!existsSync(credentials)) {
  const username = process.env.WORKSPACE_PREVIEW_USERNAME || 'workspaceqa',
    password = process.env.WORKSPACE_PREVIEW_PASSWORD || 'Workspace-QA-2026!';
  if (
    Boolean(process.env.WORKSPACE_PREVIEW_USERNAME) !==
    Boolean(process.env.WORKSPACE_PREVIEW_PASSWORD)
  )
    throw new Error('Preview username and password must be configured together');
  if (process.env.WORKSPACE_PREVIEW_PASSWORD && password.length < 24)
    throw new Error('Device preview requires a password of at least 24 characters');
  const account = registerUser(username, password);
  writeFileSync(credentials, JSON.stringify({ username, password, ...account }), { mode: 0o600 });
}
createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  const send = (data: unknown, status = 200) => {
    sendJson(res, data, status, { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw),
        result = loginUser(body.username, body.password);
      if ('error' in result) return send(result, result.status);
      res.setHeader(
        'Set-Cookie',
        `deploy-sh-auth=${encodeURIComponent(body.username + ':' + result.token)}; Path=/; HttpOnly; SameSite=Lax`,
      );
      return send(result);
    }
    let username = String(req.headers['x-deploy-username'] || ''),
      token = String(req.headers['x-deploy-token'] || '');
    if (!username) {
      const cookie = req.headers.cookie
        ?.split(';')
        .find((p) => p.trim().startsWith('deploy-sh-auth='));
      if (cookie) {
        const decoded = decodeURIComponent(cookie.trim().slice('deploy-sh-auth='.length)),
          n = decoded.indexOf(':');
        username = decoded.slice(0, n);
        token = decoded.slice(n + 1);
      }
    }
    if (req.headers.authorization?.startsWith('Basic ')) {
      const decoded = Buffer.from(req.headers.authorization.slice(6), 'base64').toString(),
        n = decoded.indexOf(':');
      username = decoded.slice(0, n);
      token = decoded.slice(n + 1);
    }
    if (req.headers['x-deploy-agent-token']) return coordinationApi(req, res);
    const worker = workerAuthentication(req);
    if (worker && url.pathname.startsWith('/api/workspace/'))
      return workspaceApi(req, res, worker.owner, worker.workerId);
    if (!authenticate(username, token)) {
      // JSON clients handle expired sessions in-app. A Basic challenge can instead
      // suspend browser fetch behind the browser's own authentication prompt.
      if (req.headers.authorization?.startsWith('Basic '))
        res.setHeader('WWW-Authenticate', 'Basic realm="deploy.local"');
      return send({ error: 'Unauthorized' }, 401);
    }
    if (url.pathname.startsWith('/api/workspace/')) return workspaceApi(req, res, username);
    if (url.pathname === '/api/me') return send(getUser(username));
    if (url.pathname === '/api/logout') return send({ ok: true });
    return send({ error: 'This disposable preview serves the project harness only' }, 404);
  } catch (e: any) {
    send({ error: e.message }, 400);
  }
}).listen(Number(process.env.WORKSPACE_PORT || 17843), '127.0.0.1', () =>
  console.log(
    'Disposable workspace API ready on 127.0.0.1:' + (process.env.WORKSPACE_PORT || 17843),
  ),
);

const repositoryWorker = spawn(
  process.execPath,
  [new URL('./repository-worker.ts', import.meta.url).pathname],
  { stdio: 'inherit', env: process.env },
);
const pipelineWorker = spawn(
  process.execPath,
  [new URL('./pipeline-worker.ts', import.meta.url).pathname],
  { stdio: 'inherit', env: process.env },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    repositoryWorker.kill(signal);
    pipelineWorker.kill(signal);
    process.exit(0);
  });
