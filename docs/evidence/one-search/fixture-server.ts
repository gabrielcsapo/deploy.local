// The real search box over the real sidebar, fixture-only transport. No production server,
// database, Git, workers, credentials or deploy.local access: every response is seeded in memory.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixture as createTasksFixture } from '../tasks-group-delete/fixture-server.ts';

const repo = resolve(import.meta.dirname, '../../..');
const json = (value: unknown, status = 200) => Response.json(value, { status });

/** Each board and the page, words and narrowing that reproduce it. */
export const states = {
  names: { board: 'CommandPalette', page: '/dashboard', q: 'home' },
  text: { board: 'SearchText', page: '/dashboard', q: 'workouts.started' },
  searching: { board: 'SearchSearching', page: '/dashboard', q: 'workouts.started', slow: true },
  code: { board: 'SearchCode', page: '/dashboard', q: 'workouts.started', kind: 'code' },
  none: { board: 'SearchNone', page: '/dashboard', q: 'wokrouts.started' },
  project: {
    board: 'SearchProject',
    page: '/dashboard/projects/deploy-local/code?ref=main',
    q: 'clone',
    scoped: true,
  },
  file: {
    board: 'CodeFileMatch',
    page: '/dashboard/projects/deploy-local/code?ref=main&file=server%2Frepositories%2Fclone.ts&line=7&find=clone',
  },
  'code-tab': { board: 'Code', page: '/dashboard/projects/deploy-local/code?ref=main' },
} as const;
type State = keyof typeof states;

const agents = [
  [
    'release-notes-writer',
    'Release notes writer',
    'variant28',
    'af61f2',
    "I'll draft a first pass.",
  ],
  ['ops-watcher', 'Ops watcher', 'variant21', '2fb5a3', 'All apps healthy overnight.'],
  ['code-reviewer', 'Code reviewer', 'variant29', '76a7ff', 'Left 3 comments on #48.'],
  ['researcher', 'Researcher', 'variant10', 'ffaa64', "Here's what I found on passkeys."],
  ['designer', 'Designer', 'variant03', 'e66bb8', 'Proposed a calmer Tally header.'],
].map(([id, name, glyph, color, text]) => ({
  id,
  name,
  avatar: { glyph, color: `#${color}` },
  lastMessage: { text, at: new Date().toISOString() },
}));

