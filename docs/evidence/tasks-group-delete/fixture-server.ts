// Real sidebar and task page, fixture-only transport. No production server, database, Git,
// workers, credentials or deploy.local access: every response below is seeded in memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The five boards' states. Each reset reseeds the data and opens the task page. */
export const states = {
  'by-project': { group: 'project', open: '' },
  'group-menu': { group: 'date', open: 'group' },
  'row-menu': { group: 'project', open: 'row' },
  'task-menu': { group: 'project', open: 'task' },
  delete: { group: 'project', open: 'delete' },
  // Not a board state: the start page a project heading's + opens.
  'new-task-in': { group: 'project', open: '' },
} as const;
type State = keyof typeof states;
const repo = resolve(import.meta.dirname, '../../..');
const json = (value: unknown, status = 200) => Response.json(value, { status });
const projects = [
  { id: 'deploy-local', name: 'deploy.local' },
  { id: 'home-gym', name: 'home-gym' },
  { id: 'tally', name: 'tally' },
];
const cache = 'cache-discover';

/** The TasksByProject board's cast, times relative to now. */
function seed(now = Date.now()) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(15, 0, 0, 0);
  const days = (count: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() - count);
    date.setHours(11, 0, 0, 0);
    return date.toISOString();
  };
  const task = (
    id: string,
    title: string,
    projectId: string | null,
    updatedAt: string,
    status = 'idle',
  ) => ({ id, title, projectId, status, revision: 3, createdAt: updatedAt, updatedAt });
  // Idle tasks carry a status no sidebar state maps to.
  const tasks = [
    task('self-release', 'Self-release pipeline', 'deploy-local', ago(2), 'running'),
    task(cache, 'Cache Discover images on SER', 'deploy-local', ago(22), 'failed'),
    task('merged-checks', 'Show checks on merged PRs', 'deploy-local', ago(40)),
    task('release-health', 'Check SER release health', 'deploy-local', ago(60)),
    task(
      'update-main',
      'Update from main after conflicts',
      'deploy-local',
      yesterday.toISOString(),
    ),
    task('ssh-zeros', 'Keep leading zeros in SSH keys', 'deploy-local', days(2)),
    task('queue-runs', 'Queue runs per computer', 'deploy-local', days(4)),
    task('sync-migration', 'Fix the sync migration', 'home-gym', ago(3), 'running'),
    task('review-gym', 'Review home-gym changes', 'home-gym', ago(52)),
    task('rename-started', 'Rename workouts.started safely', 'home-gym', ago(120)),
    task('tally-header', 'Calmer Tally header', 'tally', days(3)),
    task('bazzite', 'Fix bazzite startup', null, ago(61)),
  ];
  // Only the running and failed tasks show a state in the board's list; the rest are idle.
  const runs = tasks
    .filter((entry) => ['running', 'failed'].includes(entry.status))
    .map((entry) => ({
      id: `run-${entry.id}`,
      taskId: entry.id,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
  return { tasks, runs, at: ago(22), started: ago(44) };
}

/** Importable without opening a socket. Writes only to its disposable directory. */
export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tasks-group-delete-fixture-'));
  let data = seed();
  let deleted = new Set<string>();
  let started: { text: string; projectId: string | null }[] = [];
  const live = () => data.tasks.filter((task) => !deleted.has(task.id));
  const save = () =>
    writeFileSync(
      join(root, 'seed.json'),
      JSON.stringify({ ...data, deleted: [...deleted], started }),
    );
  save();
  const view = (task: (typeof data.tasks)[number]) => ({
    task: {
      ...task,
      branch: task.id === cache ? 'scout/discover-cache' : undefined,
      startedBy: 'you',
      startedModel: 'Opus',
    },
    project: projects.find((project) => project.id === task.projectId),
    computer: 'MacBook Pro',
    computerId: 'mac',
    run: {
      adapter: 'claude',
      model: 'opus',
      modelName: 'Opus',
      status: data.runs.find((run) => run.taskId === task.id)?.status ?? 'succeeded',
      updatedAt: task.updatedAt,
    },
    comparison: { ahead: 2, behind: 0 },
    firstTask: false,
    cursor: 1,
    events:
      task.id === cache
        ? [
            {
              kind: 'you',
              id: 'you',
              at: data.started,
              text: "Cache Discover images on SER so installs don't pull from the internet every time.",
              attachments: [],
            },
            {
              kind: 'worklog',
              id: 'work',
              at: data.at,
              summary: 'Worked for 22m',
              live: false,
              steps: [
                { icon: 'file', text: 'Read server/catalog/preflight.ts and service.ts' },
                { icon: 'edit', text: 'Added a local image cache' },
                { icon: 'terminal', text: 'Ran pnpm test server/catalog' },
                { icon: 'pulse', text: 'Tried a content-addressed cache instead' },
                { icon: 'terminal', text: 'Ran pnpm test server/catalog' },
              ],
            },
            {
              kind: 'reply',
              id: 'reply',
              at: data.at,
              agent: 'scout',
              paragraphs: [
                "I couldn't get this working. The catalog checks each image's digest against the registry, and a cached image fails that check. I stopped after two approaches instead of loosening the check.",
                'My changes are saved on `scout/discover-cache`. There is no pull request.',
              ],
            },
          ]
        : [],
    pulls: [],
    checks: [],
    screenshots: [],
    releases: [],
  });
  function handle(request: Request): Response | null | Promise<Response | null> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path === '/__fixture' && request.method === 'GET') {
      const state = (url.searchParams.get('state') ?? 'by-project') as State;
      if (!(state in states)) return json({ error: 'Unknown fixture state', states }, 400);
      data = seed();
      deleted = new Set();
      started = [];
      save();
      const { group, open } = states[state];
      return new Response(null, {
        status: 302,
        headers: {
          location:
            state === 'new-task-in'
              ? `/dashboard?project=home-gym&fixture-group=${group}`
              : `/dashboard/tasks/${cache}?fixture-group=${group}${open ? `&fixture-open=${open}` : ''}`,
        },
      });
    }
    const taskPath = path.match(/^\/api\/(v2|workspace)\/tasks\/([^/]+)(?:\/(.+))?$/);
    if (taskPath) {
      const [, kind, id, rest] = taskPath;
      const task = live().find((entry) => entry.id === id);
      if (!task) return json({ error: 'Not found' }, 404);
      if (kind === 'v2' && !rest) return json(view(task));
      if (kind === 'workspace' && rest === 'diff')
        return json({ patch: '', files: [], checks: [], status: 'ready' });
      if (kind === 'workspace' && rest === 'deletion')
        return json({
          id: task.id,
          title: task.title,
          revision: task.revision,
          branch: task.id === cache ? 'scout/discover-cache' : null,
          unmergedCommits: task.id === cache ? 2 : 0,
          running: task.status === 'running',
        });
      if (kind === 'workspace' && rest === 'delete' && request.method === 'POST')
        return (async () => {
          const body = await request.json().catch(() => ({}));
          if (task.status === 'running')
            return json({ error: 'Stop the task before deleting it' }, 409);
          if (body.revision !== task.revision)
            return json({ error: 'Task changed; refresh before retrying' }, 409);
          deleted.add(task.id);
          save();
          return json({ id: task.id, deleted: true });
        })();
    }
    // A started task records the project the start page sent; it is not created.
    if (path === '/api/composer/messages' && request.method === 'POST')
      return (async () => {
        const body = await request.json().catch(() => ({}));
        started.push({ text: body.text, projectId: body.projectId ?? null });
        save();
        return json({ taskId: cache, runId: `run-${cache}` });
      })();
    // The page adopts its stored sign-in as a cookie session; nothing is checked here.
    if (path === '/api/auth/session') return json({ username: 'Gabriel' });
    if (!['GET', 'HEAD'].includes(request.method))
      return json({ error: 'Capture fixture: mutation disabled' }, 405);
    if (path === '/api/state')
      return json({
        version: 1,
        cursor: 1,
        projects,
        tasks: live(),
        runs: data.runs.filter((run) => !deleted.has(run.taskId)),
        workers: [],
        adapters: [],
      });
    if (path === '/api/projects') return json({ projects });
    if (/^\/api\/v2\/projects\/[^/]+\/releases$/.test(path)) return json({ releases: [] });
    if (/^\/api\/v2\/projects\/[^/]+\/design\/changes$/.test(path))
      return json({ base: 'main', commit: 'main', files: [] });
    if (/^\/api\/v2\/projects\/[^/]+\/design\/proposals$/.test(path))
      return json({ proposals: [] });
    if (/^\/api\/v2\/projects\/[^/]+\/design$/.test(path)) return json({ canvas: null });
    if (path === '/api/inbox') return json({ items: [], cursor: 1 });
    if (path === '/api/user') return json({ username: 'Gabriel', role: 'admin' });
    if (path === '/api/auth/account')
      return json({
        username: 'Gabriel',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/computers/models')
      return json({
        defaults: { 'writing-code': 'opus', reviewing: 'opus', 'answering-questions': 'opus' },
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
    if (path === '/api/live') return json({ summary: { running: 2, failing: 1 } });
    if (path === '/api/packages') return json({ served: true, usingCopies: false });
    if (path === '/api/events')
      return url.searchParams.get('after') === 'latest'
        ? json({ events: [], cursor: 1, supportsWait: true })
        : new Promise((done) => {
            const finish = () => done(json({ events: [], cursor: 1, supportsWait: true }));
            const timer = setTimeout(finish, 10000);
            request.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              finish();
            });
          });
    if (path.startsWith('/api/')) return json({ error: `Unseeded fixture route: ${path}` }, 404);
    return null;
  }
  return { root, handle, close: () => rmSync(root, { recursive: true, force: true }) };
}

async function clientServer(root: string) {
  const { createServer: createVite } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  // The entry mounts product components only. The `fixture-*` parameters choose the grouping
  // and click the same controls a person would, so capture.mjs can photograph an open menu.
  const entry = join(root, 'client.tsx');
  writeFileSync(
    entry,
    `import {createRoot} from 'react-dom/client';
import {V2Layout} from '/app/routes/dashboard/v2-layout.client.tsx';
import TaskPage from '/app/routes/dashboard/v2/tasks/page.client.tsx';
import Home from '/app/routes/dashboard/v2-home.client.tsx';
import {setContent} from '/docs/evidence/tasks-group-delete/fixture-router.tsx';
import '/app/design-tokens.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'Gabriel',token:'fixture-only'}));
if (params.get('fixture-group')) localStorage.setItem('deploy.sidebar.tasks', params.get('fixture-group'));
setContent(location.pathname.startsWith('/dashboard/tasks/') ? <TaskPage/> : <Home/>);
createRoot(document.getElementById('root')!).render(<V2Layout/>);
const until = (find) => new Promise((done) => { const tick = () => { const el = find(); el ? done(el) : setTimeout(tick, 100); }; tick(); });
const sidebar = () => document.querySelector('.dl-app > .dl-side');
const open = params.get('fixture-open');
(async () => {
  if (open === 'group') (await until(() => sidebar()?.querySelector('[aria-label="Group tasks"]'))).click();
  if (open === 'row') {
    const row = await until(() => [...(sidebar()?.querySelectorAll('.side-task') ?? [])].find((el) => el.textContent.includes('Cache Discover images on SER')));
    row.querySelector('[aria-label="Task actions"]').click();
  }
  if (open === 'task' || open === 'delete') {
    (await until(() => document.querySelector('[aria-label="More task actions"]'))).click();
    if (open === 'delete') (await until(() => [...document.querySelectorAll('#task-actions button')].find((el) => el.textContent === 'Delete task…'))).click();
  }
})();`,
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
        'react-flight-router/client': join(
          repo,
          'docs/evidence/tasks-group-delete/fixture-router.tsx',
        ),
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
  const port = Number(process.env.PORT ?? 5191);
  if (!Number.isInteger(port) || port < 5180 || port > 5199)
    throw new Error('Use only ports 5180–5199');
  const fixture = createFixture();
  process.env.DEPLOY_DATA_DIR = fixture.root;
  const { vite, entry } = await clientServer(fixture.root);
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'",
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(url, {
        method: req.method,
        signal: abort.signal,
        ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}),
      });
      const response = await fixture.handle(request);
      if (abort.signal.aborted) return;
      if (response) {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      } else if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/tasks/')) {
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
      `Tasks fixture: http://127.0.0.1:${port}/__fixture?state=by-project\nDisposable data: ${fixture.root}`,
    ),
  );
}

