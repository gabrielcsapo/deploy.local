// Isolated capture fixture: no coordinator, Git, database, worker, or model calls.
// Browser previews are rendered lazily by the orchestrator, from repository boards.
import { createServer, request as proxyRequest } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, extname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { DesignReview, DesignReviewScreen, InboxItem } from '../../../shared/v2/contracts';
import { fixturePreview } from './fixture-preview';
import { routeFetch } from '../../../server/v2/test-request.ts';

process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const root = mkdtempSync(join(tmpdir(), 'design-chat-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const repo = resolve(import.meta.dirname, '../../..');
const origin = 'http://127.0.0.1:5194';
const api = '/api/projects/deploy-local/design';
const at = () => new Date().toISOString();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const proposer = { id: 'release-notes-writer', name: 'Release notes writer', avatar: null };
function item(branch: string, title: string): InboxItem {
  return {
    id: `design:deploy-local:${branch}:after`,
    kind: 'other',
    title,
    text: '',
    from: proposer.id,
    fromName: proposer.name,
    projectId: 'deploy-local',
    taskId: branch === 'chat' ? 'welcome' : 'agents',
    createdAt: ago(120),
    state: 'waiting',
    actions: [
      { id: 'approve', label: 'Approve design', primary: true },
      { id: 'changes', label: 'Ask for changes' },
    ],
  };
}
function screen(
  file: string,
  title: string,
  status: 'changed' | 'new' | 'removed' = 'changed',
): DesignReviewScreen {
  const w = file.includes('Phone') ? 390 : 1440;
  return {
    file,
    title,
    w,
    h: w === 390 ? 844 : 900,
    widths: w === 390 ? [390] : [1440, 700],
    status,
    added: status === 'new',
    removed: status === 'removed',
    before: 'before',
    after: 'after',
    changes: [],
    seen: false,
    changedSinceReview: true,
    lines: [],
    notes: null,
    pageId: 'agents',
    page: 'Agents and trust',
    index: 0,
    count: 1,
    conflict: false,
  };
}
function review(item: InboxItem, boards: DesignReviewScreen[]): DesignReview {
  return {
    item,
    id: item.id,
    title: item.title,
    summary: '',
    projectId: 'deploy-local',
    project: 'deploy.local',
    task: item.taskId ?? null,
    branch: 'design/fixture',
    before: 'before',
    after: 'after',
    main: 'before',
    round: 1,
    previousItemId: null,
    createdAt: ago(120),
    updatedWithMainAt: ago(10),
    proposer,
    stale: false,
    conflicts: [],
    counts: {
      screens: boards.length,
      changed: boards.filter((b) => b.status === 'changed').length,
      new: boards.filter((b) => b.added).length,
      removed: boards.filter((b) => b.removed).length,
    },
    groups: [{ id: 'agents', title: 'Agents and trust', boards: boards.map((b) => b.file) }],
    boards,
    pins: [],
    notes: [],
  };
}
const chat = review(item('chat', 'Welcome: ask first'), [
  screen('Welcome.html', 'Welcome'),
  screen('WelcomePhone.html', 'Welcome, narrow'),
]);
const definitions = [
  ['AgentInfoPhone', 'Agent details on iPhone'],
  ['AgentsEmpty', 'The old agent directory', 'removed'],
  ['AgentAvatarPicker', 'Choose an avatar', 'new'],
  ['AgentSettings', 'Agent details'],
  ['AgentPage', 'Agent conversation'],
  ['AgentRuns', 'Work history', 'new'],
  ['WorkAgentsPhone', 'Your agents on iPhone'],
  ['AgentAvatarPickerPhone', 'Choose an avatar on iPhone', 'new'],
  ['AgentPhone', 'Agent conversation on iPhone'],
  ['AgentRunsPhone', 'Work history on iPhone', 'new'],
  ['NewAgentBlank', 'Start a new agent', 'new'],
  ['NewAgentBlankPhone', 'Start a new agent on iPhone', 'new'],
  ['NewAgent', 'Create an agent'],
  ['NewAgentPhone', 'Create an agent on iPhone'],
  ['AgentHello', 'Meet your agent'],
  ['AgentHelloPhone', 'Meet your agent on iPhone'],
  ['AgentTaught', 'Teach your agent', 'new'],
  ['AgentTaughtPhone', 'Teach your agent on iPhone', 'new'],
  ['AgentBeat', 'Confirm ongoing work', 'new'],
  ['AgentBeatPhone', 'Confirm ongoing work on iPhone', 'new'],
  ['AgentRoutine', 'Add work to look after', 'new'],
  ['AgentRoutinePhone', 'Add work on iPhone', 'new'],
] as const;
const sent = review(
  item('agents', 'Agents you make yourself'),
  definitions.map(([file, title, kind]) => screen(`${file}.html`, title, kind)),
);
sent.summary =
  'Create an agent with a name and an avatar, then teach it in chat. Keep its conversations, what it has learned and optional work together, so you can return to the same agent on web and iPhone.';
for (const file of [
  'AgentSettings.html',
  'AgentPage.html',
  'AgentHello.html',
  'AgentHelloPhone.html',
])
  sent.boards.find((b) => b.file === file)!.seen = true;
sent.pins = [
  ['AgentSettings.html', 'Keep the name visible when I scroll.'],
  ['AgentSettings.html', 'Leave a gutter beside the input.'],
  ['AgentHelloPhone.html', 'Keep this action above the keyboard.'],
].map(([board, text], i) => ({
  id: `pin-${i + 1}`,
  number: i + 1,
  board,
  width: board.includes('Phone') ? 390 : 1440,
  revision: 'after',
  x: 195,
  y: 320 + i * 40,
  text,
  author: 'Gabriel',
  resolved: false,
  noteId: null,
  reply: null,
  createdAt: ago(1),
}));
const reviews = [chat, sent];
const task = {
  id: 'welcome',
  title: chat.item.title,
  projectId: 'deploy-local',
  status: 'running',
  revision: 1,
  branch: 'design/fixture',
  workspacePath: join(root, 'workspace'),
  baseRevision: 'before',
  createdAt: ago(6),
  updatedAt: at(),
  startedBy: 'you',
  startedFrom: 'New task',
  startedModel: 'Codex',
};
const sentTask = { ...task, id: 'agents', title: sent.item.title };
const tasks = [task, sentTask];
const events = [
  {
    kind: 'you',
    id: 'you',
    at: ago(6),
    text: 'Put the input first on the Welcome page and keep a side gutter.',
    attachments: [],
  },
  {
    kind: 'worklog',
    id: 'work',
    at: ago(1),
    summary: 'Worked for 6m · edited 2 screens in design/',
    live: false,
    steps: [],
  },
  {
    kind: 'reply',
    id: 'reply',
    at: ago(1),
    agent: proposer.id,
    paragraphs: [
      'I redrew Welcome with the input above the quick actions and a gutter at every width, and added the narrow version. Nothing is built yet; approval puts the design on main, then you can ask for a build.',
    ],
  },
  { kind: 'decision', id: 'decision', at: ago(1), inboxItemId: chat.item.id },
];
const canvas = JSON.parse(readFileSync(join(repo, 'design/canvas.json'), 'utf8'));

// Extract the approved mini's full application, without its scale or parent clipping.
function div(html: string, layer: string) {
  const start = html.indexOf(`<div data-layer="${layer}"`);
  if (start < 0) throw new Error(`Missing layer ${layer}`);
  const tags = /<div\b[^>]*>|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match; (match = tags.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (!depth) return html.slice(start, tags.lastIndex);
  }
  throw new Error(`Unclosed layer ${layer}`);
}
const images = new Map<
  string,
  Promise<{ png: Buffer; rect: { x: number; y: number; w: number; h: number } }>
>();
let browser: Promise<import('playwright').Browser> | undefined;
async function render(file: string, side: string, width: number, scale: number) {
  const key = `${file}:${side}:${width}:${scale}`;
  if (!images.has(key))
    images.set(
      key,
      (async () => {
        const { chromium } = await import('playwright');
        browser ??= chromium.launch();
        const page = await (
          await browser
        ).newPage({
          viewport: {
            width,
            height: reviews.flatMap((r) => r.boards).find((b) => b.file === file)?.h ?? 900,
          },
          deviceScaleFactor: scale,
        });
        try {
          if (file.startsWith('Welcome')) {
            const phone = width < 1000;
            const html = readFileSync(
              join(repo, `design/boards/${phone ? 'DesignChatPhone' : 'DesignChat'}.html`),
              'utf8',
            );
            const layer = phone
              ? side === 'before'
                ? 'before-app'
                : 'app'
              : side === 'before'
                ? 'app-2'
                : 'app-3';
            await page.setContent(
              `<link rel="stylesheet" href="${origin}/design/ds/deploy-local/tokens.css"><link rel="stylesheet" href="${origin}/design/ds/deploy-local/components/bundle.css"><style>body{margin:0}body>.dl-app{width:${width}px!important;height:900px!important}</style>${div(html, layer)}`,
              { waitUntil: 'networkidle' },
            );
          } else await page.goto(`${origin}/design/boards/${file}`, { waitUntil: 'networkidle' });
          const rect = await page
            .evaluate(() => {
              const el = document.querySelector('.dl-composer');
              if (!el) return { x: innerWidth * 0.3, y: 250, w: innerWidth * 0.4, h: 240 };
              const r = el.getBoundingClientRect();
              return { x: r.x, y: r.y, w: r.width, h: r.height };
            })
            .catch(() => ({ x: width * 0.3, y: 250, w: width * 0.4, h: 240 }));
          return { png: await page.screenshot(), rect };
        } finally {
          await page.close();
        }
      })(),
    );
  return images.get(key)!;
}

const handle: import('node:http').RequestListener = async (req, res) => {
  const url = new URL(req.url!, origin),
    // Foundation percent-encodes '-' in project IDs; the real server decodes route segments.
    path = decodeURIComponent(url.pathname);
  const activeTask = tasks.find(
    (task) => task.id === path.match(/^\/api\/(?:tasks|task-snapshots)\/([^/]+)/)?.[1],
  );
  const taskEvents =
    activeTask === task
      ? events
      : [
          {
            kind: 'decision',
            id: 'agents-decision',
            at: sent.createdAt,
            inboxItemId: sent.item.id,
          },
        ];
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    if (path === '/fixture')
      return send({
        chat: `${origin}/dashboard/tasks/welcome`,
        review: `${origin}/dashboard/inbox?item=${encodeURIComponent(sent.item.id)}`,
        items: reviews.map((r) => r.item.id),
        data: root,
      });
    if (path === '/fixture/reset') {
      const state = url.searchParams.get('state') ?? 'waiting';
      for (const r of reviews) {
        r.item.state = state === 'waiting' ? 'waiting' : 'answered';
        r.item.answer =
          state === 'waiting' ? undefined : { actionId: state, by: 'Gabriel', on: 'web', at: at() };
        r.round = Number(url.searchParams.get('round') ?? 1);
        r.task = url.searchParams.has('self') ? null : r === chat ? 'welcome' : 'agents';
        r.item.taskId = r.task ?? undefined;
      }
      return send({ items: reviews.map((r) => r.item) });
    }
    if (path.startsWith('/design/')) {
      const file = resolve(repo, `.${path}`);
      if (!file.startsWith(join(repo, 'design') + sep)) return send({ error: 'Not found' }, 404);
      res.writeHead(200, {
        'Content-Type':
          (
            { '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' } as Record<
              string,
              string
            >
          )[extname(file)] ?? 'application/octet-stream',
      });
      return res.end(readFileSync(file));
    }
    if (path === '/api/login') return send({ token: 'fixture' });
    if (path === '/api/user') return send({ username: 'Gabriel', role: 'admin' });
    if (path === '/api/auth/account')
      return send({
        username: 'Gabriel',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    if (path === '/api/nodes')
      return send({ nodes: [{ id: 'coordinator', name: 'SER', online: true }] });
    if (path === '/api/state')
      return send({
        version: 1,
        cursor: 1,
        projects: [{ id: 'deploy-local', name: 'deploy.local', apps: [] }],
        tasks,
        workers: [],
        runs: [],
        adapters: [],
      });
    if (path === '/api/live')
      return send({
        summary: { running: 0, failing: 0, warning: 0, checkedAt: at() },
        computers: [],
      });
    if (path === '/api/agents')
      return send({ agents: [{ ...proposer, job: '', computers: [], looksAfter: [] }] });
    if (path === '/api/inbox')
      return send({
        items: reviews
          .map((r) => r.item)
          .filter((i) => i.state === (url.searchParams.get('state') ?? 'waiting')),
      });
    if (path === '/api/activity-events' || path.endsWith('/stream')) {
      if (url.searchParams.get('after') === 'latest')
        return send({ events: [], cursor: 1, supportsWait: true });
      const timer = setTimeout(
        () => send({ events: [], cursor: Date.now(), supportsWait: true }),
        15000,
      );
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (activeTask && path === `/api/task-snapshots/${activeTask.id}`)
      return send({
        task: activeTask,
        project: { id: 'deploy-local', name: 'deploy.local', kind: 'Web app' },
        computer: 'SER',
        computerId: 'coordinator',
        run: null,
        comparison: { ahead: 0, behind: 0 },
        firstTask: false,
        cursor: 1,
        events: taskEvents,
        pulls: [],
        checks: [],
        screenshots: [],
        releases: [],
      });
    if (activeTask && path === `/api/tasks/${activeTask.id}`)
      return send({
        task: activeTask,
        messages: (activeTask === task ? events : []).flatMap((event) =>
          event.kind === 'you' || event.kind === 'reply'
            ? [
                {
                  id: event.id,
                  taskId: task.id,
                  role: event.kind === 'you' ? 'user' : 'assistant',
                  content: event.kind === 'you' ? event.text : event.paragraphs!.join('\n\n'),
                  createdAt: event.at,
                },
              ]
            : [],
        ),
        runs: [],
        events: [],
        cursor: 1,
      });
    if (activeTask && path === `/api/tasks/${activeTask.id}/diff`)
      return send({
        status: 'ready',
        baseRevision: 'before',
        headRevision: 'after',
        files: [],
        patch: '',
        checks: [],
      });
    if (path === `${api}/changes`)
      return send({
        base: 'before',
        commit: 'after',
        files: (url.searchParams.get('task') === 'agents' ? sent : chat).boards.map((b) => ({
          status: 'M',
          path: `design/boards/${b.file}`,
        })),
      });
    if (path === api) return send({ canvas });
    if (path === `${api}/proposals`) return send({ proposals: reviews.map((r) => r.item) });
    const answer = path.match(/^\/api\/inbox\/(.+)\/answer$/);
    const r = reviews.find(
      (r) =>
        r.item.id ===
        (url.searchParams.get('item') ?? (answer ? decodeURIComponent(answer[1]) : '')),
    );
    if (r && answer && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      r.item = {
        ...r.item,
        state: 'answered',
        answer: {
          actionId: body.actionId,
          at: at(),
          by: 'Gabriel',
          on: body.on ?? 'web',
          note: body.note,
        },
      };
      return send({ item: r.item });
    }
    if (path === `${api}/review`) return r ? send(r) : send({ error: 'Unknown review' }, 404);
    if (path === `${api}/review/seen`) {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw),
        review = reviews.find((r) => r.item.id === body.item);
      const board = review?.boards.find((b) => b.file === body.board);
      if (board) board.seen = true;
      return send({ ok: true });
    }
    if (path === `${api}/review/preview` && r) {
      const board = r.boards.find((b) => b.file === url.searchParams.get('board'))!;
      const width = Number(url.searchParams.get('width') ?? board.widths[0]),
        scale = Number(url.searchParams.get('scale') ?? 1);
      const [before, after] = await Promise.all(
        ['before', 'after'].map((side) => render(board.file, side, width, scale)),
      );
      return send(fixturePreview(board, width, scale, before.rect, after.rect));
    }
    if (path === '/fixture/image') {
      const image = await render(
        url.searchParams.get('file')!,
        url.searchParams.get('side')!,
        Number(url.searchParams.get('width')),
        Number(url.searchParams.get('scale')),
      );
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(image.png);
    }
    if (path.startsWith('/api/'))
      return send({ error: `Fixture route unavailable: ${req.method} ${path}` }, 404);
    const proxy = proxyRequest(
      {
        hostname: '127.0.0.1',
        port: 5195,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode!, response.headers);
        response.pipe(res);
      },
    );
    proxy.on('error', () => send({ error: 'Start Vite on 5195' }, 503));
    req.pipe(proxy);
  } catch (error) {
    send({ error: String(error) }, 500);
  }
};
const server = createServer(handle);
// Export the real HTTP responses for Swift decoding tests without launching a renderer.
if (process.argv.includes('--dump')) {
  const request = routeFetch(async (req, res) => {
    await handle(req, res);
  });
  try {
    const paths = {
      task: '/api/tasks/welcome',
      diff: '/api/tasks/welcome/diff',
      chat: `${api}/review?item=${encodeURIComponent(chat.item.id)}`,
      chatEncoded: `${api.replace('deploy-local', 'deploy%2Dlocal')}/review?item=${encodeURIComponent(chat.item.id)}`,
      sent: `${api}/review?item=${encodeURIComponent(sent.item.id)}`,
      inbox: '/api/inbox',
      sentTask: '/api/tasks/agents',
    };
    const responses = Object.fromEntries(
      await Promise.all(
        Object.entries(paths).map(async ([key, path]) => [
          key,
          await (await request(`${origin}${path}`)).json(),
        ]),
      ),
    );
    console.log(JSON.stringify(responses));
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
} else {
  server.listen(5194, '127.0.0.1', () =>
    console.log(`Fixture: ${origin}/fixture (temporary data: ${root})`),
  );
}
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
    void browser?.then((b) => b.close());
    rmSync(root, { recursive: true, force: true });
  });
