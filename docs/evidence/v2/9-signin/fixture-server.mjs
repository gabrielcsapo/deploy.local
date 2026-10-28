// Isolated UI/API fixture. Does not import the coordinator or touch its database.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
const port = Number(process.env.PORT || 5197);
if (port < 5180 || port > 5199) throw new Error('Fixture port must be 5180–5199');
const vite = await createVite({
  configFile: false,
  plugins: [
    react(),
    {
      name: 'fixture-certificate-trust',
      transform(code, id) {
        // Only this isolated fixture simulates certificate trust on loopback HTTP.
        if (id.endsWith('/app/routes/v2-public/auth-policy.ts'))
          return code.replace("context.location.protocol !== 'https:'", 'false');
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/v2/9-signin/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const board = new URL(req.headers.referer || `http://localhost:${port}`).searchParams.get(
    'board',
  );
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (url.pathname === '/api/v2/setup') return send({ name: 'SER', needsSetup: true });
  if (url.pathname === '/api/v2/auth/trust') return send({ trusted: true });
  if (url.pathname === '/api/v2/auth/methods') return send({ passkey: true, server: 'SER' });
  if (url.pathname === '/api/v2/auth/account')
    return ['AppsHome', 'AppsHomePhone', 'SessionExpired'].includes(board)
      ? send({}, 401)
      : send({
          username: 'gabriel',
          name: 'Gabriel',
          passkeyOffered: false,
          firstTaskSeen: false,
          hasPasskey: false,
        });
  if (url.pathname === '/api/v2/setup/recovery')
    return send({
      state: 'restored',
      summary:
        "From last night's backup on bazzite. Your account, projects, agents and secrets are already back; app data is landing now.",
      projects: [
        { name: 'deploy.local', detail: 'Coordinator · 2a91c0e', status: 'Running' },
        {
          name: 'home-gym',
          detail: 'Web app and sync worker · 81be0d2 · Postgres 1.2 GB',
          status: 'Running',
        },
        { name: 'Vaultwarden', detail: 'On bazzite, untouched', status: 'Running' },
        { name: 'Immich', detail: 'Photos 212 GB · 41% · about 18 min left', status: 'Restoring' },
        { name: 'Miniflux', detail: 'Waiting for Immich to finish', status: 'Waiting' },
      ],
    });
  if (url.pathname === '/api/v2/apps-home')
    return send({
      server: 'SER and bazzite',
      apps: [
        ['Photos', 'photos'],
        ['Passwords', 'vault'],
        ['Meals for the week', 'meal-planner'],
        ['Workouts', 'home-gym'],
        ['Reading', 'feeds'],
      ].map(([name, host]) => ({ name, address: `https://${host}.deploy.local` })),
    });
  if (url.pathname === '/api/v2/devices')
    return send({
      devices: [{ id: 'iphone', name: 'Gabriel’s iPhone', createdAt: '2026-10-27T12:00:00Z' }],
    });
  if (url.pathname === '/api/catalog')
    return send({
      releases: [
        { id: 'immich', release: 'v1.123.0', name: 'Immich', summary: 'Photo and video backup' },
      ],
    });
  if (url.pathname === '/api/catalog/targets')
    return send({ targets: [{ siteId: 'ser', name: 'SER' }] });
  if (url.pathname === '/api/catalog/immich/v1.123.0') return send({ release: { questions: [] } });
  if (url.pathname.startsWith('/api/')) return send({}, 404);
  if (url.pathname === '/') {
    const html = await vite.transformIndexHtml(
      '/',
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/docs/evidence/v2/9-signin/fixture.client.tsx"></script></body></html>',
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end();
  });
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Slice 9 fixtures: http://127.0.0.1:${port}/?board=FirstAccount`),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    server.closeAllConnections();
    server.close();
    await vite.close();
  });
