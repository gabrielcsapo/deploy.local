// Fixture for review captures: the real v2 design API over a copy of this repository,
// with design/review-clarity proposed against the main it was drawn on.
// Run: VITE_PORT=5191 pnpm dev:ui, then npx tsx docs/evidence/review-clarity-build/fixture-server.ts
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'review-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { save } = await import('../../../server/workspace/store.ts');
const { v2Api } = await import('../../../server/v2/api.ts');

const repo = join(root, 'source');
const source = resolve(import.meta.dirname, '../../..');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
execFileSync('git', ['clone', '-q', '--no-checkout', source, repo]);
git('fetch', '-q', 'origin', 'design/review-clarity:design/review-clarity');
git('checkout', '-q', '-B', 'main', '886961ae^');
git('config', 'user.name', 'Scout');
git('config', 'user.email', 'scout@deploy.local');
save('project', 'Gabriel', {
  id: 'deploy-local',
  name: 'deploy.local',
  repositoryPath: repo,
  repositoryStatus: 'ready',
});
save('project', 'Gabriel', { id: 'home-gym', name: 'home-gym', repositoryStatus: 'ready' });

const owner = () => ({ username: 'Gabriel' });
const call = async (path: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:5190${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(path, res.status, (await res.text()).slice(0, 200));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1:5190');
  const path = url.pathname;
  res.on('finish', () => console.log(res.statusCode, req.method, path));
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (path.startsWith('/api/')) {
    if (path === '/api/activity-events' || path.endsWith('/stream')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/api/user') return send({ username: 'Gabriel', role: 'admin' });
    if (path === '/api/auth/account')
      return send({
        username: 'Gabriel',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    if (path === '/api/nodes')
      return send({ nodes: [{ id: 'coordinator', name: 'SER', online: true }] });
    if (path === '/api/state')
      return send({
        version: 1,
        cursor: 0,
        projects: [{ id: 'deploy-local', name: 'deploy.local', apps: [] }],
        workers: [],
        tasks: [],
        runs: [],
        adapters: [],
      });
    if (path === '/api/live')
      return send({
        summary: { running: 0, failing: 0, warning: 0, checkedAt: new Date().toISOString() },
        computers: [],
      });
    if (path.startsWith('/api/')) {
      const before = res.writableEnded;
      await v2Api(req, res, owner as never);
      if ((res.writableEnded || res.headersSent) && !before) return;
    }
    if (!res.headersSent)
      return send({ error: `Fixture route unavailable: ${req.method} ${path}` }, 404);
    return;
  }
  const proxy = httpRequest(
    { hostname: '127.0.0.1', port: 5191, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    },
  );
  proxy.on('error', () => send({ error: 'Start Vite on 5191' }, 503));
  req.pipe(proxy);
});
server.listen(5190, '127.0.0.1', async () => {
  console.log(`Review fixture on http://127.0.0.1:5190 (data ${root})`);
  await call('/api/projects/deploy-local/design/propose', {
    ref: 'design/review-clarity',
    title: 'Make design review obvious',
    summary:
      'Design now opens on what waits for you. A review is a grid of the screens that changed, with a plain summary on top; open one to compare Before and After and pin what you want changed. On iPhone it is a pager, one screen at a time.',
  });
});
