// Real Design UI, fixture-only transport. No production server, Git, renderers or workers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  DesignReview,
  DesignReviewPreview,
  DesignReviewScreen,
} from '../../../shared/v2/contracts';
import { sections, type Canvas } from '../../../shared/v2/design';
import { layerSnippet } from '../../../server/design/board-html';

export const states = [
  'review',
  'approved',
  'approved-person',
  'building',
  'conflict',
  'notes-only',
  'loading',
  'not-landed',
  'no-one',
  'terminal',
  'approved-removed',
  'grouped',
  'round2',
  'compare',
] as const;
type State = (typeof states)[number];
const repo = resolve(import.meta.dirname, '../../..');
const api = '/api/projects/deploy-local/design';
const before = 'b901d12fixture';
const after = 'a731e45fixture';
const id = `design:deploy-local:design~welcome-gutter:${after}`;
const branch = 'design/welcome-gutter';
const title = 'Keep the gutter at every width';
const at = '2026-11-12T14:00:00.000Z';
const task = {
  id: 'welcome-gutter',
  title,
  projectId: 'deploy-local',
  status: 'running',
  createdAt: at,
  updatedAt: at,
};
const designer = {
  id: 'designer',
  name: 'Designer',
  avatar: { glyph: 'sparkles', color: '#0e9f8e' },
};
const json = (value: unknown, status = 200) => Response.json(value, { status });
const isState = (value: string): value is State => states.includes(value as State);
const mime: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

