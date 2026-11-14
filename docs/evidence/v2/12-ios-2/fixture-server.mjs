import http from 'node:http';
import { createHash } from 'node:crypto';

const port = Number(process.env.PORT || 5186);
if (port !== 5186) throw new Error('This slice uses only port 5186');
const origin = `http://127.0.0.1:${port}`;
const at = (time) => {
  const date = new Date();
  const [hour, minute] = time.split(':').map(Number);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
};
const projects = ['deploy.local', 'home-gym', 'recipes', 'meal-planner'].map((name) => ({
  id: name,
  name,
  apps:
    name === 'recipes'
      ? []
      : [
          { id: name, name, kind: 'web' },
          ...(name === 'home-gym'
            ? [{ id: 'home-gym-sync', name: 'home-gym sync', kind: 'worker' }]
            : []),
        ],
  owner: 'gabriel',
  repositoryPath: '/fixture/' + name,
  createdAt: at('07:00'),
}));
const workers = [
  {
    id: 'local',
    name: 'SER',
    capabilities: ['compatible', 'codex', 'claude'],
    modelOptions: [
      {
        id: 'compatible',
        models: [{ id: 'qwen3-8b', name: 'Qwen3-8B', efforts: [] }],
        efforts: [],
      },
      { id: 'claude', models: [{ id: 'opus', name: 'Opus', efforts: [] }], efforts: [] },
      {
        id: 'codex',
        models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: [] }],
        efforts: [],
      },
    ],
  },
  { id: 'mac', name: 'MacBook Pro', capabilities: ['codex', 'claude'] },
  { id: 'bazzite', name: 'bazzite', capabilities: ['codex'] },
].map((worker) => ({ ...worker, status: 'online', platform: 'darwin', architecture: 'arm64' }));
const tasks = [
  {
    id: 'pipeline',
    title: 'Self-release pipeline',
    workerId: 'mac',
    projectId: 'deploy.local',
    status: 'running',
  },
  {
    id: 'sync',
    title: 'Fix the sync worker',
    workerId: 'bazzite',
    projectId: 'home-gym',
    status: 'running',
  },
  {
    id: 'checks',
    title: 'Show checks on merged PRs',
    workerId: 'mac',
    projectId: 'deploy.local',
    status: 'ready',
  },
  {
    id: 'meal',
    title: 'Meal planner',
    workerId: 'mac',
    projectId: 'meal-planner',
    status: 'ready',
  },
  { id: 'scout', title: 'Scout', workerId: 'mac', status: 'ready' },
  { id: 'warden', title: 'Warden', workerId: 'local', status: 'ready' },
  { id: 'ask', title: 'Warden', workerId: 'local', status: 'ready' },
].map((task) => ({
  ...task,
  revision: 0,
  workspacePath: '/fixture/' + task.id,
  baseRevision: 'abc',
  createdAt: at('07:00'),
  updatedAt: at('14:30'),
}));
const rollback = {
  id: 'rollback:home-gym',
  kind: 'rollback',
  title: 'Roll back home-gym?',
  text: 'The sync worker fails 38% of jobs since 1:58 PM. Both apps go back and migration 0042 is undone.',
  from: 'warden',
  projectId: 'home-gym',
  taskId: 'warden',
  createdAt: at('14:14'),
  actions: [
    { id: 'rollback', label: 'Roll back', primary: true },
    { id: 'dismiss', label: 'Not now' },
  ],
  state: 'waiting',
};
let inbox = [
  rollback,
  {
    id: 'merge:18',
    kind: 'merge',
    title: 'Merge PR #18',
    text: 'Reviewed by GPT-6.1-Sol. 4 checks passed on this version.',
    from: 'scout',
    projectId: 'deploy.local',
    taskId: 'scout',
    createdAt: at('14:28'),
    actions: [
      { id: 'merge', label: 'Merge and release', primary: true },
      { id: 'dismiss', label: 'Not now' },
    ],
    state: 'waiting',
  },
  {
    id: 'question:keep',
    kind: 'question',
    title: 'Keep 3 or 5 releases?',
    text: 'Self-release pipeline',
    from: 'scout',
    taskId: 'pipeline',
    createdAt: at('14:20'),
    actions: [
      { id: 'option:0', label: '3 releases', primary: true },
      { id: 'option:1', label: '5 releases' },
    ],
    state: 'waiting',
  },
  {
    id: 'memory',
    kind: 'other',
    title: 'Raise Immich to 6 GB?',
    text: 'SER has 28 GB free. Immich restarts once, for about 30 seconds.',
    from: 'warden',
    taskId: 'ask',
    createdAt: at('14:20'),
    actions: [
      { id: 'raise', label: 'Raise to 6 GB', primary: true },
      { id: 'dismiss', label: 'Not now' },
    ],
    state: 'waiting',
  },
  ...['Roll back home-gym', 'Self-release pipeline', 'Merge PR #17', 'Restart Vaultwarden'].map(
    (title, index) => ({
      ...rollback,
      id: 'answered:' + index,
      kind: 'other',
      title,
      from: index === 0 || index === 3 ? 'warden' : 'scout',
      state: 'answered',
      answer: {
        actionId: 'rollback',
        by: 'Gabriel',
        on: ['desktop', 'web', 'iphone', 'cli'][index],
        at: at('13:15'),
      },
    }),
  ),
];
const apps = [
  {
    appId: 'home-gym-sync',
    name: 'home-gym sync',
    kind: 'worker',
    state: 'failing',
    summary: 'Worker · 38% of jobs error',
    project: 'home-gym',
    release: '9c3e1fa',
    jobs: { perMin: 12, failRate: 0.38, baselineFailRate: 0.01 },
    queue: { depth: 1240, oldestSec: 840 },
    restarts: { count: 3, windowSec: 600 },
    heartbeatAt: new Date(Date.now() - 4000).toISOString(),
  },
  { appId: 'immich', name: 'Immich', state: 'warning', summary: 'Memory 92% of 4 GB' },
  {
    appId: 'home-gym',
    name: 'home-gym',
    summary: 'Web app · 12 req/min',
    project: 'home-gym',
    release: '9c3e1fa',
  },
  {
    appId: 'deploy.local',
    name: 'deploy.local',
    summary: '184 req/min',
    project: 'deploy.local',
    release: '2a91c0e',
  },
  { appId: 'vaultwarden', name: 'Vaultwarden', summary: '1 req/min' },
  { appId: 'miniflux', name: 'Miniflux', summary: '2 req/min' },
  {
    appId: 'miniflux-fetcher',
    name: 'Miniflux fetcher',
    kind: 'worker',
    summary: 'Worker · queue empty',
  },
].map((app) => ({ kind: 'web', state: 'healthy', ...app }));
const live = {
  summary: { running: 7, failing: 1, warning: 1, checkedAt: at('14:32') },
  computers: [
    {
      id: 'local',
      name: 'SER',
      roles: ['coordinator', 'run-apps'],
      online: true,
      apps: apps.slice(0, 4),
      disk: 61,
    },
    { id: 'bazzite', name: 'bazzite', roles: ['run-apps'], online: true, apps: apps.slice(4) },
  ],
};
let events = [];
function conversation(taskId, event) {
  events.push({
    type: 'conversation',
    taskId,
    runId: null,
    at: event.at || at('14:30'),
    cursor: events.length + 1,
    event: { id: 'event:' + events.length, at: at('14:30'), ...event },
  });
}
conversation('sync', {
  kind: 'you',
  text: 'Make the home-gym sync worker read started_at, and add a test that runs it against the migrated schema',
  attachments: [],
});
conversation('sync', {
  kind: 'worklog',
  summary: 'Working on bazzite · Codex · 1m',
  live: true,
  steps: [
    { icon: 'file', text: 'Read src/sync/workouts.ts and migration 0042' },
    { icon: 'edit', text: 'Edited src/sync/workouts.ts', added: 6, removed: 6 },
    { icon: 'terminal', text: 'Running pnpm test src/sync' },
  ],
});
conversation('meal', {
  kind: 'worklog',
  summary: 'Worked for 18m · created meal-planner',
  live: false,
  steps: [
    { icon: 'edit', text: 'Wrote 14 files', added: 612 },
    { icon: 'terminal', text: 'Tests and build · 3 passed' },
  ],
});
conversation('meal', {
  kind: 'reply',
  agent: 'scout',
  paragraphs: [
    'The first version works: recipes, a week you can drag meals into, and a shopping list.',
  ],
});
conversation('ask', { kind: 'you', text: 'Why is Immich using so much memory?', attachments: [] });
conversation('ask', {
  kind: 'worklog',
  summary: 'Worked for 8s',
  live: false,
  steps: [
    { icon: 'pulse', text: 'Read Immich memory for the last 24 hours' },
    { icon: 'logs', text: 'Checked its jobs' },
  ],
});
conversation('ask', {
  kind: 'reply',
  agent: 'warden',
  paragraphs: [
    'A face-detection job started at 2:10 PM on 1,900 new photos. It holds about 3.5 GB until it finishes, in roughly 40 minutes.',
    'Memory goes back to about 1.2 GB afterwards. If you import this many again, 6 GB avoids the warning.',
  ],
});
conversation('ask', { kind: 'decision', inboxItemId: 'memory' });
conversation('warden', {
  kind: 'worklog',
  summary: 'Worked for 40s · 2:14 PM',
  live: false,
  steps: [
    { icon: 'pulse', text: 'home-gym sync: 38% of jobs failing' },
    { icon: 'logs', text: 'Read worker logs and the release diff' },
  ],
});
conversation('warden', {
  kind: 'reply',
  agent: 'warden',
  paragraphs: [
    'The release renamed workouts.started, but the sync worker still reads the old name. Scout is fixing it forward.',
  ],
});
conversation('warden', { kind: 'decision', inboxItemId: rollback.id });
conversation('scout', {
  kind: 'reply',
  agent: 'scout',
  paragraphs: ['Morning brief · Monday · 2 proposals, both done'],
  at: new Date(Date.now() - 86400000).toISOString(),
});
conversation('scout', {
  kind: 'worklog',
  summary: 'Worked for 1m',
  live: false,
  steps: [
    { icon: 'search', text: 'Reviewed 14 pull requests' },
    { icon: 'pulse', text: 'Checked SER with Warden' },
  ],
});
conversation('scout', {
  kind: 'reply',
  agent: 'scout',
  paragraphs: ['PR #17 shipped overnight. Two things need you.'],
});
conversation('scout', { kind: 'decision', inboxItemId: 'merge:18' });
const steps = (state = 'live') =>
  ['prepare', 'verify', 'activate', 'watch'].map((name, index) => ({
    name,
    state:
      state === 'failed'
        ? index === 0
          ? 'done'
          : index === 1
            ? 'failed'
            : 'skipped'
        : state === 'running'
          ? index === 0
            ? 'done'
            : index === 1
              ? 'running'
              : 'waiting'
          : 'done',
    ...(state === 'failed' && index === 1
      ? { detail: 'Web app returned 500 on the copy. REST_SOUNDS_URL is not set.' }
      : {}),
  }));
