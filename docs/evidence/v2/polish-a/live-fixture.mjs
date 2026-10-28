// Capture-only data adapted from ../2-live/fixture-server.mjs; no production imports.
// Isolated visual fixture only. Run with node; never mounts the coordinator or Docker.
const web = (name, address, path, reqPerMin, p95ms, release, days) => ({
  appId: name.toLowerCase(),
  name,
  kind: 'web',
  state: 'healthy',
  summary: `GET ${path} 200`,
  address: `https://${address}`,
  http: { path, status: 200, reqPerMin, p95ms },
  release,
  releasedAt: new Date(Date.now() - days * 86400000).toISOString(),
});
function fixture() {
  const now = Date.now();
  const worker = {
    appId: 'home-gym-sync',
    name: 'home-gym sync',
    project: 'home-gym',
    kind: 'worker',
    state: 'failing',
    summary: '38% of jobs error since 1:58 PM',
    jobs: { perMin: 9, failRate: 0.38, baselineFailRate: 0.01 },
    queue: { depth: 1240, oldestSec: 840 },
    restarts: { count: 3, windowSec: 600 },
    heartbeatAt: new Date(now - 4000).toISOString(),
    release: '9c3e1fa',
    releasedAt: new Date(now - 34 * 60000).toISOString(),
  };
  const apps = [
    worker,
    {
      ...web('Immich', 'photos.deploy.local', '/health', 3, 210, 'v1.122.3', 4),
      state: 'warning',
      summary: '92% of 4 GB for 20 min',
    },
    {
      ...web('home-gym', 'home-gym.deploy.local', '/healthz', 12, 38, '9c3e1fa', 34 / 1440),
      project: 'home-gym',
    },
    web('deploy.local', 'deploy.local', '/healthz', 184, 42, '2a91c0e', 0.25),
    {
      appId: 'recipes',
      name: 'recipes',
      kind: 'web',
      state: 'stopped',
      summary: 'Stopped by you 3 days ago · would run on SER',
    },
  ];
  const others = [
    web('Vaultwarden', 'vault.deploy.local', '/alive', 1, 25, '1.32.0', 9),
    web('Miniflux', 'feeds.deploy.local', '/healthcheck', 2, 31, '2.2.3', 12),
    {
      appId: 'miniflux-fetcher',
      name: 'Miniflux fetcher',
      project: 'Miniflux',
      kind: 'worker',
      state: 'healthy',
      summary: 'Heartbeat 3 s ago',
      jobs: { perMin: 14, failRate: 0, baselineFailRate: 0.01 },
      queue: { depth: 0, oldestSec: 0 },
      release: '2.2.3',
      releasedAt: new Date(now - 12 * 86400000).toISOString(),
    },
  ];
  const item = {
    id: 'rollback:home-gym:9c3e1fa',
    kind: 'rollback',
    projectId: 'home-gym',
    title: 'Roll back home-gym to 81be0d2?',
    text: 'home-gym sync fails 38% of jobs with column "started" does not exist since the 1:58 PM release. The web app and the worker ship as one release, so both go back and migration 0042 is undone.',
    from: 'warden',
    state: 'waiting',
    createdAt: new Date(now).toISOString(),
    actions: [
      { id: 'rollback', label: 'Roll back home-gym', primary: true },
      { id: 'dismiss', label: 'Not now' },
    ],
  };
  return {
    worker,
    item,
    live: {
      summary: {
        running: 7,
        failing: 1,
        warning: 1,
        checkedAt: new Date(now - 20000).toISOString(),
      },
      computers: [
        {
          id: 'ser',
          name: 'SER',
          roles: ['coordinator'],
          online: true,
          cpu: 14,
          memory: 38,
          disk: 61,
          apps,
        },
        {
          id: 'bazzite',
          name: 'bazzite',
          roles: ['take-tasks', 'run-apps'],
          online: true,
          cpu: 22,
          memory: 51,
          apps: others,
        },
      ],
    },
    history: Array.from({ length: 12 }, (_, i) => ({
      at: new Date(now - (11 - i) * 5 * 60000).toISOString(),
      failRate: i < 6 ? 0.01 : [0.2, 0.3, 0.34, 0.36, 0.38, 0.38][i - 6],
    })),
  };
}

export { fixture };
