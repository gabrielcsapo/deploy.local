// Isolated API fixture for hosted projects and remote sync, copied from app-requests: the boards' data, in memory.
import { createServer } from 'node:http';
const at = new Date().toISOString();
const app = (name, kind = 'web') => ({ id: name, name, kind });
const projects = [
  { id: 'deploy.local', name: 'deploy.local', apps: [app('deploy.local')] },
  { id: 'home-gym', name: 'home-gym', apps: [app('home-gym'), app('home-gym-sync', 'worker')] },
  { id: 'recipes', name: 'recipes', apps: [] },
  { id: 'bazzite', name: 'bazzite', apps: [app('bazzite')] },
  { id: 'pantry', name: 'pantry', apps: [app('pantry')] },
  { id: 'immich', name: 'Immich', apps: [app('Immich')] },
];
const tasks = [
  {
    id: 'release',
    projectId: 'deploy.local',
    title: 'Self-release pipeline',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  },
  {
    id: 'checks',
    projectId: 'deploy.local',
    title: 'Show checks on merged PRs',
    status: 'ready',
    createdAt: at,
    updatedAt: at,
  },
  {
    id: 'sync',
    projectId: 'home-gym',
    title: 'Fix the sync migration',
    status: 'running',
    createdAt: at,
    updatedAt: at,
  },
];
const issues = [
  "Merged pull requests don't show their checks",
  'Any non-test command marks checks as earlier',
  'Launch the bazzite app one way, not two',
  'Repositories cancellation test flakes',
  'Mac Clone popover needs a check on a locked screen',
].map((title, index) => ({
  id: String(index),
  title,
  state: 'open',
  ...(index === 0 ? { taskId: 'checks' } : {}),
}));
const liveApps = projects.flatMap((project) =>
  project.apps.map((a) => ({
    appId: a.id,
    name: a.name,
    kind: a.kind,
    project: project.id,
    state:
      a.name === 'home-gym-sync'
        ? 'failing'
        : a.name === 'recipes'
          ? 'stopped'
          : a.name === 'Immich'
            ? 'warning'
            : 'healthy',
    summary:
      a.name === 'Immich'
        ? 'Memory has been at 92% of its 4 GB limit for 20 minutes.'
        : a.kind === 'worker'
          ? '38% of jobs error since 1:58 PM'
          : 'GET /healthz 200',
    ...(a.kind === 'web'
      ? {
          address: `https://${a.name === 'Immich' ? 'photos.deploy.local' : a.name === 'deploy.local' ? 'deploy.local' : a.name + '.deploy.local'}`,
          http: {
            path: '/healthz',
            status: 200,
            reqPerMin: a.name === 'pantry' ? 6 : 184,
            p95ms: a.name === 'pantry' ? 28 : a.name === 'Immich' ? 210 : 42,
          },
        }
      : {
          jobs: { perMin: 9, failRate: 0.38, baselineFailRate: 0.01 },
          queue: { depth: 1240, oldestSec: 840 },
        }),
    release:
      a.name === 'pantry'
        ? 'c09ab12'
        : a.name === 'Immich'
          ? 'v1.122.3'
          : project.id === 'home-gym'
            ? '9c3e1fa'
            : '2a91c0e',
    releasedAt: at,
  })),
);
const values = [
  { key: 'NODE_ENV', type: 'string', value: 'production', set: true, updatedAt: at },
  { key: 'DATABASE_URL', type: 'secret', set: true, updatedAt: at },
  {
    key: 'STRAVA_CLIENT_ID',
    type: 'string',
    value: '48120',
    app: 'home-gym-sync',
    set: true,
    updatedAt: at,
  },
  { key: 'STRAVA_CLIENT_SECRET', type: 'secret', app: 'home-gym-sync', set: true, updatedAt: at },
];
const releases = (project) =>
  ['2a91c0e', '0d96f82', 'd279f45'].slice(0, project.id === 'pantry' ? 2 : 3).map((id, index) => ({
    id: project.id === 'pantry' && index === 0 ? 'c09ab12' : id,
    projectId: project.id,
    source: {
      kind: 'pr',
      ref: [
        'Pass worker TLS trust to tool servers',
        'Keep leading zeros in SSH keys',
        'Queue runs per computer',
      ][index],
    },
    startedBy: 'Gabriel',
    apps: project.apps.map((a) => ({ appId: a.id, to: id })),
    migrations: [],
    state: index ? 'superseded' : 'live',
    steps: ['prepare', 'verify', 'activate', 'watch'].map((name) => ({
      name,
      state: 'done',
      startedAt: at,
      endedAt: at,
    })),
  }));
