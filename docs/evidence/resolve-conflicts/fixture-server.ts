// Synthetic repository and database only; never opens the owner's data or starts a worker.
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
  throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
const port = Number(process.env.PORT ?? 5182);
if (!Number.isInteger(port) || port < 5180 || port > 5199)
  throw new Error('Use a port from 5180 to 5199');
const root = mkdtempSync(join(tmpdir(), 'resolve-conflicts-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, list, get, remove } = await import('../../../server/workspace/store.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { proposeDesign, designReview, startDesignApprovals } =
  await import('../../../server/features/design/design.ts');
const owner = 'resolve-conflicts-fixture';
const repo = join(root, 'repository');
mkdirSync(join(repo, 'design/boards'), { recursive: true });
cpSync(resolve('design/ds'), join(repo, 'design/ds'), { recursive: true });
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '--initial-branch=main');
git('config', 'user.name', 'Review fixture');
git('config', 'user.email', 'fixture@example.invalid');
// The screen every fixture board shows: a project's Repository page, kept beside this file so the
// fixture does not depend on a board staying in design/.
const screen = readFileSync(join(import.meta.dirname, 'screen.html'), 'utf8')
  .trim()
  .replace('class="dl-rv-screen "', 'class="fixture-screen"')
  .replace('data-layer="home-gym"', 'data-layer="home-gym" data-name="header row"')
  .replace(
    'data-layer="no-remote-recipes"',
    'data-layer="no-remote-recipes" data-name="release list"',
  );
const html = (body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="design-board" content="width=1440,height=900"><link rel="stylesheet" href="../ds/deploy-local/tokens.css"><link rel="stylesheet" href="../ds/deploy-local/components/bundle.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap"><style>body{margin:0;background:var(--paper)}.fixture-screen{height:100vh;display:flex;flex-direction:column}.dl-rv-change::after{display:none}</style></head><body>${body}</body></html>`;
const files = [
  'ProjectOverview.html',
  'ProjectSettings.html',
  ...Array.from({ length: 26 }, (_, i) => `Project${i + 1}.html`),
];
const write = (file: string, body: string) =>
  writeFileSync(join(repo, 'design/boards', file), html(body));
const boards = Object.fromEntries(
  files.map((file, i) => [
    file,
    {
      title: i === 0 ? 'Project overview' : i === 1 ? 'Project settings' : `Project ${i - 1}`,
      x: i * 1600,
      y: 0,
      w: 1440,
      h: 900,
    },
  ]),
);
writeFileSync(
  join(repo, 'design/canvas.json'),
  JSON.stringify({ title: 'Tally', boards, order: files, notes: {} }),
);
for (const file of files) write(file, screen.replace('>home-gym</span>', '>Project</span>'));
git('add', '.');
git('commit', '-qm', 'Base screens');
const base = git('rev-parse', 'HEAD');
git('checkout', '-qb', 'design/project-back');
for (const [i, file] of files.entries()) {
  const title =
    i < 2
      ? 'home-gym'
      : ['home-gym', 'home-gym › Activity', 'home-gym › Settings', 'home-gym › Releases'][i % 4];
  const body = screen.replace('>home-gym</span>', `>${title}</span>`);
  write(file, body);
}
git('add', '.');
git('commit', '-qm', 'A way back from a project');
const proposal = git('rev-parse', 'HEAD');
git('checkout', '-q', 'main');
write(
  files[0],
  screen
    .replace('>home-gym</span>', '>Project</span>')
    .replace('No remote · recipes', 'Latest release · recipes'),
);
write(files[1], screen.replace('>home-gym</span>', '>home-gym › Settings</span>'));
git('add', '.');
git('commit', '-qm', 'Main changes the release list and header');
const main = git('rev-parse', 'HEAD');
const project = { id: 'tally', name: 'Tally', repositoryPath: repo, repositoryStatus: 'ready' };
save('project', owner, project);
save('agent', owner, { id: 'designer', name: 'Designer', job: 'Design the app', computers: [] });
let itemId = '';
async function seed(state: string) {
  if (!['unresolved', 'resolved', 'owner'].includes(state))
    throw new Error('Unknown fixture state');
  for (const kind of [
    'v2-inbox-native',
    'v2-inbox-answer',
    'design-review-seen',
    'design-review-feedback',
    'design-review-landing',
    'task',
    'run',
  ])
    for (const row of list(kind, owner)) remove(kind, owner, row.id);
  git('update-ref', 'refs/heads/main', main);
  save('task', owner, {
    id: 'design-task',
    projectId: project.id,
    title: 'A way back from a project',
    agentId: 'designer',
    status: 'running',
    branch: 'design/project-back',
    baseRevision: base,
  });
  save('run', owner, { id: 'design-run', taskId: 'design-task', status: 'running' });
  const item = await proposeDesign(owner, project, {
    ref: 'design/project-back',
    title: 'A way back from a project',
    summary:
      'Project pages get a breadcrumb back to Projects, and on iPhone a project opens as its own page.',
  });
  const row = get('v2-inbox-native', owner, item.id);
  row.item.createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  row.context.proposer =
    state === 'owner'
      ? { id: null, name: 'You', avatar: null }
      : { id: 'designer', name: 'Designer', avatar: null };
  if (state !== 'owner') {
    row.context.taskId = 'design-task';
    row.item.taskId = 'design-task';
    row.item.from = 'designer';
  } else {
    remove('task', owner, 'design-task');
    remove('run', owner, 'design-run');
  }
  if (state === 'resolved')
    row.context.choices = { 'ProjectSettings.html': { choice: 'proposal', main, proposal } };
  save('v2-inbox-native', owner, row);
  itemId = item.id;
  const review = await designReview(owner, project, row);
  assert.equal(review.resolutions?.length, 2);
  assert.deepEqual(
    review.resolutions?.map((part) => part.kind),
    ['kept-both', 'same-part'],
  );
  assert.equal(review.stale, state !== 'resolved');
  assert.equal(review.boards.length, 28);
  assert.ok(review.boards.every((board) => board.file in boards));
  if (state === 'owner') assert.equal(review.item.taskId, undefined);
  return review;
}
await seed('unresolved');
const vite = await createVite({
  configFile: false,
  cacheDir: join(root, 'vite'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/board-parity/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const handler: RequestListener = async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${port}`);
  const send = (body: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === '/__fixture') {
      await seed(url.searchParams.get('state') ?? 'unresolved');
      res.writeHead(302, { location: `/dashboard/inbox?item=${encodeURIComponent(itemId)}` });
      res.end();
      return;
    }
    if (url.pathname === '/api/state')
      return send({
        version: 1,
        cursor: 1,
        projects: list('project', owner),
        tasks: list('task', owner),
        workers: [],
        runs: list('run', owner),
        adapters: [],
      });
    if (url.pathname === '/api/user') return send({ username: owner, role: 'admin' });
    if (url.pathname === '/api/nodes')
      return send({ nodes: [{ id: 'local', name: 'SER', online: true }] });
    if (url.pathname === '/api/auth/account')
      return send({ username: owner, welcomed: true, firstTaskSeen: true, passkeyOffered: true });
    if (url.pathname === '/api/activity-events')
      return send({ events: [], cursor: 0, supportsWait: false });
    if (url.pathname.startsWith('/api/')) {
      await v2Api(req, res, () => ({ username: owner }));
      if (res.writableEnded || res.headersSent) return;
    }
    if (url.pathname.startsWith('/api/')) return send({});
    if (url.pathname.startsWith('/dashboard')) {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        await vite.transformIndexHtml(
          url.pathname,
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/docs/evidence/review-surface-build/fixture.client.tsx"></script></body></html>',
        ),
      );
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  } catch (error) {
    if (!res.headersSent) send({ error: String(error) }, 500);
    else res.end();
  }
};
const stopApprovals = process.env.DEPLOY_TEST_NO_LISTEN === '1' ? () => {} : startDesignApprovals();
const server = createServer(handler);
if (process.env.DEPLOY_TEST_NO_LISTEN !== '1')
  server.listen(port, '127.0.0.1', () =>
    console.log(`Fixture: http://127.0.0.1:${port}/__fixture?state=unresolved\nTest data: ${root}`),
  );
process.on('SIGINT', () => {
  stopApprovals();
  server.close();
  void vite.close().then(() => process.exit());
});
if (process.env.DEPLOY_TEST_NO_LISTEN === '1') {
  for (const state of ['unresolved', 'resolved', 'owner']) {
    let status = 0;
    const request = Object.assign(Readable.from([]), {
      method: 'GET',
      url: `/__fixture?state=${state}`,
      headers: {},
    });
    const response = {
      writeHead(code: number, headers: Record<string, string>) {
        status = code;
        assert.ok(headers.location.startsWith('/dashboard/inbox?item='));
      },
      end() {},
    };
    await handler(
      request as unknown as import('node:http').IncomingMessage,
      response as unknown as import('node:http').ServerResponse,
    );
    assert.equal(status, 302);
  }
  await vite.transformRequest('/docs/evidence/review-surface-build/fixture.client.tsx');
  console.log(
    'Fixture self-test: 3 states, 28 canvas boards, 3 review redirects and client transform passed.',
  );
  await vite.close();
  db.close();
}