const releases = [
  {
    id: '9c3e1fa',
    projectId: 'home-gym',
    source: { kind: 'pr', ref: 'Rename workouts.started' },
    startedBy: 'Gabriel',
    apps: [
      { appId: 'home-gym', from: '81be0d2', to: '9c3e1fa' },
      { appId: 'home-gym-sync', from: '81be0d2', to: '9c3e1fa' },
    ],
    migrations: [{ id: '0042', title: 'Renamed workouts.started', reversible: true }],
    state: 'live',
    steps: steps(),
  },
  {
    id: '81be0d2',
    projectId: 'home-gym',
    source: { kind: 'pr', ref: 'Weekly summary email' },
    startedBy: 'Gabriel',
    apps: [
      { appId: 'home-gym', to: '81be0d2' },
      { appId: 'home-gym-sync', to: '81be0d2' },
    ],
    migrations: [],
    state: 'superseded',
    steps: steps(),
  },
  {
    id: '4c2a7d1',
    projectId: 'home-gym',
    source: { kind: 'pr', ref: 'Refresh Strava tokens' },
    startedBy: 'Gabriel',
    apps: [],
    migrations: [],
    state: 'superseded',
    steps: steps(),
  },
  {
    id: '7f3b2d4',
    projectId: 'deploy.local',
    source: { kind: 'pr', ref: 'PR #18' },
    startedBy: 'Gabriel',
    apps: [{ appId: 'deploy.local', from: '2a91c0e', to: '7f3b2d4' }],
    migrations: [],
    state: 'running',
    steps: steps('running'),
  },
  {
    id: '2a91c0e',
    projectId: 'deploy.local',
    source: { kind: 'pr', ref: 'PR #17' },
    startedBy: 'Gabriel',
    apps: [{ appId: 'deploy.local', to: '2a91c0e' }],
    migrations: [],
    state: 'superseded',
    steps: steps(),
  },
  {
    id: 'b81e4c0',
    projectId: 'home-gym',
    source: { kind: 'ship', ref: 'Add rest-timer sounds' },
    startedBy: 'Gabriel',
    apps: [{ appId: 'home-gym', to: 'b81e4c0' }],
    migrations: [],
    state: 'failed',
    steps: steps('failed'),
  },
];
const rollbacks = [];
const backups = ['13:57', '03:00'].map((time, index) => ({
  id: 'backup-' + index,
  name: 'home-gym',
  projectId: 'home-gym',
  apps: ['home-gym', 'home-gym-sync'],
  kind: index ? 'scheduled' : 'pre-release',
  createdAt: at(time),
  sizeBytes: 1200000000,
  contents: ['Postgres'],
  destination: '/fixture/backups',
  computer: 'SER',
  ...(index ? {} : { releaseId: '9c3e1fa' }),
  verified: true,
  testStatus: 'passed',
  testedAt: at('04:00'),
  restoreAvailable: true,
}));
backups.push(
  ...[
    {
      id: 'backup-immich',
      name: 'Immich',
      projectId: 'Immich',
      apps: ['immich'],
      contents: ['Photos and database'],
      sizeBytes: 212000000000,
    },
    {
      id: 'backup-vaultwarden',
      name: 'Vaultwarden',
      projectId: 'Vaultwarden',
      apps: ['vaultwarden'],
      contents: ['Database'],
      sizeBytes: 40000000,
    },
  ].map((point) => ({ ...backups[1], ...point })),
);
for (const backup of backups) backup.testedAt = new Date(Date.now() - 6 * 86400000).toISOString();
const restores = [];
function emit(type, value) {
  events.push({
    cursor: events.length + 1,
    taskId: value.projectId,
    at: new Date().toISOString(),
    type,
    [type]: structuredClone(value),
  });
}
function startRollback() {
  const value = {
    id: 'rollback-fixture',
    projectId: 'home-gym',
    from: '9c3e1fa',
    to: '81be0d2',
    reason: rollback.text,
    approvedBy: 'Gabriel',
    steps: steps('running'),
  };
  rollbacks.splice(0, rollbacks.length, value);
  emit('rollback', value);
  return value;
}
conversation('meal', { kind: 'you', text: 'Show me what it looks like.', attachments: [] });
conversation('meal', {
  kind: 'worklog',
  summary: 'Took 3 screenshots · Safari on MacBook Pro',
  live: false,
  steps: [],
});
for (let index = 0; index < 3; index++)
  conversation('meal', { kind: 'screenshot', screenshotId: 'meal-' + index });