/** Importable without opening a socket. All writes live under this disposable directory. */
export function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'review-canvas-fixture-'));
  const project = {
    id: 'deploy-local',
    name: 'deploy.local',
    repositoryPath: join(root, 'repository'),
    repositoryStatus: 'ready',
  };
  const designRoot = join(project.repositoryPath, 'design');
  mkdirSync(designRoot, { recursive: true });
  cpSync(join(repo, 'design/ds'), join(designRoot, 'ds'), { recursive: true });
  const reference = readFileSync(join(repo, 'design/boards/DesignReviewCanvas.html'), 'utf8');
  const snippet = (layer: string) => {
    const value = layerSnippet(reference, layer);
    if (!value) throw new Error(`Reference board is missing ${layer}`);
    return value;
  };
  const definitions: [string, string, number, number, number, number][] = [
    ['Welcome.html', 'Welcome', 0, 0, 1440, 900],
    ['WelcomeNarrow.html', 'Welcome, narrow', 1620, 0, 720, 900],
    ['SignIn.html', 'Sign in', 2460, 0, 390, 844],
    ['NewProject.html', 'New project', 0, 1050, 1440, 900],
    ['InstallApp.html', 'Install an app', 1620, 1050, 1440, 900],
    ['FirstTask.html', 'First task', 0, 2100, 1440, 900],
    ['EmptyStateArt.html', 'Empty state art', 2505, 2175, 525, 525],
  ];
  const canvas: Canvas = {
    title: 'deploy.local',
    boards: Object.fromEntries(
      definitions.map(([file, frameTitle, x, y, w, h]) => [
        file,
        { title: frameTitle, x, y, w, h },
      ]),
    ),
    notes: {
      'section-start': { x: 0, y: -150, text: '1 · Get started' },
      gutter: { x: 2910, y: 45, w: 420, h: 270, text: `${title}, down to 390.` },
    },
  };
  // Other pages use existing repository frames. Only Get started is changed by this proposal.
  const source = JSON.parse(readFileSync(join(repo, 'design/canvas.json'), 'utf8')) as Canvas;
  const pages = sections(source);
  const otherFiles = new Map<string, string>();
  for (const [index, [sectionId, name, count]] of (
    [
      ['section-work', '2 · Ask and build', 5],
      ['section-projects', '3 · Projects and apps', 9],
      ['section-agents', '7 · Agents and trust', 5],
      ['section-mac', 'Mac app chrome', 3],
    ] as const
  ).entries()) {
    const y = (index + 1) * 10000;
    canvas.notes![sectionId] = { x: 0, y: y - 150, text: name };
    for (const [i, file] of (pages.find((page) => page.id === sectionId)?.boards ?? [])
      .slice(0, count)
      .entries()) {
      const key = `Page${index}-${file}`;
      canvas.boards[key] = { ...source.boards[file], x: i * 1600, y };
      otherFiles.set(key, file);
    }
  }
  canvas.order = Object.keys(canvas.boards);
  const styles = `html,body{margin:0;height:100%;font-family:var(--font);color:var(--ink)}
.ph{position:absolute;inset:0;display:flex;background:#fafafb}.ph .s{width:22%;background:#f3f3f5;border-right:1px solid var(--line)}
.ph .c{flex:1;display:flex;flex-direction:column;gap:26px;padding:16% 14%}.ph i{display:block;height:22px;border-radius:11px;background:#dcdce2}
.vec{position:absolute;left:0!important;top:0!important;overflow:visible;transform:scale(3.75);transform-origin:0 0}`;
  const html = (body: string, extra = '') =>
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="../ds/deploy-local/tokens.css"><link rel="stylesheet" href="../ds/deploy-local/components/bundle.css"><style>${styles}${extra}</style></head><body>${body}</body></html>`;
  const bodies: Record<string, string> = {
    'Welcome.html': snippet('app'),
    'WelcomeNarrow.html': snippet('ph'),
    'SignIn.html': snippet('ph-2'),
    'NewProject.html': snippet('ph-3'),
    'InstallApp.html': snippet('ph-4'),
    'FirstTask.html': snippet('ph-5'),
    'EmptyStateArt.html': snippet('vec'),
  };
  // Cached geometry in native frame pixels, corresponding to the reference's change marks.
  const areas: Record<string, DesignReviewPreview['areas']> = {
    'Welcome.html': [
      {
        layer: 'welcome-to-deploy',
        words: 'Title · Align',
        before: { x: 705, y: 259, w: 285, h: 53 },
        after: { x: 705, y: 259, w: 285, h: 53 },
      },
      {
        layer: 'greeting',
        words: 'Greeting · Gap 8 → 12',
        before: { x: 480, y: 345, w: 735, h: 127 },
        after: { x: 480, y: 345, w: 735, h: 135 },
      },
    ],
    'WelcomeNarrow.html': [
      {
        layer: 'c',
        words: 'Gutter 16',
        before: { x: 150, y: 112, w: 16, h: 675 },
        after: { x: 165, y: 112, w: 22, h: 675 },
      },
    ],
    'InstallApp.html': [
      {
        layer: 'c-4',
        words: 'App card',
        before: { x: 135, y: 217, w: 562, h: 360 },
        after: { x: 135, y: 217, w: 562, h: 360 },
      },
    ],
  };
  // Synthetic Before differs in the same areas; the reviewed UI itself is never replaced.
  for (const revision of [before, after]) {
    const folder = join(designRoot, revision, 'boards');
    mkdirSync(folder, { recursive: true });
    for (const [file, body] of Object.entries(bodies)) {
      const oldStyle =
        revision === before
          ? file === 'Welcome.html'
            ? '[data-layer="welcome-to-deploy"]{text-align:center}[data-layer="greeting"]{gap:8px}'
            : file === 'WelcomeNarrow.html'
              ? '.ph .c{padding-left:0}'
              : file === 'InstallApp.html'
                ? '.ph i:first-child{width:45%!important}'
                : ''
          : '';
      writeFileSync(join(folder, file), html(body, oldStyle));
    }
    for (const [key, file] of otherFiles) {
      // No remote fonts, scripts or images; the CSP below also enforces local-only resources.
      const content = readFileSync(join(repo, 'design/boards', file), 'utf8')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<link\b[^>]*href=["']https?:[^>]*>/gi, '')
        .replace(/(?:src|srcset)=["']https?:[^"']*["']/gi, '');
      writeFileSync(join(folder, key), content);
    }
  }
  let state: State = 'review';
  let review: DesignReview;
  const save = () =>
    writeFileSync(
      join(root, 'seed.json'),
      JSON.stringify({ state, project, task, agent: designer, review }, null, 2),
    );
  function reset(next: State) {
    state = next;
    const approved = ['approved', 'approved-person', 'building', 'approved-removed'].includes(
      state,
    );
    // The owner asked for changes on Gabriel's own proposal, made from a terminal.
    const asked = state === 'no-one' || state === 'terminal';
    const person = state === 'approved-person' || asked;
    // An approval that hit main's own change while landing: back to waiting, with a choice to make.
    const conflicted = state === 'conflict' || state === 'not-landed';
    // The second round: Welcome was seen in round 1 and is unchanged; the other two changed since.
    const second = state === 'round2';
    const boards: DesignReviewScreen[] =
      state === 'notes-only'
        ? []
        : Object.keys(areas).map((file, index) => {
            const board = canvas.boards[file];
            return {
              file,
              title: board.title!,
              w: board.w,
              h: board.h,
              widths: [board.w],
              page: '1 · Get started',
              pageId: 'section-start',
              index: index + 1,
              count: 3,
              notes: null,
              added: false,
              removed: false,
              status: 'changed',
              before,
              after,
              changes: areas[file].map(({ layer, words }) => ({ layer, words })),
              lines: [],
              seen: approved || index === 0 || (second && index === 1),
              ...(second && index < 2 ? { seenInRound: index === 0 ? 1 : 2 } : {}),
              changedSinceReview: second && index > 0,
              conflict: conflicted && index === 0,
            };
          });
    const proposer = person ? { id: null, name: 'Gabriel', avatar: null } : designer;
    // The branch also changed the sidebar, a shared part on 242 screens, looked at on Welcome.
    const parts =
      state === 'grouped'
        ? [
            {
              component: 'sidebar',
              name: 'Sidebar',
              screens: 242,
              lookAt: { file: 'Welcome.html', title: 'Welcome' },
              seen: true,
            },
          ]
        : undefined;
    review = {
      ...(parts ? { parts } : {}),
      id,
      title,
      projectId: project.id,
      project: project.name,
      branch,
      proposer,
      summary: 'Keep the welcome gutter at every width and align the greeting and app card.',
      createdAt: at,
      counts: { screens: boards.length, changed: boards.length, new: 0, removed: 0 },
      stale: conflicted,
      conflicts: conflicted ? ['Welcome.html'] : [],
      resolutions: conflicted
        ? [
            {
              file: 'Welcome.html',
              kind: 'same-part',
              mainExists: true,
              proposalExists: true,
              mainChanged: 'Title alignment',
              proposalChanged: 'Title alignment and greeting gap',
              detail: 'The title changed on main too. Choose which version to keep.',
              choice: null,
            },
          ]
        : [],
      item: {
        id,
        kind: 'other',
        title,
        text: '',
        from: person ? 'Gabriel' : designer.id,
        fromName: proposer.name,
        projectId: project.id,
        ...(person ? {} : { taskId: task.id }),
        createdAt: at,
        state: approved || asked ? 'answered' : 'waiting',
        actions: [
          { id: 'approve', label: 'Approve design', primary: true },
          { id: 'changes', label: 'Ask for changes' },
        ],
        ...(approved
          ? { answer: { actionId: 'approve', by: 'Gabriel', on: 'web' as const, at } }
          : asked
            ? { answer: { actionId: 'changes', by: 'Gabriel', on: 'web' as const, at } }
            : {}),
      },
      task: person ? null : title,
      proposerTaskId: person ? null : task.id,
      before,
      after,
      main: approved ? '4f05991' : before,
      updatedWithMainAt: null,
      round: second ? 2 : 1,
      previousItemId: second ? `design:deploy-local:design~welcome-gutter:${before}` : null,
      ...(approved
        ? {
            landing: {
              state: 'landed' as const,
              at,
              commit: '4f05991',
              ...(state === 'building'
                ? { build: { at, taskId: task.id, name: title, started: true } }
                : {}),
              ...(state === 'approved-removed' ? { branch: { name: branch, removed: true } } : {}),
            },
          }
        : state === 'not-landed'
          ? { landing: { state: 'conflict' as const, at } }
          : {}),
      ...(asked
        ? {
            feedback: {
              actionId: 'changes' as const,
              notes: 1,
              ...(state === 'terminal'
                ? { delivery: 'terminal' as const, computer: 'MacBook Pro' }
                : { delivery: 'nobody' as const }),
            },
          }
        : {}),
      boards,
      groups: [
        {
          id: 'section-start',
          title: '1 · Get started',
          boards: boards.map((board) => board.file),
        },
      ],
      pins: second
        ? [
            {
              id: 'pin-gutter',
              number: 1,
              board: 'WelcomeNarrow.html',
              noteId: null,
              width: 720,
              revision: before,
              x: 160,
              y: 120,
              text: 'Keep the gutter at 16 here too.',
              author: 'Gabriel',
              resolved: true,
              reply: 'Gutter is 16 at every width now.',
              createdAt: '2026-11-11T14:00:00.000Z',
              round: 1,
            },
            {
              id: 'pin-maker',
              number: 2,
              board: 'InstallApp.html',
              noteId: null,
              width: 1440,
              revision: before,
              x: 300,
              y: 260,
              text: 'The app card should say who made it.',
              author: 'Gabriel',
              resolved: false,
              reply: 'Kept the size; the maker does not fit at 700.',
              createdAt: '2026-11-11T14:01:00.000Z',
              round: 1,
            },
          ]
        : [],
      notes:
        state === 'notes-only'
          ? [
              {
                id: 'gutter',
                title,
                page: '1 · Get started',
                before: [{ text: title, gone: true }],
                after: [{ text: `${title}, down to 390.`, added: true }],
                changed: 1,
                total: 1,
              },
            ]
          : [],
    };
    writeFileSync(join(designRoot, 'canvas.json'), JSON.stringify(canvas, null, 2));
    save();
  }
  reset('review');
  const pending = new Set<() => void>();
  const wait = (signal: AbortSignal, ms?: number) =>
    new Promise<void>((done) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        pending.delete(finish);
        done();
      };
      pending.add(finish);
      if (ms !== undefined) timer = setTimeout(finish, ms);
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
    });
  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === '/__fixture' && request.method === 'GET') {
      const next = url.searchParams.get('state') ?? 'review';
      if (!isState(next)) return json({ error: 'Unknown fixture state', states }, 400);
      for (const finish of pending) finish();
      reset(next);
      return new Response(null, {
        status: 302,
        headers: {
          location: `/dashboard/design?review=${encodeURIComponent(id)}&page=section-start`,
        },
      });
    }
    // The app trades its saved sign-in for a session cookie on load. Nothing is stored here.
    if (path === '/api/auth/session' && request.method === 'POST')
      return new Response(null, { status: 204 });
    if (!['GET', 'HEAD'].includes(request.method)) {
      if (path !== `${api}/review/seen` || request.method !== 'POST')
        return json({ error: 'Capture fixture: mutation disabled' }, 405);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      if (
        !body ||
        body.item !== id ||
        body.revision !== review.after ||
        review.item.state !== 'waiting' ||
        state === 'loading'
      )
        return json({ error: 'Proposal or revision is not waiting' }, 409);
      const board = review.boards.find((entry) => entry.file === body.board);
      if (!board) return json({ error: 'Unknown changed frame' }, 404);
      board.seen = true;
      // Ticking the screen a shared part is looked at on ticks the part.
      for (const part of review.parts ?? []) if (part.lookAt.file === board.file) part.seen = true;
      save();
      return json({ ok: true });
    }
    if (path === `${api}/review`) {
      if (url.searchParams.get('item') !== id) return json({ error: 'Unknown proposal' }, 404);
      if (state === 'loading') {
        await wait(request.signal);
        return new Response(null, { status: 204 });
      }
      return json(review);
    }
    if (path === `${api}/review/preview`) {
      const file = url.searchParams.get('board') ?? '';
      const board = review.boards.find((entry) => entry.file === file);
      if (url.searchParams.get('item') !== id || !board)
        return json({ error: 'Unknown changed frame' }, 404);
      const preview: DesignReviewPreview = {
        width: board.w,
        height: board.h,
        before: null,
        after: null,
        areas: areas[file],
        crop: { x: 0, y: 0, w: board.w, h: board.h },
      };
      return json(preview);
    }
    if (path === api) {
      const old = url.searchParams.get('ref') === before;
      const shown = structuredClone(canvas);
      if (old && state === 'notes-only') shown.notes!.gutter.text = title;
      return json({
        ref: old ? before : branch,
        commit: old ? before : after,
        canvas: shown,
        branches: [
          { name: 'main', commit: review.main, updatedAt: at },
          { name: branch, commit: after, updatedAt: at, by: 'Designer', edits: 3 },
        ],
        openComments: 0,
      });
    }
    if (path.startsWith(`${api}/files/`)) {
      const match = /^([^/]+)\/(.+)$/.exec(decodeURIComponent(path.slice(`${api}/files/`.length)));
      if (!match || ![before, after, '4f05991'].includes(match[1]))
        return json({ error: 'Unknown revision' }, 404);
      const relative = match[2];
      const base = relative.startsWith('ds/')
        ? designRoot
        : join(designRoot, match[1] === before ? before : after);
      const file = resolve(base, relative);
      if (!file.startsWith(base + sep)) return json({ error: 'Invalid path' }, 400);
      try {
        return new Response(readFileSync(file), {
          headers: { 'content-type': mime[extname(file)] ?? 'application/octet-stream' },
        });
      } catch {
        return json({ error: 'Unknown fixture asset' }, 404);
      }
    }
    if (path === `${api}/proposals`)
      return json({
        proposals: [
          {
            id,
            title,
            branch,
            state: review.item.state,
            boards: review.boards.map((board) => board.file),
          },
        ],
      });
    if (path === `${api}/presence`) return json({ agents: [] });
    if (path === `${api}/asks`) return json({ asks: [] });
    if (path === `${api}/comments`) return json({ comments: [] });
    if (path === `${api}/changes`) return json({ files: [] });
    if (path === `${api}/components`) return json({ library: null, usage: {} });
    if (path === `${api}/links`) return json({ links: [] });
    if (path === '/api/projects') return json({ projects: [project] });
    if (path === '/api/inbox')
      return json({
        items:
          !url.searchParams.has('state') || url.searchParams.get('state') === review.item.state
            ? [review.item]
            : [],
        cursor: 1,
      });
    if (path === '/api/user') return json({ username: 'Gabriel', role: 'admin' });
    if (path === '/api/auth/account')
      return json({
        username: 'Gabriel',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    if (path === '/api/agents') return json({ agents: [designer] });
    // The design menu lists a project's other artifacts; this project has only its App design.
    if (path === '/api/artifacts')
      return json({ artifacts: [], projects: [{ id: project.id, name: project.name }] });
    if (path === '/api/computers') return json({ computers: [] });
    if (path === '/api/nodes')
      return json({
        nodes: [
          { id: 'coordinator', name: 'SER', online: true },
          { id: 'mac', name: 'Mac', online: true },
        ],
      });
    if (path === '/api/live') return json({ summary: { running: 0, failing: 0 } });
    if (path === '/api/packages') return json({ served: false, usingCopies: false });
    if (path === '/api/state')
      return json({
        version: 1,
        cursor: 1,
        projects: [project],
        tasks:
          state === 'approved-person' || state === 'no-one' || state === 'terminal' ? [] : [task],
        workers: [],
        runs: [],
        adapters: [],
      });
    if (path === '/api/activity-events') {
      if (url.searchParams.get('after') !== 'latest') await wait(request.signal, 10000);
      return json({ events: [], cursor: 1, supportsWait: true });
    }
    if (path.startsWith('/api/')) return json({ error: `Unseeded fixture route: ${path}` }, 404);
    return null;
  }
  return {
    root,
    handle,
    close() {
      for (const finish of pending) finish();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function clientServer(root: string) {
  const { createServer: createVite } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  // Generated entry only mounts product components. No replica review UI or injected layout CSS.
  const entry = join(root, 'client.tsx');
  writeFileSync(
    entry,
    `import {createRoot} from 'react-dom/client';