/** The source the CodeFile board shows, read from the board so the two cannot drift. */
function boardSource() {
  const board = readFileSync(join(repo, 'design/boards/CodeFile.html'), 'utf8');
  return [...board.matchAll(/<div data-layer="code-line[^"]*" class="code-line">(.*?)<\/div>/g)]
    .map(([, line]) =>
      line
        .replace(/<span data-layer="[^"]*" class="n">\d+<\/span>/, '')
        .replace(/<[^>]+>/g, '')
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&#39;', "'")
        .replaceAll('&quot;', '"')
        .replaceAll('&amp;', '&')
        .replace(/^ $/, ''),
    )
    .join('\n');
}

export function createFixture() {
  const tasks = createTasksFixture();
  const source = boardSource();
  let state: State = 'text';
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const code = (q: string, project: string | null, limit: number) => {
    const line = (projectId: string, name: string, path: string, n: number, text: string) => ({
      projectId,
      project: name,
      ref: 'main',
      path,
      line: n,
      text,
    });
    if (project === 'deploy-local' && q === 'clone')
      return {
        query: q,
        lines: 23,
        files: 9,
        projects: 1,
        truncated: false,
        ref: 'main',
        items: [
          line(
            'deploy-local',
            'deploy.local',
            'server/repositories/clone.ts',
            7,
            'export async function cloneRepository(project: string, into: string, signal: AbortSignal) {',
          ),
          line(
            'deploy-local',
            'deploy.local',
            'server/workspace/task-workspace.ts',
            52,
            'await cloneRepository(project, dir, signal);',
          ),
          line(
            'deploy-local',
            'deploy.local',
            'README.md',
            31,
            'git clone https://deploy.local/git/home-gym.git',
          ),
        ].slice(0, limit),
      };
    if (q !== 'workouts.started')
      return { query: q, lines: 0, files: 0, projects: 0, truncated: false, items: [] };
    const all = [
      line('home-gym', 'home-gym', 'worker/sync.ts', 88, '.where(gte(workouts.started, since))'),
      line('home-gym', 'home-gym', 'worker/sync.ts', 131, 'const last = max(workouts.started);'),
      line(
        'home-gym',
        'home-gym',
        'worker/sync.ts',
        140,
        "log.info('synced', { from: workouts.started });",
      ),
      line(
        'home-gym',
        'home-gym',
        'worker/sync.ts',
        162,
        '// workouts.started is UTC; the phone sends local time',
      ),
      line(
        'home-gym',
        'home-gym',
        'app/routes/history.tsx',
        41,
        '.orderBy(desc(workouts.started))',
      ),
      line(
        'home-gym',
        'home-gym',
        'app/routes/history.tsx',
        77,
        'const day = startOfDay(workouts.started);',
      ),
      line('home-gym', 'home-gym', 'app/routes/history.tsx', 93, 'key={String(workouts.started)}'),
      line(
        'home-gym',
        'home-gym',
        'app/routes/workout.tsx',
        18,
        'select({ id: workouts.id, started: workouts.started })',
      ),
      line(
        'home-gym',
        'home-gym',
        'app/routes/workout.tsx',
        56,
        '<time dateTime={iso(workouts.started)}>',
      ),
      line(
        'home-gym',
        'home-gym',
        'worker/sync.test.ts',
        24,
        'expect(row.started).toEqual(workouts.started);',
      ),
      line(
        'home-gym',
        'home-gym',
        'worker/sync.test.ts',
        61,
        "it('keeps workouts.started when a job retries', async () => {",
      ),
      line(
        'home-gym',
        'home-gym',
        'db/migrations/0042_started_at.sql',
        1,
        '-- workouts.started becomes workouts.started_at',
      ),
    ];
    // The text board shows one line from each of three files.
    const few = [all[0], all[4], all[11]];
    return {
      query: q,
      lines: 12,
      files: 5,
      projects: 1,
      truncated: false,
      items: limit > 3 ? all : few,
    };
  };
  const names = (q: string, project: string | null) => {
    const none = { query: q, names: [], messages: { total: 0, items: [] } };
    if (project === 'deploy-local' && q === 'clone')
      return {
        ...none,
        files: {
          total: 2,
          ref: 'main',
          items: [
            {
              path: 'server/repositories/clone.ts',
              name: 'clone.ts',
              directory: 'server/repositories',
            },
            {
              path: 'server/repositories/clone.test.ts',
              name: 'clone.test.ts',
              directory: 'server/repositories',
            },
          ],
        },
        messages: {
          total: 1,
          items: [
            {
              id: 'm-clone',
              taskId: 'clone-test',
              agentId: 'code-reviewer',
              title: 'Stop the clone test hanging',
              who: 'Code reviewer',
              fromYou: false,
              at: ago(120),
              snippet: 'Added a 5 s timeout so a finished clone can’t hang the cancellation test.',
            },
          ],
        },
      };
    if (q === 'home')
      return {
        ...none,
        names: [
          { kind: 'project', id: 'home-gym', title: 'home-gym' },
          {
            kind: 'app',
            id: 'sync',
            title: 'home-gym sync',
            projectId: 'home-gym',
            project: 'home-gym',
            appKind: 'worker',
          },
          {
            kind: 'app',
            id: 'web',
            title: 'home-gym',
            projectId: 'home-gym',
            project: 'home-gym',
            appKind: 'web',
          },
          {
            kind: 'task',
            id: 'review-gym',
            title: 'Review home-gym changes',
            projectId: 'home-gym',
            project: 'home-gym',
            agent: 'Code reviewer',
            status: 'idle',
            at: ago(52),
          },
        ],
      };
    if (q !== 'workouts.started') return none;
    return {
      ...none,
      names: [
        {
          kind: 'task',
          id: 'rename-started',
          title: 'Rename workouts.started safely',
          projectId: 'home-gym',
          project: 'home-gym',
          agent: 'Code reviewer',
          status: 'done',
          at: ago(120),
        },
      ],
      messages: {
        total: 4,
        items: [
          {
            id: 'e1',
            agentId: 'ops-watcher',
            title: 'Ops watcher',
            who: 'Ops watcher',
            fromYou: false,
            at: ago(21),
            snippet:
              'Sync fails 38% of jobs: the worker still reads workouts.started, which 0042 renamed.',
          },
          {
            id: 'm1',
            taskId: 'sync-migration',
            agentId: 'code-reviewer',
            title: 'Fix the sync migration',
            who: 'Code reviewer',
            fromYou: false,
            at: ago(3),
            snippet:
              'Changed the last reads of workouts.started in the worker and reran the sync tests.',
          },
          {
            id: 'm2',
            taskId: 'rename-started',
            agentId: 'code-reviewer',
            title: 'Rename workouts.started safely',
            who: 'Code reviewer',
            fromYou: false,
            at: ago(121),
            snippet: 'Renamed workouts.started to started_at in migration 0042.',
          },
          {
            id: 'm3',
            taskId: 'rename-started',
            agentId: 'code-reviewer',
            title: 'Rename workouts.started safely',
            who: 'You',
            fromYou: true,
            at: ago(140),
            snippet: 'Rename workouts.started safely, the phone app still reads it.',
          },
        ],
      },
    };
  };
  const commit = {
    oid: '7c1e4b9d',
    author: 'Code reviewer',
    date: ago(120),
    subject:
      "Add a 5 s timeout to waitForAbort so a finished clone can't hang the cancellation test",
  };
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    if (path === '/__fixture') {
      const next = (url.searchParams.get('state') ?? 'text') as State;
      if (!(next in states)) return json({ error: 'Unknown fixture state', states }, 400);
      state = next;
      const { page, ...open } = states[next] as (typeof states)[State] & Record<string, unknown>;
      const target = new URL(page, url);
      if (open.q) target.searchParams.set('fixture-q', String(open.q));
      if (open.kind) target.searchParams.set('fixture-kind', String(open.kind));
      if (open.scoped) target.searchParams.set('fixture-scoped', '1');
      return new Response(null, {
        status: 302,
        headers: { location: target.pathname + target.search },
      });
    }
    if (path === '/api/search')
      return json(names(url.searchParams.get('q') ?? '', url.searchParams.get('project')));
    if (path === '/api/search/code') {
      if ('slow' in states[state]) await new Promise((done) => setTimeout(done, 60_000));
      return json(
        code(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('project'),
          Number(url.searchParams.get('limit')) || 3,
        ),
      );
    }
    if (path === '/api/agents') return json({ agents });
    if (path === '/api/inbox')
      return json({
        cursor: 1,
        items: [
          {
            id: 'rollback',
            kind: 'other',
            title: 'Roll back home-gym?',
            text: '',
            from: 'ops-watcher',
            createdAt: ago(0),
            state: 'waiting',
            actions: [],
          },
          {
            id: 'merge',
            kind: 'other',
            title: 'Merge PR #18',
            text: '',
            from: 'code-reviewer',
            createdAt: ago(4),
            state: 'waiting',
            actions: [],
          },
          {
            id: 'keep',
            kind: 'other',
            title: 'Keep 3 or 5 releases?',
            text: '',
            from: 'ops-watcher',
            createdAt: ago(12),
            state: 'waiting',
            actions: [],
          },
        ],
      });
    const repository = path.match(/^\/api\/projects\/deploy-local\/repository(?:\/(.+))?$/);
    if (repository) {
      const file = url.searchParams.get('path') ?? '';
      if (!repository[1]) return json({ refs: [{ name: 'refs/heads/main', oid: commit.oid }] });
      if (repository[1] === 'tree')
        return json({
          commit: commit.oid,
          commitCount: 1284,
          latestCommit: {
            ...commit,
            author: 'Gabriel',
            subject:
              'Pass worker TLS trust to tool servers so agents reach the coordinator through its own CA',
          },
          entries: ['.github', 'app', 'bin', 'design', 'native', 'server']
            .map((name) => ({
              name,
              path: name,
              type: 'tree',
              lastCommit: {
                subject: 'Group CLI commands in the app’s words',
                date: ago(60 * 24 * 3),
              },
            }))
            .concat(
              ['AGENTS.md', 'CHANGELOG.md', 'README.md', 'package.json'].map((name) => ({
                name,
                path: name,
                type: 'blob',
                lastCommit: { subject: 'Release 0.42.0', date: ago(60 * 24 * 4) },
              })),
            ),
        });
      if (repository[1] === 'blob')
        return file === 'README.md'
          ? json({
              commit: commit.oid,
              size: 400,
              content:
                '# deploy.local\n\nDeploy apps and run coding agents on computers you own.\n',
              latestCommit: commit,
            })
          : json({ commit: commit.oid, size: 1434, content: `${source}\n`, latestCommit: commit });
    }
    return tasks.handle(request);
  }
  return { root: tasks.root, handle, close: tasks.close };
}