async function check() {
  const fixture = createFixture();
  const call = async (path: string, init?: RequestInit) =>
    (await fixture.handle(new Request(`http://127.0.0.1:5191${path}`, init)))!;
  try {
    for (const state of Object.keys(states)) {
      const reset = await call(`/__fixture?state=${state}`);
      assert.equal(reset.status, 302);
      assert.match(
        reset.headers.get('location')!,
        state === 'new-task-in'
          ? /^\/dashboard\?project=home-gym&/
          : new RegExp(`^/dashboard/tasks/${cache}\\?`),
      );
    }
    const state = await (await call('/api/state')).json();
    assert.equal(state.tasks.filter((task: any) => task.projectId === 'deploy-local').length, 7);
    assert.equal(state.tasks.filter((task: any) => !task.projectId).length, 1);
    const deletion = await (await call(`/api/tasks/${cache}/deletion`)).json();
    assert.deepEqual(
      [deletion.branch, deletion.unmergedCommits, deletion.running],
      ['scout/discover-cache', 2, false],
    );
    const running = await call('/api/tasks/self-release/delete', {
      method: 'POST',
      body: JSON.stringify({ revision: 3 }),
    });
    assert.equal(running.status, 409);
    const removed = await call(`/api/tasks/${cache}/delete`, {
      method: 'POST',
      body: JSON.stringify({ revision: 3 }),
    });
    assert.equal(removed.status, 200);
    assert.equal((await call(`/api/tasks/${cache}`)).status, 404);
    assert.equal(
      (await (await call('/api/state')).json()).tasks.some((task: any) => task.id === cache),
      false,
    );
    const sent = await call('/api/composer/messages', {
      method: 'POST',
      body: JSON.stringify({ text: 'Add a calmer header', projectId: 'home-gym' }),
    });
    assert.equal(sent.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(join(fixture.root, 'seed.json'), 'utf8')).started, [
      { text: 'Add a calmer header', projectId: 'home-gym' },
    ]);
    assert.equal((await call('/api/not-seeded')).status, 404);
    assert.equal((await call('/api/inbox/x/answer', { method: 'POST' })).status, 405);
    console.log(
      'PASS: five board states and New task in, seeded cast, deletion preview, delete and its guards, chosen project sent.',
    );
  } finally {
    fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) await check();
  else await serve();
}
