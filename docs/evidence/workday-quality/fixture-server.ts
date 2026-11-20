// Real sidebar, Waiting on you and Welcome, fixture-only transport. No production server,
// database, Git, workers, credentials or deploy.local access: every response is seeded in memory.
//   DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5192 node --import tsx docs/evidence/workday-quality/fixture-server.ts
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../../..');
const json = (value: unknown, status = 200) => Response.json(value, { status });
const projects = [
  { id: 'deploy-local', name: 'deploy.local' },
  { id: 'forma', name: 'forma' },
  { id: 'catan', name: 'catan' },
  { id: 'drop', name: 'drop' },
  { id: 'tally', name: 'tally' },
  { id: 'immich', name: 'immich' },
  { id: 'recipes', name: 'recipes' },
];
const diagnostics = 'design:deploy-local:server-diagnostics:2a91c0e';

/** The Inbox board's cast, times relative to now. */
function seed(now = Date.now()) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const days = (count: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() - count);
    date.setHours(11, 0, 0, 0);
    return date.toISOString();
  };
  const base = { text: '', actions: [], state: 'waiting' };
  const design = (
    id: string,
    title: string,
    projectId: string,
    createdAt: string,
    screens: number,
    summary: string | null = null,
  ) => ({
    item: {
      ...base,
      id: `design:${projectId}:${id}:abc`,
      kind: 'other',
      title,
      text: `Changed ${screens} boards on design/${id}.`,
      from: 'gabriel',
      projectId,
      createdAt,
      actions: [
        { id: 'approve', label: 'Approve design', primary: true },
        { id: 'changes', label: 'Ask for changes' },
        { id: 'update', label: 'Ask to update' },
      ],
    },
    summary: {
      id: `design:${projectId}:${id}:abc`,
      title,
      summary,
      projectId,
      project: projects.find((project) => project.id === projectId)!.name,
      branch: `design/${id}`,
      proposer: { id: null, name: 'Gabriel', avatar: null },
      createdAt,
      counts: { screens, changed: screens, new: 0, removed: 0 },
      stale: id === 'server-diagnostics',
      conflicts: id === 'server-diagnostics' ? ['design/boards/Computer.html'] : [],
    },
  });
  const designs = [
    design('upload-history', 'Show upload history in Media sources', 'forma', ago(60), 2),
    {
      ...design(
        'server-diagnostics',
        'Diagnostics: debug deploy.local from inside it',
        'deploy-local',
        ago(180),
        13,
        'A Diagnostics page for the server, reached from its computer: an overview first, then Git, processes, API requests, traffic, logs and the profiler.',
      ),
    },
    design('clips', 'Clips: a feed of one-minute clips, in its own tab', 'forma', ago(300), 40),
    design(
      'start-screens',
      'Start screens: a scenario carousel, full width on phones',
      'catan',
      days(1),
      4,
    ),
    design('route-timing', 'One generic note for route timing', 'deploy-local', days(1), 4),
    design('baseline', 'Drop: a baseline of the pages shipped today', 'drop', days(2), 14),
  ];
  designs[1].item.id = diagnostics;
  designs[1].summary.id = diagnostics;
  // The two live cases: a title saved from the branch's cut name (the summary has the real one),
  // and a proposal from a task without an agent.
  designs[3].item.title = 'Start screens scenario carousel on phones full w';
  designs[3].summary.branch = 'design/start-screens-scenario-carousel-on-phones-full-w';
  Object.assign(designs[5].item, { taskId: 'task-drop' });
  designs[5].summary.proposer = { id: null, name: 'A task', avatar: null };
  const items = [
    {
      ...base,
      id: 'rollback:forma:r1',
      kind: 'rollback',
      title: 'Roll back forma?',
      text: 'The release to imac did not finish, so forma is locked until you choose. Roll back returns it to the last release that worked.',
      from: 'warden',
      fromName: 'Warden',
      projectId: 'forma',
      createdAt: ago(17),
      actions: [
        { id: 'rollback', label: 'Roll back', primary: true },
        { id: 'keep', label: 'Keep release' },
      ],
    },
    ...designs.map((entry) => entry.item),
    {
      ...base,
      id: 'agent-run:code-reviewer:smaller:today',
      kind: 'other',
      title: 'Keep pull requests smaller',
      from: 'code-reviewer',
      fromName: 'Code reviewer',
      createdAt: ago(120),
      actions: [{ id: 'run', label: 'Keep it', primary: true }],
    },
    {
      ...base,
      id: 'agent-run:researcher:reset:today',
      kind: 'other',
      title: 'Reset the count from your phone',
      from: 'researcher',
      fromName: 'Researcher',
      projectId: 'tally',
      createdAt: days(1),
    },
    {
      ...base,
      id: 'agent-run:code-reviewer:immich:today',
      kind: 'other',
      title: 'Update Immich 1.124 → 1.126',
      from: 'code-reviewer',
      fromName: 'Code reviewer',
      projectId: 'immich',
      createdAt: days(1),
    },
    {
      ...base,
      id: 'agent-run:ops-watcher:recipes:today',
      kind: 'other',
      title: 'Archive recipes',
      from: 'ops-watcher',
      fromName: 'Ops watcher',
      projectId: 'recipes',
      createdAt: days(2),
    },
    {
      ...base,
      id: 'question:publish',
      kind: 'question',
      title: 'Choose where to publish release notes',
      text: 'Choose where to publish release notes',
      from: 'release-notes-writer',
      fromName: 'Release notes writer',
      taskId: 'release-notes',
      createdAt: ago(40),
      actions: [
        { id: 'option:0', label: 'GitHub releases', primary: true },
        { id: 'answer', label: 'Answer' },
        { id: 'dismiss', label: 'Dismiss' },
      ],
    },
  ];
  return { items, summaries: designs.map((entry) => entry.summary) };
}

