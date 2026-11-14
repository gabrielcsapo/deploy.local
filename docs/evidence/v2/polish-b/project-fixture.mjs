// Isolated API fixture: never imports the coordinator, opens a DB, or runs apps.
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const at = ago(12);
const app = (name, kind = 'web') => ({ id: name, name, kind });
const projects = [
  { id: 'deploy.local', name: 'deploy.local', apps: [app('deploy.local')] },
  { id: 'home-gym', name: 'home-gym', apps: [app('home-gym'), app('home-gym-sync', 'worker')] },
  { id: 'recipes', name: 'recipes', apps: [app('recipes')] },
  { id: 'notes-sync', name: 'notes-sync', apps: [] },
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
    updatedAt: ago(40),
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
  { key: 'DATABASE_URL', type: 'secret', set: true, updatedAt: ago(9 * 1440) },
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
      startedAt: ago(360 + index * 1440),
      endedAt: ago(360 + index * 1440),
    })),
  }));
export async function projectFixture(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (/^\/api\/tasks\//.test(path))
    return send({
      computer: path.endsWith('release') ? 'MacBook Pro' : undefined,
      run: {
        status: path.endsWith('release') ? 'running' : 'succeeded',
        updatedAt: path.endsWith('release') ? ago(12) : ago(40),
      },
    });
  if (/^\/api\/tasks\/.*\/diff$/.test(path))
    return send({
      patch: path.includes('/checks/')
        ? 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,12 +1,88 @@\n' +
          Array(88).fill('+new').concat(Array(12).fill('-old')).join('\n')
        : '',
    });
  if (path.endsWith('/pulls'))
    return send({
      items: [
        {
          id: '18',
          number: 18,
          title: 'Show checks on merged PRs',
          status: 'open',
          taskIds: ['checks'],
        },
        {
          id: '19',
          number: 19,
          title: 'Self-release pipeline',
          status: 'open',
          taskIds: ['release'],
        },
      ],
    });
  if (path === '/api/projects') return send({ projects: projects.slice(0, 4) });
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
  const match = path.match(
    /^\/api\/projects\/([^/]+)\/(overview|releases|settings|logs|apps|secrets\/[^/]+)$/,
  );
  if (match) {
    const project = projects.find((p) => p.id === match[1]);
    if (!project) return send({ error: 'Project not found' }, 404);
    if (match[2] === 'overview')
      return send({
        project,
        repository:
          project.id === 'immich'
            ? null
            : {
                status: 'ready',
                defaultBranch: 'main',
                head: '2a91c0e',
                source: { location: `git@github.com:gabriel/${project.name}.git` },
                clonePath: `/api/git/${project.id}`,
              },
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
}
