// Isolated native capture fixture. No production server, data directory, browser or worker.
import { createServer, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

export const boards = [
  'HomeLoadingPhone',
  'ProjectsLoadingPhone',
  'TaskLoadingPhone',
  'LiveLoadingPhone',
  'HomeLoadingSlowPhone',
  'HomeRefreshingPhone',
  'HomeUnavailablePhone',
  'PackagesPhone',
  'PackageVersionsPhone',
] as const;
type Behavior = 'hang' | 'fail' | 'success';
const at = () => new Date().toISOString();
const agent = {
  id: 'release-notes-writer',
  name: 'Release notes writer',
  job: '',
  looksAfter: [],
  computers: [],
  lastMessage: { text: 'Drafted this week’s release notes.', at: at() },
};
const project = { id: 'home-gym', name: 'home-gym', summary: 'Your workout tracker', apps: [] };
const task = {
  id: 'sync',
  title: 'Fix the sync worker',
  projectId: 'home-gym',
  workerId: 'coordinator',
  status: 'ready',
  revision: 0,
  workspacePath: '/fixture/sync',
  baseRevision: 'fixture',
  createdAt: at(),
  updatedAt: at(),
};
const decision = {
  id: 'fixture-question',
  kind: 'question',
  title: 'Roll back home-gym?',
  text: 'sync worker failing',
  from: 'release-notes-writer',
  fromName: 'Ops watcher',
  taskId: 'sync',
  projectId: 'home-gym',
  createdAt: at(),
  state: 'waiting',
  actions: [{ id: 'approve', label: 'Approve', primary: true }],
};
const live = {
  summary: { running: 1, failing: 0, warning: 0, checkedAt: at() },
  computers: [
    {
      id: 'coordinator',
      name: 'SER',
      online: true,
      roles: ['coordinator'],
      apps: [
        {
          appId: 'home-gym',
          name: 'home-gym',
          kind: 'web',
          state: 'healthy',
          summary: 'Running',
          project: 'home-gym',
        },
      ],
    },
  ],
};
const packages = [
  {
    id: 'npm:@home/shared',
    name: '@home/shared',
    ecosystem: 'npm',
    project: 'home-gym',
    latest: { version: '1.2.0' },
  },
];
export function payload(path: string, query = new URLSearchParams()): unknown {
  if (path === '/api/user') return { username: 'gabriel', role: 'admin' };
  if (path === '/api/state') return { cursor: 1, projects: [project], tasks: [task], workers: [] };
  if (path === '/api/projects') return { projects: [project] };
  if (path === '/api/agents') return { agents: [agent] };
  if (path === '/api/nodes')
    return { nodes: [{ id: 'coordinator', name: 'SER', kind: 'coordinator', online: true }] };
  if (path === '/api/inbox')
    return { items: query.get('state') === 'answered' ? [] : [decision], cursor: 1 };
  if (path === '/api/live') return live;
  if (path.startsWith('/api/live/')) return { app: live.computers[0].apps[0], history: [] };
  if (path === '/api/tasks/sync') return { task, messages: [], runs: [], events: [], cursor: 1 };
  if (path === '/api/tasks/sync/diff')
    return {
      baseRevision: 'fixture',
      headRevision: 'fixture',
      patch: '',
      status: '',
      files: [],
      checks: [],
    };
  if (path === '/api/packages') return { packages };
  if (path === '/api/packages/cache')
    return {
      sources: [{ name: 'npmjs.org', reachable: true, checkedAt: at() }],
      projects: [{ missing: 0, checkedAt: at(), removed: [] }],
      storage: { bytes: 1073741824, limit: 10737418240 },
    };
  if (path.startsWith('/api/packages/'))
    return {
      versions: [
        {
          version: '1.2.0',
          publishedVia: 'cli',
          publishedBy: 'gabriel',
          publishedByYou: true,
          createdAt: at(),
        },
      ],
    };
  if (path === '/api/approvals') return { rules: [] };
  return null;
}
export function cachedSnapshot() {
  const seconds = Date.now() / 1000 - 978307200 - 120;
  return {
    inbox: [decision],
    inboxPosition: { waiting: 1, answered: 1, items: { [decision.id]: 1 } },
    live,
    workspace: payload('/api/state'),
    projects: [project],
    agents: [agent],
    computers: [{ id: 'coordinator', name: 'SER', online: true }],
    events: [],
    cursor: 1,
    updatedAt: seconds,
    loadedResources: [
      'workspace',
      'waiting',
      'answered',
      'live',
      'agents',
      'projects',
      'computers',
    ],
    resourceDates: { workspace: seconds, waiting: seconds, agents: seconds },
    drafts: [],
    composer: {
      id: 'fixture-draft',
      createOperationId: 'fixture-operation',
      text: '',
      workerId: 'local',
      adapter: 'codex',
      agent: '',
      question: false,
      rejected: false,
    },
    composers: {},
    agentTasks: {},
  };
}
export function createLoadingFixture(initialBoard = 'HomeLoadingPhone') {
  let board = initialBoard;
  let behavior: Behavior | undefined;
  let privateBehavior: Behavior = 'hang';
  let copiesBehavior: Behavior = 'hang';
  const pending = new Set<{ res: ServerResponse; path: string; query: URLSearchParams }>();
  const counts: Record<string, number> = {};
  function policy(path: string): Behavior {
    if (board === 'PackagesPhone' || board === 'PackageVersionsPhone') {
      if (path === '/api/packages/cache') return copiesBehavior;
      if (path === '/api/packages')
        return board === 'PackageVersionsPhone' ? 'success' : privateBehavior;
      if (path.startsWith('/api/packages/')) return behavior ?? 'hang';
      return 'success';
    }
    if (board === 'TaskLoadingPhone')
      return path.startsWith('/api/tasks/') ? (behavior ?? 'hang') : 'success';
    if (board === 'ProjectsLoadingPhone')
      return path === '/api/projects' ? (behavior ?? 'hang') : 'success';
    if (board === 'LiveLoadingPhone')
      return path === '/api/live' ? (behavior ?? 'hang') : 'success';
    return behavior ?? (board === 'HomeUnavailablePhone' ? 'fail' : 'hang');
  }
  function send(res: ServerResponse, value: unknown, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function settle(entry: { res: ServerResponse; path: string; query: URLSearchParams }) {
    const mode = policy(entry.path);
    if (mode === 'hang') return;
    pending.delete(entry);
    if (mode === 'fail') send(entry.res, { error: 'Fixture connection failure' }, 503);
    else {
      const value = payload(entry.path, entry.query);
      send(entry.res, value ?? { error: 'Fixture route missing' }, value === null ? 404 : 200);
    }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1:5194');
    const path = decodeURIComponent(url.pathname);
    if (path === '/fixture/cache') return send(res, cachedSnapshot());
    if (path === '/fixture/state') {
      if (url.searchParams.has('board')) board = url.searchParams.get('board')!;
      for (const name of ['behavior', 'private', 'copies']) {
        const value = url.searchParams.get(name);
        if (value && !['hang', 'fail', 'success'].includes(value))
          return send(res, { error: 'Invalid behavior' }, 400);
      }
      if (url.searchParams.has('behavior')) behavior = url.searchParams.get('behavior') as Behavior;
      if (url.searchParams.has('private'))
        privateBehavior = url.searchParams.get('private') as Behavior;
      if (url.searchParams.has('copies'))
        copiesBehavior = url.searchParams.get('copies') as Behavior;
      for (const entry of [...pending]) settle(entry);
      return send(res, {
        board,
        behavior,
        private: privateBehavior,
        copies: copiesBehavior,
        pending: pending.size,
        counts,
      });
    }
    if (path === '/fixture') return send(res, { board, boards, pending: pending.size, counts });
    counts[path] = (counts[path] ?? 0) + 1;
    if (path === '/api/activity-events') {
      const timer = setTimeout(
        () => send(res, { events: [], cursor: 1, supportsWait: true }),
        10_000,
      );
      res.on('close', () => clearTimeout(timer));
      return;
    }
    const entry = { res, path, query: url.searchParams };
    pending.add(entry);
    res.on('close', () => pending.delete(entry));
    settle(entry);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
  if (process.argv.includes('--dump')) {
    console.log(
      JSON.stringify({
        cache: cachedSnapshot(),
        task: payload('/api/tasks/sync'),
        diff: payload('/api/tasks/sync/diff'),
        live: payload('/api/live'),
        packages: payload('/api/packages'),
        copies: payload('/api/packages/cache'),
        versions: payload('/api/packages/npm/@home/shared'),
      }),
    );
    process.exit(0);
  }
  const index = process.argv.indexOf('--board');
  const board = index < 0 ? 'HomeLoadingPhone' : process.argv[index + 1];
  if (!(boards as readonly string[]).includes(board))
    throw new Error('Pass --board and a listed loading board');
  const server = createLoadingFixture(board);
  server.listen(5194, '127.0.0.1', () =>
    console.log(`Loading fixture: ${board} at http://127.0.0.1:5194`),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
}
