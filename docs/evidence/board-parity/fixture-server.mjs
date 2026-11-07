// Run: DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5196 node docs/evidence/board-parity/fixture-server.mjs
// Removal capture: /dashboard/projects/home-gym/settings?appCount=1&removal=docker
// At 1440x900 and 700x900: open Remove project, type home-gym, capture the one-app
// wording; press Remove project and capture the Docker banner with confirmation retained.
// appCount=0 or 2 covers the other counts; omit removal=docker for the drawn partial case.
// Add &mac for desktop CSS emulation; native Electron chrome needs a real desktop capture.
// Synthetic APIs and Vite assets only: no coordinator, database, Docker or real data directory.
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { projectFixture } from '../v2/final/project-fixture.mjs';
import { fixture as liveFixture } from '../v2/polish-a/live-fixture.mjs';
import { backups } from '../v2/polish-a/backup-fixture.mjs';
import { fixture as taskFixture } from '../v2/3-task/fixtures.mjs';
if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
  throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
const port = Number(process.env.PORT || 5188);
if (![5188, 5189, 5190, 5191, 5196, 5197].includes(port))
  throw new Error('Use port 5188–5191 or 5196–5197');
const cacheDir = await mkdtemp(join(tmpdir(), 'deploy-board-parity-'));
const vite = await createVite({
  configFile: false,
  cacheDir,
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/board-parity/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const requests = [];
const agents = [
  { id: 'scout', name: 'Scout' },
  { id: 'warden', name: 'Warden' },
].map((agent) => ({
  ...agent,
  job: 'Look after your apps.',
  computers: [],
  createdBy: 'Gabriel',
  items: [],
  lessons: [],
}));
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const ref = new URL(req.headers.referer || url.href);
  const path = url.pathname;
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/api/fixture/requests') return send(requests);
  if (path === '/api/v2/backups/run') {
    requests.push({ method: req.method, path });
    await new Promise((done) => setTimeout(done, 500));
    return send(
      {
        error:
          'Backup destination /mnt/backup does not exist. If it is on a drive, the drive is not mounted. Nothing was written.',
      },
      409,
    );
  }
  if (req.method === 'DELETE' && /^\/api\/v2\/projects\/[^/]+$/.test(path))
    return send(
      {
        error:
          ref.searchParams.get('removal') === 'docker'
            ? "Docker isn't running on this computer, so nothing was removed. Start it, then press Remove project."
            : 'Removal is not finished. Still on this machine: deploy-sh-home-gym-web-1, deploy-sh-home-gym-default. Press Remove project to try again.',
      },
      409,
    );
  if (path === '/api/v2/backups') {
    requests.push({ method: req.method, path });
    if (ref.searchParams.has('loadError')) return send({ error: 'Backups could not load.' }, 503);
    return send({
      backups,
      restores: [],
      schedules: [
        {
          name: 'bazzite',
          enabled: true,
          schedule: '0 3 * * *',
          destination: '/mnt/backup',
          contents: 'App data and encrypted recovery bundles',
        },
      ],
    });
  }
  const f = liveFixture();
  if (path === '/api/v2/live') return send(f.live);
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/nodes')
    return send({
      nodes: [
        { id: 'ser', name: 'SER', online: true },
        { id: 'bazzite', name: 'bazzite', online: true },
      ],
    });
  if (path === '/api/v2/agents') return send({ agents });
  if (/^\/api\/v2\/agents\/[^/]+\/conversation$/.test(path))
    return send({ events: [], tracking: { running: [], watching: [], shipped: [] } });
  if (path === '/api/v2/computers') return send({ computers: [] });
  if (path === '/api/v2/inbox')
    return send({ items: url.searchParams.get('state') === 'answered' ? [] : [f.item] });
  if (path === '/api/v2/auth/account')
    return send({ username: 'gabriel', welcomed: true, firstTaskSeen: true });
  if (path === '/api/v2/setup') return send({ name: 'SER', needsSetup: false });
  if (path === '/api/v2/packages') return send({ served: false });
  if (path.endsWith('/events')) {
    const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 1000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path.startsWith('/api/v2/tasks/'))
    return send({ ...taskFixture('FirstTask'), firstTask: false });
  if (path.startsWith('/api/')) {
    const count = ref.searchParams.get('appCount');
    await projectFixture(req, res, {
      removalAppCount: count !== null && /^[0-2]$/.test(count) ? Number(count) : undefined,
    });
    if (!res.writableEnded) send({}, 404);
    return;
  }
  if (path.startsWith('/dashboard')) {
    res.setHeader('Content-Type', 'text/html');
    return res.end(
      await vite.transformIndexHtml(
        path,
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/docs/evidence/board-parity/fixture.client.tsx"></script></body></html>',
      ),
    );
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end();
  });
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Board parity fixture: http://127.0.0.1:${port}/dashboard`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    server.closeAllConnections();
    server.close();
    await vite.close();
    await rm(cacheDir, { recursive: true, force: true });
  });