let board = 'HomePhone';
let offline = false;
const operations = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  let body = '';
  for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  if (url.pathname === '/fixture/board') {
    board = input.board;
    offline = false;
    restores.splice(0);
    rollbacks.splice(0);
    rollback.state = board === 'RollbackPhone' ? 'answered' : 'waiting';
    if (board === 'RollbackPhone') {
      rollback.answer = { actionId: 'rollback', on: 'iphone', by: 'Gabriel', at: at('14:33') };
      startRollback();
    } else delete rollback.answer;
    return send({ board });
  }
  if (url.pathname === '/fixture/push')
    return send({
      Simulator_Target_Bundle: 'local.deploy.workspace.ios',
      aps: {
        alert: { title: rollback.title, body: rollback.text },
        sound: 'default',
        category: 'DEPLOY_DECISION',
      },
      inboxItemId: rollback.id,
      approveActionId: 'rollback',
      notNowActionId: 'dismiss',
      deviceScope: createHash('sha256')
        .update(origin + '|gabriel')
        .digest('hex'),
    });
  if (url.pathname === '/api/login') return send({ token: 'fixture-only' });
  if (req.headers['x-deploy-token'] !== 'fixture-only')
    return send({ error: 'Fixture credentials required' }, 401);
  if (offline) return send({ error: 'Fixture coordinator offline' }, 503);
  if (url.pathname === '/api/user') return send({ username: 'Gabriel', role: 'admin' });
  if (url.pathname === '/api/notifications')
    return send({
      decisions: true,
      failingApps: true,
      quietHours: true,
      timeZone: 'America/New_York',
    });
  if (url.pathname === '/api/devices')
    return send({
      devices: [{ id: 'iphone', name: "Gabriel's iPhone", createdAt: '2026-10-20T18:00:00Z' }],
    });
  if (/^\/api\/agents\/[^/]+\/control$/.test(url.pathname))
    return send({ paused: false, mutedUntil: null });
  if (url.pathname === '/api/nodes')
    return send({
      nodes: workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        kind: worker.id === 'local' ? 'coordinator' : 'worker',
        online: true,
        roles: worker.id === 'local' ? ['coordinator', 'run-apps'] : ['take-tasks'],
      })),
    });
  if (url.pathname === '/api/projects') {
    const first = ['ReleasesPhone', 'ReleaseFailedPhone'].includes(board)
      ? 'home-gym'
      : 'deploy.local';
    return send({
      projects: [...projects].sort((a, b) => Number(b.id === first) - Number(a.id === first)),
    });
  }
  const work = url.pathname.match(/^\/api\/projects\/([^/]+)\/(pulls|issues|repository)$/);
  if (work) {
    if (work[2] === 'repository')
      return send({
        status: 'ready',
        clonePath: 'deploy.local/' + work[1] + '.git',
        defaultBranch: 'main',
      });
    return send({
      items:
        work[1] === 'deploy.local'
          ? Array.from({ length: work[2] === 'pulls' ? 2 : 5 }, (_, i) => ({
              id: work[2] + i,
              number: 18 + i,
              title: work[2] === 'pulls' ? 'Self-release pipeline' : 'Show release progress',
              status: 'open',
              taskIds: ['pipeline'],
              createdAt: at('13:00'),
            }))
          : [],
    });
  }
  const projectRelease = url.pathname.match(
    /^\/api\/projects\/([^/]+)\/(releases|rollbacks|rollback)$/,
  );
  if (projectRelease) {
    const projectId = decodeURIComponent(projectRelease[1]);
    if (projectRelease[2] === 'rollback') return send({ rollback: startRollback() }, 202);
    if (projectRelease[2] === 'rollbacks')
      return send({ rollbacks: rollbacks.filter((r) => r.projectId === projectId) });
    if (req.method === 'POST') {
      const release = {
        id: 'shipped-fixture',
        projectId,
        source: input.source,
        startedBy: 'Gabriel',
        apps: [{ appId: projectId, to: input.ref }],
        migrations: [],
        state: 'running',
        steps: steps('running'),
      };
      releases.unshift(release);
      emit('release', release);
      return send({ release }, 202);
    }
    const visible = releases.filter(
      (r) => r.projectId === projectId && (r.id !== 'b81e4c0' || board === 'ReleaseFailedPhone'),
    );
    if (board === 'ReleaseFailedPhone')
      visible.sort((a, b) => Number(b.id === 'b81e4c0') - Number(a.id === 'b81e4c0'));
    return send({ releases: visible });
  }
  const releaseRoute = url.pathname.match(/^\/api\/releases\/([^/]+)$/);
  if (releaseRoute)
    return send({ release: releases.find((r) => r.id === decodeURIComponent(releaseRoute[1])) });
  if (url.pathname === '/api/backups') return send({ backups, restores, schedules: [] });
  const restoreRoute = url.pathname.match(
    /^\/api\/backups\/([^/]+)\/restore(?:\/([^/]+)\/(switch|cancel))?$/,
  );
  if (restoreRoute) {
    if (!restoreRoute[2]) {
      const restore = {
        id: 'copy-fixture',
        backupId: restoreRoute[1],
        projectId: 'home-gym',
        state: 'ready',
        createdAt: new Date().toISOString(),
        addresses: [{ app: 'home-gym', url: 'http://localhost:5186/copy' }],
      };
      restores.push(restore);
      return send({ restore }, 201);
    }
    const restore = restores.find((r) => r.id === restoreRoute[2]);
    if (!restore) return send({ error: 'Copy not found' }, 404);
    if (restoreRoute[3] === 'switch' && input.confirm !== true)
      return send({ error: 'Check the copy first' }, 400);
    restore.state = restoreRoute[3] === 'switch' ? 'live' : 'cancelled';
    if (restore.state === 'live') {
      restore.releaseId = '9c3e1fa';
      restore.retainedBackupId = 'retained-live';
    }
    return send({ restore });
  }
  if (url.pathname === '/api/state')
    return send({
      version: 1,
      cursor: events.length,
      projects,
      tasks,
      workers,
      runs: [],
      adapters: [],
    });
  if (url.pathname === '/api/inbox')
    return send({
      items: inbox.filter(
        (item) =>
          item.state === (url.searchParams.get('state') || 'waiting') &&
          (item.id !== 'memory' || board === 'AskPhone'),
      ),
    });
  if (url.pathname === '/api/live') return send(live);
  if (url.pathname.startsWith('/api/live/'))
    return send({
      app: apps.find((app) => app.appId === decodeURIComponent(url.pathname.split('/').at(-1))),
      history: [],
    });
  if (url.pathname === '/api/activity-events') {
    if (board === 'OfflinePhone') {
      offline = true;
      return send({ error: 'Offline fixture' }, 503);
    }
    const after = Number(url.searchParams.get('after') || 0);
    if (after >= events.length) await new Promise((resolve) => setTimeout(resolve, 1000));
    return send({
      events: events.filter((event) => event.cursor > after),
      cursor: events.length,
      supportsWait: true,
    });
  }
  const answer = url.pathname.match(/^\/api\/inbox\/([^/]+)\/answer$/);
  if (answer) {
    const item = inbox.find((item) => item.id === decodeURIComponent(answer[1]));
    if (!item) return send({ error: 'Missing decision' }, 404);
    if (item.state === 'answered')
      return send({ error: 'Already answered', item, answer: item.answer }, 409);
    if (item.kind === 'rollback' && input.actionId === 'rollback') startRollback();
    item.state = 'answered';
    item.answer = {
      actionId: input.actionId,
      on: input.on,
      by: 'Gabriel',
      at: new Date().toISOString(),
    };
    events.push({
      cursor: events.length + 1,
      taskId: item.taskId,
      type: 'inbox',
      at: item.answer.at,
      item,
    });
    return send({ item });
  }
  const task = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(diff|messages))?$/);
  if (task) {
    const record = tasks.find((taskRecord) => taskRecord.id === task[1]);
    if (!record) return send({ error: 'Missing task' }, 404);
    if (task[2] === 'diff')
      return send({
        baseRevision: 'abc',
        headRevision: 'def',
        status: 'ready',
        files: [
          'src/routes/week.tsx',
          'src/routes/shopping.tsx',
          'src/lib/merge-ingredients.ts',
          'src/routes/recipes.tsx',
          'src/db/schema.sql',
          'deploy.yaml',
        ].map((path) => ({ path, status: 'added' })),
        patch:
          '+ export function mergeIngredients(meals) {\n+   const list = new Map();\n+   for (const item of meals.flatMap((m) => m.ingredients)) {\n+     const key = item.name.toLowerCase();\n+     list.set(key, add(list.get(key), item));\n+   }\n+ }',
        checks: [{ name: 'Tests and build', status: 'passed' }],
      });
    if (task[2] === 'messages') {
      if (operations.has(input.operationId)) return send(operations.get(input.operationId));
      conversation(record.id, {
        kind: 'you',
        text: input.content,
        attachments: [],
        model: input.model,
      });
      const run = {
        id: 'run:' + input.operationId,
        taskId: record.id,
        adapter: input.adapter,
        model: input.model,
        status: 'queued',
        createdAt: at('14:32'),
        updatedAt: at('14:32'),
      };
      operations.set(input.operationId, run);
      return send(run);
    }
    return send({
      task: record,
      messages: [],
      runs:
        record.status === 'running'
          ? [
              {
                id: 'run:' + record.id,
                taskId: record.id,
                adapter: 'codex',
                status: 'running',
                createdAt: at('14:30'),
                updatedAt: at('14:30'),
              },
            ]
          : [],
      events: [],
      cursor: events.length,
    });
  }
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    if (operations.has(input.operationId)) return send(operations.get(input.operationId));
    const task = {
      ...tasks[0],
      id: 'new:' + input.operationId,
      title: input.title,
      projectId: input.projectId,
      workerId: input.workerId,
      revision: 0,
    };
    tasks.push(task);
    operations.set(input.operationId, task);
    return send(task);
  }
  if (url.pathname === '/api/devices')
    return send({ id: 'fixture-device', removed: req.method === 'DELETE' });
  return send({ error: 'Fixture endpoint unavailable' }, 404);
});
server.listen(port, '127.0.0.1', () => console.log(`iPhone fixture: ${origin}`));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