const today = (h, m, s = 0) => {
  const d = new Date();
  d.setHours(h, m, s, 0);
  return d.getTime();
};
const requestsTo = today(15, 0);
const shape = [
  104, 98, 92, 74, 40, 28, 46, 70, 92, 112, 124, 128, 126, 118, 100, 82, 76, 80, 72, 78, 74, 70, 66,
  72, 68,
];
const points = Array.from({ length: 97 }, (_, i) => {
  const t = (i / 96) * (shape.length - 1);
  const lo = shape[Math.floor(t)];
  const v = lo + (shape[Math.ceil(t)] - lo) * (t - Math.floor(t));
  const at = requestsTo - 86_400_000 + i * 900_000;
  return {
    at,
    perMinute: ((138 - v) / 128) * 41,
    serverErrorsPerMinute: at >= today(13, 58) ? [3, 6, 2, 8, 5, 7][i % 6] : 0,
  };
});
const requestRows = [
  [today(14, 31, 7), 'GET', '/api/workouts/export', '?range=year', 502, 15000],
  [today(14, 31, 5), 'GET', '/', null, 200, 24],
  [today(14, 31, 4), 'POST', '/api/sessions', null, 500, 88],
  [today(14, 31, 2), 'GET', '/assets/app-3f9a.js', null, 304, 3],
  [today(14, 30, 58), 'GET', '/api/stats/weekly', null, 200, 486],
  [today(14, 30, 51), 'GET', '/api/plans/42', null, 200, 31],
  [today(14, 30, 49), 'GET', '/settings', null, 401, 6],
  [today(14, 30, 44), 'POST', '/api/workouts', null, 201, 212],
].map(([at, method, p, query, status, duration], index) => ({
  id: 18420 - index,
  at,
  method,
  path: p,
  query,
  status,
  duration,
}));
function requestsRoute(path, url, send) {
  const match = path.match(/^\/api\/apps\/([^/]+)\/requests(?:\/(summary|\d+))?$/);
  if (!match) return false;
  if (match[2] === 'summary')
    send({
      range: url.searchParams.get('range') || '24h',
      from: requestsTo - 86_400_000,
      to: requestsTo,
      total: 18420,
      perMinuteNow: 13,
      serverErrors: 74,
      serverErrorRate: 0.004,
      usualServerErrorRate: 0.001,
      p50: 38,
      p95: 420,
      p99: 2100,
      sentBytes: 1.2 * 1024 ** 3,
      receivedBytes: 84 * 1024 ** 2,
      series: { bucketMs: 900_000, points },
      peak: { perMinute: 41, at: today(19, 12) - 86_400_000 },
      releases: [{ id: 'r1', label: '9c3e1fa', at: today(13, 58) }],
      firstServerError: { at: today(13, 58), release: '9c3e1fa' },
      slowest: [
        { method: 'GET', path: '/api/workouts/export', count: 212, p95: 15000, noAnswer: 41 },
        { method: 'POST', path: '/api/workouts', count: 1380, p95: 640, noAnswer: 0 },
        { method: 'GET', path: '/api/stats/weekly', count: 2104, p95: 520, noAnswer: 0 },
      ],
      errorPaths: [
        {
          method: 'GET',
          path: '/api/workouts/export',
          count: 41,
          status: 502,
          reason: 'no answer in 15 s',
        },
        {
          method: 'POST',
          path: '/api/sessions',
          count: 22,
          status: 500,
          reason: 'duplicate key in sessions_pkey',
        },
        { method: 'GET', path: '/api/plans/:id', count: 11, status: 503, reason: null },
      ],
    });
  else if (match[2])
    send({
      request: {
        ...requestRows[0],
        ip: '192.168.1.24',
        username: 'gabriel',
        referrer: 'https://home-gym.deploy.local/history',
        browser: 'Safari on iPhone',
        release: '9c3e1fa',
        reason: 'no answer in 15 s',
        failure: 'timeout',
      },
      capture: {
        request: {
          headers: {
            accept: 'application/json',
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US',
            cookie: 'hidden',
            referer: 'https://home-gym.deploy.local/history',
            'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) Safari/605.1',
          },
          body: null,
          bodyBytes: 0,
          bodyTruncated: false,
        },
        response: null,
        keptUntil: requestRows[0].at + 14 * 86_400_000,
      },
      path: { count: 212, serverErrors: 41, noAnswer: 41, p95: 15000, median: 3800 },
    });
  else send({ rows: requestRows, total: 18420, page: 1, pageSize: 50 });
  return true;
}

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const repositories = {
  recipes: {
    source: { kind: 'hosted', location: null, syncPolicy: 'none' },
    empty: true,
    sync: null,
  },
  'home-gym': {
    source: {
      kind: 'remote',
      location: 'git@github.com:gabriel/home-gym.git',
      syncPolicy: 'both-ways',
    },
    sync: { state: 'in-sync', at: minutesAgo(2), changedAt: minutesAgo(90) },
  },
  pantry: {
    source: {
      kind: 'remote',
      location: 'git@github.com:gabriel/pantry.git',
      syncPolicy: 'both-ways',
    },
    sync: { state: 'paused', at: minutesAgo(1), changedAt: minutesAgo(10) },
  },
  bazzite: {
    source: { kind: 'local', location: '/srv/projects/bazzite', syncPolicy: 'manual-fetch' },
    sync: null,
    operation: { id: 'f', kind: 'fetch', status: 'succeeded', completedAt: minutesAgo(60) },
  },
};
const repository = (project) => ({
  status: 'ready',
  defaultBranch: 'main',
  head: '2a91c0e',
  source: { location: `git@github.com:gabriel/${project.name}.git` },
  clonePath: `/${project.id}.git`,
  empty: false,
  sync: null,
  operation: null,
  ...repositories[project.id],
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (path === '/api/projects') return send({ projects: projects.slice(0, 5) });
  const repositoryMatch = path.match(/^\/api\/projects\/([^/]+)\/repository$/);
  if (repositoryMatch) {
    const project = projects.find((p) => p.id === repositoryMatch[1]);
    return project ? send(repository(project)) : send({ error: 'Project not found' }, 404);
  }
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/nodes')
    return send({
      nodes: [
        { id: 'ser', name: 'SER', online: true },
        { id: 'bazzite', name: 'bazzite', online: true },
        { id: 'mac', name: 'MacBook Pro', online: true },
      ],
    });
  if (path === '/api/state') return send({ tasks, runs: [], projects });
  if (path === '/api/agents')
    return send({
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    });
  if (path === '/api/inbox')
    return send({
      items: [
        {
          id: 'rollback',
          kind: 'rollback',
          title: 'Roll back home-gym?',
          text: '',
          from: 'warden',
          createdAt: at,
          state: 'waiting',
          actions: [],
        },
        {
          id: 'merge',
          kind: 'merge',
          title: 'Merge PR #18',
          text: '',
          from: 'scout',
          createdAt: at,
          state: 'waiting',
          actions: [],
        },
        {
          id: 'keep',
          kind: 'question',
          title: 'Keep 3 or 5 releases?',
          text: '',
          from: 'scout',
          createdAt: at,
          state: 'waiting',
          actions: [],
        },
      ],
    });
  if (path === '/api/activity-events') {
    const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 10000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path === '/api/live')
    return send({
      summary: { running: 7, failing: 1, warning: 1, checkedAt: at },
      computers: [{ id: 'ser', name: 'SER', roles: ['coordinator'], online: true, apps: liveApps }],
    });
  if (path.startsWith('/api/live/'))
    return send({ app: liveApps.find((a) => a.appId === path.split('/').at(-1)), history: [] });
  if (requestsRoute(path, url, send)) return;
  const match = path.match(
    /^\/api\/projects\/([^/]+)\/(overview|releases|settings|logs|apps|secrets\/[^/]+)$/,
  );
  if (match) {
    const project = projects.find((p) => p.id === match[1]);
    if (!project) return send({ error: 'Project not found' }, 404);
    if (match[2] === 'overview')
      return send({
        project,
        repository: project.id === 'immich' ? null : repository(project),
        repositoryError: false,
        tasks: tasks.filter((t) => t.projectId === project.id),
        issues:
          project.id === 'deploy.local'
            ? issues
            : project.id === 'home-gym'
              ? issues.slice(0, 1)
              : [],
        pulls: ['deploy.local', 'home-gym'].includes(project.id)
          ? [
              { id: '18', title: 'Show checks on merged PRs', state: 'open', taskId: 'checks' },
              ...(project.id === 'deploy.local' ? [{ id: '19', state: 'open' }] : []),
            ]
          : [],
        apps: project.apps.map((a) => ({
          ...a,
          computer: 'SER',
          memoryLimit: project.id === 'immich' ? '4 GB' : '1 GB',
        })),
      });
    if (match[2] === 'releases')
      return send({ releases: project.apps.length ? releases(project) : [] });
    if (match[2] === 'settings' || match[2].startsWith('secrets/'))
      return send({ values, appliesOn: 'next-release' });
    if (match[2] === 'logs')
      return send({
        sources: project.apps
          .filter((a) => !url.searchParams.get('app') || a.name === url.searchParams.get('app'))
          .map((a) => ({
            app: a.name,
            url: `/api/deployments/${encodeURIComponent(a.name)}/logs`,
          })),
      });
    if (match[2] === 'apps') return send({ project });
  }
  if (/^\/api\/deployments\/[^/]+\/logs$/.test(path)) {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Accel-Buffering': 'no' });
    res.write(
      [
        '14:16:02  edge         info   GET /api/state 200 18ms',
        '14:16:01  coordinator  info   worker heartbeat',
        '14:15:58  coordinator  warn   run queue: MacBook Pro busy, queued task for bazzite',
        '14:15:51  edge         info   POST /tasks/messages 202 41ms',
        '14:15:47  home-gym     error  POST /sync column "started" does not exist',
        '14:15:40  coordinator  info   checkpoint captured',
        '14:15:33  edge         info   GET /deploy.local.git/info/refs 200 9ms',
        '14:15:20  lemond       info   Qwen3-8B · 412 tokens · 15.2 tok/s',
        '14:15:02  edge         info   GET /healthz 200 2ms',
        '',
      ].join('\n'),
    );
    const timer = setInterval(() => res.write(''), 10000);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (path.endsWith('/repository/tree'))
    return send({
      entries: ['app', 'native', 'packages', 'server', 'scripts', 'README.md', 'package.json'].map(
        (name, index) => ({
          name,
          path: name,
          type: index < 5 ? 'tree' : 'blob',
          lastCommit: {
            subject: [
              'Separate phone layout from desktop',
              'Clone popover in the Mac app',
              'Shared design tokens',
              'Pass worker TLS trust to tool servers',
              'Release prepare and verify',
              'Document hosted Git',
              'Patch ssh2 for Ed25519 keys',
            ][index],
            date: at,
          },
        }),
      ),
    });
  if (path.endsWith('/repository/blob'))
    return send({
      content: '# deploy.local\n\nDeploy apps and run coding agents on computers you own.',
    });
  if (path.endsWith('/repository/history'))
    return send({
      commits: [
        { oid: '2a91c0e', subject: 'Pass worker TLS trust to tool servers', author: 'Gabriel' },
      ],
    });
  send({ error: 'Fixture endpoint not found' }, 404);
});
server.listen(5184, '127.0.0.1', () => console.log('Hosted projects fixture on 5184'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
