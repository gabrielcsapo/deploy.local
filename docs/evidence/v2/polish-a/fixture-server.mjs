// Fixture-only server. No coordinator, database, Docker or worker imports.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { fixture as liveFixture } from './live-fixture.mjs';
import { apps, live, failed, previous, bad, rollback, release } from './release-fixture.mjs';
import { backups } from './backup-fixture.mjs';
import { fixture as taskFixture } from '../3-task/fixtures.mjs';
const port = 5194;
const preview = {
  found: [
    { name: 'home-gym', detail: 'Web app · vite build · serves port 3000' },
    { name: 'home-gym sync', detail: 'Worker · node dist/sync.js · no port' },
    { name: 'Postgres 17', detail: 'From docker-compose.yml · data kept on SER' },
  ],
  runsOn: 'Choose when you ship',
  address: 'home-gym.deploy.local',
};
const vite = await createVite({
  configFile: false,
  plugins: [
    react(),
    {
      name: 'inspected-repository-fixture',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/app/routes/dashboard/v2/start/page.client.tsx')) return;
        // Seed the result of Inspect repository so the prescribed capture needs no clicks.
        return code
          .replace(
            "const [source, setSource] = useState('');",
            "const [source, setSource] = useState('git@github.com:gabriel/home-gym.git');",
          )
          .replace(
            'useState<RepositoryPreview>();',
            `useState<RepositoryPreview>(${JSON.stringify(preview)});`,
          );
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/v2/polish-a/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
});
const requests = [];
let undone = false;
let started = false;
let answered = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = decodeURIComponent(url.pathname);
  const referer = new URL(req.headers.referer || `http://localhost:${port}`);
  const board = referer.searchParams.get('board');
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  const f = liveFixture();
  if (board === 'AutoRollback') {
    f.live.summary.failing = 0;
    f.live.rollbacks = undone ? [] : [rollback];
    for (const app of f.live.computers
      .flatMap((computer) => computer.apps)
      .filter((app) => app.project === 'home-gym')) {
      app.release = undone ? rollback.from : rollback.to;
      app.state = 'healthy';
      if (app.kind === 'worker') {
        app.summary = 'Queue drained · 0 failures since 2:16 PM';
        app.jobs = { perMin: 31, failRate: 0, baselineFailRate: 0.01 };
        app.queue = { depth: 0, oldestSec: 0 };
      }
    }
  }
  if (started)
    for (const app of f.live.computers.flatMap((computer) => computer.apps))
      if (app.appId === 'recipes') app.state = 'healthy';
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path, body });
    if (path === '/api/start/inspect') return send(preview);
    if (path.endsWith('/restart')) {
      started = true;
      return send({ message: 'Started' });
    }
    if (path.endsWith('/rollback')) {
      undone = true;
      return send({ rollback: { ...rollback, from: body.from, to: body.to } });
    }
    if (path === '/api/tasks') return send({ id: 'FixRelease' }, 201);
    if (path === '/api/backups/run') return send({ success: true });
    if (path.endsWith('/answer')) {
      answered = true;
      return send({
        item: {
          ...f.item,
          state: 'answered',
          answer: {
            actionId: body.actionId,
            on: body.on,
            at: new Date().toISOString(),
            by: 'gabriel',
          },
        },
      });
    }
    if (path.endsWith('/restore'))
      return send({
        restore: {
          id: 'copy',
          backupId: 'pre-release',
          projectId: 'home-gym',
          state: 'ready',
          createdAt: new Date().toISOString(),
          addresses: [{ app: 'home-gym', url: `http://localhost:${port}/copy` }],
        },
      });
  }
  if (path === '/api/fixture/requests') return send(requests);
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/nodes')
    return send({
      nodes: [
        { online: true, name: 'SER' },
        { online: true, name: 'bazzite' },
      ],
    });
  if (path === '/api/agents')
    return send({
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    });
  if (path === '/api/activity-events' || path === '/api/events') {
    const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path === '/api/inbox') {
    const titles = [
      'Roll back home-gym to 81be0d2',
      'Start the self-release pipeline',
      'Launch the bazzite app one way, not two',
      'Merge PR #17',
      'Restart Vaultwarden',
      'Use your screen to check the iOS build',
      'Merge PR #16',
    ];
    const items = titles.map((title, index) => {
      const at = new Date();
      at.setHours(14, 33 - index, 0, 0);
      if (index > 4) at.setDate(at.getDate() - 1);
      return {
        id: `answered-${index}`,
        title,
        text: title,
        kind: 'other',
        from: index === 0 || index === 4 ? 'warden' : 'scout',
        createdAt: at.toISOString(),
        actions: [
          {
            id: index === 4 ? 'rule' : 'approve',
            label: [
              'Approved',
              'Approved with a change',
              'Not now',
              'Approved',
              'Allowed by rule',
              'Allowed',
              'Approved',
            ][index],
          },
        ],
        state: 'answered',
        ...(index === 4
          ? {}
          : {
              answer: {
                actionId: 'approve',
                by: 'Gabriel',
                on: index === 3 ? 'iphone' : 'desktop',
                ...(index === 0 ? { surface: 'menu-bar' } : {}),
                at: at.toISOString(),
              },
            }),
        ...([0, 3, 4, 5, 6].includes(index)
          ? {
              outcome: {
                text: [
                  'Healthy after 10 min',
                  '',
                  '',
                  'Released 0d96f82',
                  'Allowed by rule',
                  'Ended after 6 min',
                  'Released d279f45',
                ][index],
                tone: 'ok',
              },
            }
          : {}),
      };
    });
    return send({
      items:
        url.searchParams.get('state') === 'answered'
          ? items
          : board === 'AutoRollback' || answered
            ? []
            : [f.item],
    });
  }
  if (path === '/api/live') return send(f.live);
  if (path.startsWith('/api/live/'))
    return send({
      app: f.live.computers
        .flatMap((computer) => computer.apps)
        .find((app) => app.appId === path.split('/').at(-1)),
      history: f.history,
      release: {
        ...bad,
        source: { kind: 'pr', ref: 'Rename workouts.started to started_at' },
        migrations: [
          { id: '0042', title: 'Renamed workouts.started to started_at', reversible: true },
        ],
      },
    });
  if (path.includes('/logs')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(
      'Error: column "started" does not exist\n  at syncWorkouts (src/sync.ts:42)\n  at runBatch (src/worker.ts:18)',
    );
  }
  if (path === '/api/projects')
    return send({
      projects: [
        { id: 'deploy.local', name: 'deploy.local', apps },
        { id: 'home-gym', name: 'home-gym', apps },
      ],
    });
  if (path.endsWith('/overview'))
    return send({
      project: { id: path.split('/')[4], name: path.split('/')[4], apps },
      repository: { status: 'ready' },
      pulls: [{ id: '18' }],
      issues: [{ id: '1' }],
      apps,
      tasks: [],
    });
  if (path.endsWith('/releases'))
    return send({
      releases: referer.pathname.includes('/tasks')
        ? []
        : path.includes('deploy.local')
          ? [
              live,
              release('0d96f82', 'deploy.local', 'superseded', 'PR #17'),
              release('d279f45', 'deploy.local', 'superseded', 'PR #16'),
            ]
          : [
              {
                ...failed,
                steps: failed.steps.map((step) =>
                  step.name === 'verify'
                    ? {
                        ...step,
                        detail:
                          'Error: REST_SOUNDS_URL is not set\n  at loadConfig (src/config.ts:12)\n  at start (src/server.ts:8)',
                      }
                    : step,
                ),
              },
              previous,
              bad,
            ],
    });
  if (path.endsWith('/rollbacks')) return send({ rollbacks: [] });
  if (path === '/api/backups')
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
  if (path === '/api/apps-home')
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
  if (path === '/api/auth/account')
    return referer.pathname === '/'
      ? send({}, 401)
      : send({ username: 'gabriel', welcomed: true, firstTaskSeen: false, hasPasskey: false });
  if (path === '/api/auth/methods') return send({ passkey: false, server: 'SER' });
  if (path === '/api/setup') return send({ name: 'SER', needsSetup: false });
  if (path === '/api/catalog')
    return send({
      releases: [
        { id: 'immich', release: 'v1.123.0', name: 'Immich', summary: 'Photo and video backup' },
      ],
    });
  if (path === '/api/catalog/targets')
    return send({
      targets: [
        {
          siteId: 'ser',
          name: 'SER',
          siteKind: 'coordinator',
          memoryMiB: 8192,
          storageMiB: 1200000,
        },
      ],
    });
  if (path === '/api/catalog/releases/immich/v1.123.0')
    return send({
      release: {
        questions: [],
        application: {
          resources: {
            photos: {
              displayName: 'Photos and database',
              source: { hostPath: '/srv/immich' },
              backup: { policy: 'include' },
            },
          },
        },
      },
    });
  if (path.startsWith('/api/task-snapshots/')) {
    const task = taskFixture('FirstTask');
    if (!path.endsWith('/FirstTask')) task.firstTask = false;
    return send(task);
  }
  if (path === '/api/state') return send({ projects: [], tasks: [], runs: [] });
  if (path.startsWith('/api/')) return send({}, 404);
  if (path === '/about' || path === '/' || path === '/signin' || path.startsWith('/dashboard')) {
    const html = await vite.transformIndexHtml(
      path,
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/docs/evidence/v2/polish-a/fixture.client.tsx"></script></body></html>',
    );
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }
  vite.middlewares(req, res, () => {
    res.writeHead(404);
    res.end();
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Polish A fixture: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    server.closeAllConnections();
    server.close();
    await vite.close();
  });