async function clientServer(root: string) {
  const { createServer: createVite } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const entry = join(root, 'client.tsx');
  // The entry mounts product components only. `fixture-q` types into the real box.
  writeFileSync(
    entry,
    `import {createRoot} from 'react-dom/client';
import {V2Layout} from '/app/routes/dashboard/v2-layout.client.tsx';
import Home from '/app/routes/dashboard/v2-home.client.tsx';
import {ProjectCode} from '/app/routes/dashboard/v2/projects/code.client.tsx';
import {setContent} from '/docs/evidence/one-search/fixture-router.tsx';
import '/app/design-tokens.css';
const params = new URLSearchParams(location.search);
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'Gabriel',token:'fixture-only'}));
const overview = {project:{id:'deploy-local',name:'deploy.local',apps:[]},repository:{status:'ready',defaultBranch:'main'},repositoryError:false,tasks:[],issues:[],pulls:[],apps:[]};
setContent(location.pathname.includes('/code') ? <div className="dl-page"><ProjectCode overview={overview}/></div> : <Home/>);
createRoot(document.getElementById('root')!).render(<V2Layout/>);
const until = (find) => new Promise((done) => { const tick = () => { const el = find(); el ? done(el) : setTimeout(tick, 100); }; tick(); });
const q = params.get('fixture-q');
(async () => {
  if (!q) return;
  await until(() => document.querySelector('.dl-app > .dl-side .dl-nav'));
  if (params.get('fixture-scoped')) (await until(() => document.querySelector('.v2-code-search'))).click();
  else window.dispatchEvent(new KeyboardEvent('keydown', {key:'k', metaKey:true}));
  const input = await until(() => document.querySelector('.v2-search[open] .v2-search-input'));
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(input, q);
  input.dispatchEvent(new Event('input', {bubbles:true}));
  if (params.get('fixture-kind') === 'code') (await until(() => document.querySelector('[data-row="code:all"]'))).click();
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
        'react-flight-router/client': join(repo, 'docs/evidence/one-search/fixture-router.tsx'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      middlewareMode: true,
      hmr: false,
      ws: false,
      fs: { allow: [repo, root, resolve(repo, '../../..')] },
    },
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
  process.env.DEPLOY_DATA_DIR = fixture.root;
  const { vite, entry } = await clientServer(fixture.root);
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const response = await fixture.handle(
        new Request(url, {
          method: req.method,
          signal: abort.signal,
          ...(!['GET', 'HEAD'].includes(req.method!) ? { body: Buffer.concat(chunks) } : {}),
        }),
      );
      if (abort.signal.aborted) return;
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
      `Search fixture: http://127.0.0.1:${port}/__fixture?state=text\nDisposable data: ${fixture.root}`,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await serve();
