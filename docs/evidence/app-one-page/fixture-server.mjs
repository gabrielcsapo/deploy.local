// Capture-only in-memory API. Never imports the coordinator, database, Docker or mDNS.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { fixture } from '../v2/polish-a/live-fixture.mjs';
const port = Number(process.env.PORT || 5180);
if (port < 5180 || port > 5185) throw new Error('Use ports 5180–5185');
const at = new Date().toISOString();
const f = fixture();
const apps = f.live.computers.flatMap((computer) => computer.apps);
const pantry = {
  ...apps.find((app) => app.appId === 'home-gym'),
  appId: 'pantry',
  name: 'pantry',
  project: 'pantry',
  release: 'c09ab12',
  address: 'https://pantry.deploy.local',
};
f.live.computers[0].apps.push(pantry);
for (const app of apps) app.project ||= `app:${app.name}`;
const projects = [...new Set(apps.map((app) => app.project))].map((id) => ({
  id,
  name: id.replace(/^app:/, ''),
  apps: apps
    .filter((app) => app.project === id)
    .map((app) => ({ id: app.appId, name: app.appId, kind: app.kind })),
}));
projects.push(
  { id: 'pantry', name: 'pantry', apps: [{ id: 'pantry', name: 'pantry', kind: 'web' }] },
  { id: 'empty', name: 'Repository only', apps: [] },
);
const release = (project, running = false) => ({
  id: running ? '7f3b2d4' : project.id === 'home-gym' ? '9c3e1fa' : 'c09ab12',
  projectId: project.id,
  state: running ? 'running' : 'live',
  startedBy: 'you',
  source: {
    kind: 'ship',
    ref: 'main',
    commit: running ? '7f3b2d4' : '9c3e1fa',
    message: running
      ? 'Stop the repositories cancellation test timing out'
      : 'Rename workouts.started to started_at',
  },
  apps: project.apps.map((app) => ({ appId: app.id, from: '81be0d2', to: '9c3e1fa' })),
  migrations:
    project.id === 'home-gym'
      ? [{ id: '0042', title: 'Renamed workouts.started to started_at', reversible: true }]
      : [],
  steps: ['prepare', 'verify', 'activate', 'watch'].map((name, index) => ({
    name,
    state: running ? (index === 0 ? 'done' : index === 1 ? 'running' : 'waiting') : 'done',
    startedAt: at,
    detail: index === 1 ? 'GET /healthz 200' : undefined,
  })),
});
let outputReads = 0;
const server = createServer();
const vite = await createVite({
  configFile: false,
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/app-one-page/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: { server, host: '127.0.0.1', port } },
  appType: 'custom',
});
server.on('request', async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = decodeURIComponent(url.pathname);
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/v2/projects') return send({ projects });
  if (path === '/api/v2/live') return send(f.live);
  if (path === '/api/v2/inbox') return send({ items: [f.item] });
  if (path === '/api/v2/events') {
    // The first read only asks where the feed is; pages wait on it before loading.
    if (url.searchParams.get('after') === 'latest')
      return send({ events: [], cursor: 1, supportsWait: true });
    const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path === '/api/workspace/state')
    return send({ cursor: 1, projects, tasks: [], runs: [], workers: [] });
  if (path === '/api/v2/agents') return send({ agents: [] });
  if (path === '/api/nodes') return send({ nodes: [{ id: 'ser', name: 'SER', online: true }] });
  if (path.startsWith('/api/v2/live/')) {
    const app = [...apps, pantry].find((candidate) => candidate.appId === path.split('/').at(-1));
    return app
      ? send({
          app,
          history: f.history,
          release: release(projects.find((project) => project.id === app.project)),
        })
      : send({ error: 'Not found' }, 404);
  }
  if (path.endsWith('/output'))
    return send({
      output:
        ++outputReads === 1
          ? ''
          : '#9 [build 4/6] RUN pnpm install --frozen-lockfile\n#9 11.9s Done in 11.4s\n#10 [build 5/6] RUN pnpm build\n#10 29.8s ✓ built in 28.6s\n#12 exporting to image\n#12 DONE 2.1s\nVerify: copy started on SER\nVerify: GET /healthz 200',
    });
  if (path.endsWith('/issues')) return send({ items: [] });
  if (path === '/api/v2/design/projects') return send({ projects: [] });
  if (path.endsWith('/design/reviews')) return send({ proposals: [] });
  if (path.endsWith('/pulls'))
    return send({
      items: [{ id: '18', number: 18, title: 'Show expiry dates', state: 'open', taskIds: [] }],
    });
  const match = path.match(
    /^\/api\/v2\/projects\/([^/]+)\/(overview|releases|rollbacks|logs|settings)$/,
  );
  if (match) {
    const project = projects.find((candidate) => candidate.id === match[1]);
    if (!project) return send({ error: 'Not found' }, 404);
    if (match[2] === 'overview')
      return send({
        project,
        repository: project.id.startsWith('app:')
          ? null
          : {
              status: 'ready',
              defaultBranch: 'main',
              source: { location: `git@example.test:gabriel/${project.name}.git` },
            },
        repositoryError: false,
        tasks:
          project.id === 'pantry'
            ? [{ id: 'task', title: 'Show expiry dates', status: 'completed' }]
            : [],
        pulls: project.id === 'pantry' ? [{ id: '18', state: 'open' }] : [],
        issues:
          project.id === 'pantry' ? [{ id: '1', title: 'Add expiry dates', state: 'open' }] : [],
        apps: project.apps.map((app) => ({ ...app, computer: 'SER', memoryLimit: '1 GB' })),
      });
    if (match[2] === 'releases')
      return send({
        releases: [release(project, project.id === 'app:deploy.local'), release(project)],
      });
    if (match[2] === 'rollbacks') return send({ rollbacks: [] });
    if (match[2] === 'logs')
      return send({
        sources: project.apps
          .filter((app) => !url.searchParams.has('app') || app.name === url.searchParams.get('app'))
          .map((app) => ({ app: app.name, url: `/api/deployments/${app.name}/logs` })),
      });
    return send({ values: [], appliesOn: 'next-release' });
  }
  if (path.startsWith('/api/') && path.endsWith('/logs')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(
      '2:31:07 PM  error  sync batch 8812 failed\n  column "started" does not exist\n  at readWorkouts (src/sync/workouts.ts:41)\n  retrying in 30 s (attempt 3 of 5)\n',
    );
  }
  if (path.startsWith('/api/') && path.endsWith('/requests/summary'))
    return send({
      range: '24h',
      from: Date.now() - 86400000,
      to: Date.now(),
      total: 18420,
      perMinuteNow: 13,
      serverErrors: 74,
      serverErrorRate: 0.004,
      usualServerErrorRate: 0.001,
      p50: 38,
      p95: 420,
      p99: 900,
      sentBytes: 1200000000,
      receivedBytes: 84000000,
      series: {
        bucketMs: 3600000,
        points: Array.from({ length: 25 }, (_, i) => ({
          at: Date.now() - (24 - i) * 3600000,
          perMinute: Math.round(20 + 14 * Math.sin(i / 3)),
          serverErrorsPerMinute: i > 20 ? i - 19 : 0,
        })),
      },
      peak: { perMinute: 41, at: Date.now() - 20 * 3600000 },
      releases: [],
      firstServerError: null,
      slowest: [],
      errorPaths: [],
    });
  if (path.endsWith('/performance') && path.startsWith('/api/')) {
    // Capture-only: PERFORMANCE_FIXTURE names a JSON file in the API's shape.
    const { readFileSync } = await import('node:fs');
    if (!process.env.PERFORMANCE_FIXTURE) return send({ error: 'No performance fixture' }, 404);
    return send(JSON.parse(readFileSync(process.env.PERFORMANCE_FIXTURE, 'utf8')));
  }
  if (path.startsWith('/api/') && path.endsWith('/requests'))
    return send({ rows: [], total: 0, page: 1, pageSize: 50 });
  if (path.startsWith('/api/')) return send({ error: 'Fixture endpoint unavailable' }, 404);
  if (path.startsWith('/dashboard')) {
    const html = await vite.transformIndexHtml(
      path,
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/docs/evidence/app-one-page/fixture.client.tsx"></script></body></html>',
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end();
  });
});
server.listen(port, '127.0.0.1', () =>
  console.log(`App fixture: http://127.0.0.1:${port}/dashboard/projects`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    server.closeAllConnections();
    server.close();
    await vite.close();
  });