import {V2Layout} from '/app/routes/dashboard/v2-layout.client.tsx';
import Design from '/app/routes/dashboard/v2/design/page.client.tsx';
import {setContent} from '/docs/evidence/board-parity/fixture-router.tsx';
import '/app/design-tokens.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'Gabriel',token:'fixture-only'}));
setContent(<Design/>); createRoot(document.getElementById('root')!).render(<V2Layout/>);`,
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
  const port = Number(process.env.PORT ?? 5190);
  if (!Number.isInteger(port) || port < 5180 || port > 5199)
    throw new Error('Use only ports 5180–5199');
  const fixture = createFixture();
  process.env.DEPLOY_DATA_DIR = fixture.root;
  const { vite, entry } = await clientServer(fixture.root);
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    // Enforce local-only assets even when someone opens the fixture by hand.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:",
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
      } else if (url.pathname === '/dashboard/design') {
        res.setHeader('content-type', 'text/html');
        res.end(
          await vite.transformIndexHtml(
            url.pathname,
            `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@fs/${entry}"></script></body></html>`,
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
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void close();
    });
  server.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
    void close();
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Review canvas: http://127.0.0.1:${port}/__fixture?state=review\nDisposable data: ${fixture.root}`,
    ),
  );
}

async function check() {
  const fixture = createFixture();
  const call = (path: string, init?: RequestInit) =>
    fixture.handle(new Request(`http://127.0.0.1:5190${path}`, init));
  try {
    for (const state of states) {
      const reset = await call(`/__fixture?state=${state}`);
      assert.equal(reset!.status, 302);
      assert.equal(
        new URL(reset!.headers.get('location')!, 'http://fixture').pathname,
        '/dashboard/design',
      );
      if (state === 'loading') {
        const controller = new AbortController();
        let settled = false;
        const response = call(`${api}/review?item=${encodeURIComponent(id)}`, {
          signal: controller.signal,
        }).then((value) => {
          settled = true;
          return value;
        });
        await new Promise((done) => setTimeout(done, 20));
        assert.equal(settled, false);
        controller.abort();
        assert.equal((await response)!.status, 204);
        continue;
      }
      const review = (await (await call(
        `${api}/review?item=${encodeURIComponent(id)}`,
      ))!.json()) as DesignReview;
      assert.equal(review.title, title);
      assert.equal(review.boards.length, state === 'notes-only' ? 0 : 3);
      assert.equal(
        review.proposerTaskId,
        ['approved-person', 'no-one', 'terminal'].includes(state) ? null : task.id,
      );
      if (state === 'not-landed') assert.equal(review.landing?.state, 'conflict');
      if (state === 'no-one') assert.equal(review.feedback?.delivery, 'nobody');
      if (state === 'terminal') assert.equal(review.feedback?.computer, 'MacBook Pro');
      if (state === 'approved-removed') assert.equal(review.landing?.branch?.removed, true);
      if (state.startsWith('approved') || state === 'building') {
        assert.equal(review.landing?.commit, '4f05991');
        assert.equal(Boolean(review.landing?.build), state === 'building');
        assert.ok(review.boards.every((board) => board.seen));
      } else if (state !== 'notes-only')
        assert.equal(
          review.boards.filter((board) => board.seen).length,
          state === 'round2' ? 2 : 1,
        );
      if (state === 'round2') {
        assert.equal(review.round, 2);
        assert.deepEqual(
          review.boards.map((board) => [board.file, board.changedSinceReview, board.seenInRound]),
          [
            ['Welcome.html', false, 1],
            ['WelcomeNarrow.html', true, 2],
            ['InstallApp.html', true, undefined],
          ],
        );
        assert.deepEqual(
          review.pins.map((pin) => [pin.round, pin.resolved, pin.reply]),
          [
            [1, true, 'Gutter is 16 at every width now.'],
            [1, false, 'Kept the size; the maker does not fit at 700.'],
          ],
        );
      } else assert.equal(review.pins.length, 0);
      if (state === 'conflict' || state === 'not-landed')
        assert.equal(review.resolutions![0].choice, null);
      if (state === 'notes-only') assert.equal(review.notes[0].id, 'gutter');
      assert.deepEqual(
        review.parts?.map((part) => [part.name, part.screens, part.lookAt.file, part.seen]),
        state === 'grouped' ? [['Sidebar', 242, 'Welcome.html', true]] : undefined,
      );
      const design = await (await call(api))!.json();
      assert.equal(design.canvas.boards['WelcomeNarrow.html'].w, 720);
      assert.equal(sections(design.canvas).length, 5);
      for (const board of review.boards) {
        const preview = await (await call(
          `${api}/review/preview?item=${encodeURIComponent(id)}&board=${board.file}`,
        ))!.json();
        assert.ok(preview.areas.length);
        for (const revision of [before, after])
          assert.equal((await call(`${api}/files/${revision}/boards/${board.file}`))!.status, 200);
      }
      for (const path of [
        '/api/inbox?state=waiting',
        '/api/inbox?state=answered',
        '/api/state',
        '/api/auth/account',
        `${api}/presence`,
        `${api}/components`,
        `${api}/files/${after}/ds/deploy-local/tokens.json`,
      ])
        assert.equal((await call(path))!.status, 200);
      for (const path of [
        `${api}/review/build`,
        `${api}/canvas`,
        `/api/inbox/${encodeURIComponent(id)}/answer`,
      ])
        assert.equal((await call(path, { method: 'POST', body: '{}' }))!.status, 405);
    }
    await call('/__fixture?state=review');
    const tick = (body: unknown) =>
      call(`${api}/review/seen`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal(
      (await tick({ item: id, board: 'WelcomeNarrow.html', revision: 'stale' }))!.status,
      409,
    );
    assert.equal((await tick({ item: id, board: 'SignIn.html', revision: after }))!.status, 404);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await tick({ item: id, board: 'WelcomeNarrow.html', revision: after }))!.status,
        200,
      );
    assert.equal(
      JSON.parse(readFileSync(join(fixture.root, 'seed.json'), 'utf8')).review.boards.filter(
        (board: DesignReviewScreen) => board.seen,
      ).length,
      2,
    );
    await call('/__fixture?state=review');
    assert.equal(
      JSON.parse(readFileSync(join(fixture.root, 'seed.json'), 'utf8')).review.boards.filter(
        (board: DesignReviewScreen) => board.seen,
      ).length,
      1,
    );
    await call('/__fixture?state=approved');
    assert.equal(
      (await tick({ item: id, board: 'WelcomeNarrow.html', revision: after }))!.status,
      409,
    );
    assert.equal((await call('/__fixture?state=invalid'))!.status, 400);
    assert.equal((await call('/api/not-seeded'))!.status, 404);
    const { vite, entry } = await clientServer(fixture.root);
    try {
      for (const path of [
        `/@fs/${entry}`,
        '/app/routes/dashboard/v2-layout.client.tsx',
        '/app/routes/dashboard/v2/design/page.client.tsx',
        '/app/routes/dashboard/v2/design/CanvasReview.tsx',
        '/app/routes/dashboard/v2/design/BuildDesign.tsx',
      ])
        assert.ok((await vite.transformRequest(path))?.code, `Compiled ${path}`);
      await vite.waitForRequestsIdle();
    } finally {
      await vite.close();
    }
    console.log(
      'PASS: fourteen states, real route redirects, assets, cached areas, frame ticks/reset, loading cancellation, mutation guards and Vite entry/components. No browser or sockets opened.',
    );
  } finally {
    fixture.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) await check();
  else await serve();
}