/** The Diagnostics proposal's 13 screens and 11 notes, in canvas order. */
const screenTitles = [
  'Computer',
  'Diagnostics',
  'Compute',
  'Diagnostics attention',
  'Git',
  'Logs',
  'Processes',
  'API requests',
  'Traffic',
  'Profiler',
  'Profiler recording',
  'Git operation',
  'Diagnostics empty',
];
const shots: Record<string, { before: string; after: string; area: number[] }> = {
  Computer: { before: 'Computer', after: 'Computer', area: [400, 280, 436, 120] },
  Diagnostics: { before: 'DiagnosticsEmpty', after: 'Diagnostics', area: [400, 60, 900, 260] },
};
function review(summary: ReturnType<typeof seed>['summaries'][number], item: unknown) {
  const boards = screenTitles.map((title, index) => ({
    file: `${title.replaceAll(' ', '')}.html`,
    title,
    w: 1440,
    h: 900,
    widths: [1440],
    page: null,
    pageId: null,
    index,
    count: null,
    notes: null,
    added: false,
    removed: false,
    status: 'changed',
    before: 'main',
    after: 'branch',
    changes: [],
    lines: [],
    seen: false,
    changedSinceReview: false,
    conflict: false,
  }));
  return {
    ...summary,
    item,
    task: null,
    before: 'main',
    after: 'branch',
    main: 'main',
    updatedWithMainAt: null,
    round: 1,
    previousItemId: null,
    boards,
    groups: [{ id: null, title: null, boards: boards.map((board) => board.file) }],
    notes: Array.from({ length: 11 }, (_, index) => ({
      id: `note-${index}`,
      title: [
        'Overview',
        'Git',
        'Processes',
        'API requests',
        'Traffic',
        'Logs',
        'Profiler',
        'Attention',
        'Empty',
        'Computer',
        'Recording',
      ][index],
      before: null,
      after: [],
      changed: 1,
      total: 1,
      page: null,
    })),
    pins: [],
  };
}
const pngSize = (file: string) => {
  const data = readFileSync(file);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'workday-quality-fixture-'));
  const data = seed();
  writeFileSync(join(root, 'seed.json'), JSON.stringify(data));
  function handle(request: Request): Response | Promise<Response> | null {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path.startsWith('/fixture-shots/')) {
      const name = path.slice('/fixture-shots/'.length).replace(/[^A-Za-z0-9-]/g, '');
      return new Response(readFileSync(join(repo, 'output/design', `${name}-1440.png`)), {
        headers: { 'content-type': 'image/png' },
      });
    }
    if (path === '/api/auth/session') return json({ username: 'Gabriel' });
    if (!['GET', 'HEAD'].includes(request.method))
      return json({ error: 'Capture fixture: mutation disabled' }, 405);
    if (path === '/api/inbox') {
      const state = url.searchParams.get('state');
      return json({
        items: data.items.filter((item) => !state || item.state === state),
        cursor: 1,
      });
    }
    if (path === '/api/design/reviews') return json({ proposals: data.summaries, approved: [] });
    const design = path.match(/^\/api\/projects\/([^/]+)\/design\/review(\/preview)?$/);
    if (design) {
      const id = url.searchParams.get('item');
      const summary = data.summaries.find((entry) => entry.id === id);
      const item = data.items.find((entry) => entry.id === id);
      if (!summary || !item) return json({ error: 'No such design review' }, 404);
      if (!design[2]) return json(review(summary, item));
      const board = url.searchParams.get('board')!.replace('.html', '');
      const shot = shots[board === 'Computer' ? 'Computer' : 'Diagnostics'];
      const size = pngSize(join(repo, 'output/design', `${shot.after}-1440.png`));
      const [x, y, w, h] = shot.area;
      // Diagnostics is new on Computer: main has nothing where it is, as on SER.
      const before = board === 'Computer' ? null : { x, y, w, h };
      return json({
        ...size,
        before: `/fixture-shots/${shot.before}`,
        after: `/fixture-shots/${shot.after}`,
        areas: [{ before, after: { x, y, w, h } }],
        crop: { x: x - 48, y: y - 48, w: w + 96, h: h + 96 },
      });
    }
    if (path === '/api/state')
      return json({ version: 1, cursor: 1, projects, tasks: [], runs: [], workers: [] });
    if (path === '/api/projects') return json({ projects });
    if (path === '/api/user') return json({ username: 'Gabriel', role: 'admin' });
    if (path === '/api/auth/account')
      return json({
        username: 'Gabriel',
        // The Welcome board is the first visit: nothing yet.
        welcomed: false,
        firstTaskSeen: true,
        passkeyOffered: true,
        hasPasskey: true,
      });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/computers/models')
      return json({
        defaults: { 'writing-code': 'opus' },
        choices: [{ id: 'opus', name: 'Opus', provider: 'claude', model: 'opus' }],
        providers: [],
      });
    if (path === '/api/nodes')
      return json({
        nodes: [
          { id: 'coordinator', name: 'SER', online: true },
          { id: 'mac', name: 'MacBook Pro', online: true },
          { id: 'bazzite', name: 'bazzite', online: true },
        ],
      });
    if (path === '/api/computers') return json({ computers: [] });
    if (path === '/api/live') return json({ summary: { running: 7, failing: 0 } });
    if (path === '/api/packages') return json({ served: true, usingCopies: false });
    if (path === '/api/activity-events')
      return url.searchParams.get('after') === 'latest'
        ? json({ events: [], cursor: 1, supportsWait: true })
        : new Promise((done) =>
            setTimeout(() => done(json({ events: [], cursor: 1, supportsWait: true })), 10000),
          );
    if (path.startsWith('/api/')) return json({ error: `Unseeded fixture route: ${path}` }, 404);
    return null;
  }
  return { root, handle, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function clientServer(root: string) {
  const { createServer: createVite } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const entry = join(root, 'client.tsx');
  writeFileSync(
    entry,
    `import {createRoot} from 'react-dom/client';
import {V2Layout} from '/app/routes/dashboard/v2-layout.client.tsx';
import Inbox from '/app/routes/dashboard/v2/inbox/page.client.tsx';
import Start from '/app/routes/dashboard/v2/start/home.client.tsx';
import {setContent} from '/docs/evidence/board-parity/fixture-router.tsx';
import '/app/design-tokens.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'Gabriel',token:'fixture-only'}));
setContent(location.pathname.startsWith('/dashboard/inbox') ? <Inbox/> : <Start/>);
createRoot(document.getElementById('root')!).render(<V2Layout/>);`,
  );
  const vite = await createVite({
    root: repo,
    configFile: false,
    cacheDir: join(root, 'vite'),
    plugins: [react()],
    optimizeDeps: { entries: [entry] },
    resolve: {
      alias: {
        '@': join(repo, 'app'),
        'react-flight-router/client': join(repo, 'docs/evidence/board-parity/fixture-router.tsx'),
        'react-dom/client': join(repo, 'node_modules/react-dom/client.js'),
        'react/jsx-dev-runtime': join(repo, 'node_modules/react/jsx-dev-runtime.js'),
        'react/jsx-runtime': join(repo, 'node_modules/react/jsx-runtime.js'),
        react: join(repo, 'node_modules/react'),
      },
    },
    server: { middlewareMode: true, hmr: false, ws: false, fs: { allow: [repo, root] } },
    appType: 'custom',
  });
  return { vite, entry };
}

async function serve() {
  if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
    throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
  const port = Number(process.env.PORT ?? 5192);
  if (!Number.isInteger(port) || port < 5180 || port > 5199)
    throw new Error('Use only ports 5180–5199');
  const fixture = createFixture();
  const { vite, entry } = await clientServer(fixture.root);
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      const response = await fixture.handle(new Request(url, { method: req.method }));
      if (response) {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } else if (url.pathname.startsWith('/dashboard')) {
        res.setHeader('content-type', 'text/html');
        res.end(
          await vite.transformIndexHtml(
            url.pathname,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
          ),
        );
      } else
        vite.middlewares(req, res, () => {
          res.writeHead(404);
          res.end('Not a fixture route');
        });
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await vite.close();
    fixture.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void close());
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Workday fixture: http://127.0.0.1:${port}/dashboard/inbox · /dashboard (Welcome)\nDisposable data: ${fixture.root}`,
    ),
  );
}

await serve();
