import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-design-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { gitText } = await import('../workspace/repository-git.ts');
const { v2Api } = await import('./api.ts');
const { askPrompt } = await import('./design.ts');
const server = createServer(async (req, res) => {
  await v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'alice') }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

const repo = join(root, 'source');
mkdirSync(join(repo, 'design/boards'), { recursive: true });
mkdirSync(join(repo, 'design/ds/deploy-local'), { recursive: true });
const git = (args: string[]) => gitText(repo, args);
await git(['init', '--initial-branch=main']);
await git(['config', 'user.name', 'Design Test']);
await git(['config', 'user.email', 'test@example.invalid']);
writeFileSync(
  join(repo, 'design/canvas.json'),
  JSON.stringify({
    title: 'Test',
    boards: { 'Welcome.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Welcome' } },
    order: ['Welcome.html'],
    notes: {},
  }),
);
writeFileSync(
  join(repo, 'design/boards/Welcome.html'),
  '<!doctype html><html><head><link rel="stylesheet" href="../ds/deploy-local/tokens.css"></head><body><div data-layer="greeting"><h1 data-layer="title" class="dl-title">Welcome to deploy.local</h1></div></body></html>',
);
writeFileSync(join(repo, 'design/ds/deploy-local/tokens.css'), ':root{--ink:#18181b}');
await git(['add', '.']);
await git(['commit', '-m', 'Add the design']);
const main = await git(['rev-parse', 'HEAD']);
save('project', 'alice', { id: 'site', repositoryPath: repo, repositoryStatus: 'ready' });

const call = (path: string, init: RequestInit & { owner?: string } = {}) =>
  fetch(`${origin}/api/v2/projects/site/design${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-test-owner': init.owner ?? 'alice',
      ...(init.headers ?? {}),
    },
  });

test('the canvas reads from main, a design branch, or nothing at all', async () => {
  const body = await (await call('')).json();
  assert.equal(body.commit, main);
  assert.equal(body.canvas.boards['Welcome.html'].title, 'Welcome');
  assert.deepEqual(body.branches, []);
  assert.equal((await call('?ref=missing-branch')).status, 404);
  assert.equal((await call('?ref=--upload-pack=x')).status, 400);
  assert.equal((await call('', { owner: 'mallory' })).status, 404);
});

test('board files are served per commit, sandboxed, and only from design/', async () => {
  const board = await call(`/files/${main}/boards/Welcome.html`);
  assert.equal(board.status, 200);
  assert.match(board.headers.get('content-type')!, /text\/html/);
  const policy = board.headers.get('content-security-policy')!;
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /sandbox allow-same-origin/);
  assert.ok(!/script-src/.test(policy));
  assert.match(await board.text(), /data-layer="title"/);
  const css = await call(`/files/${main}/ds/deploy-local/tokens.css`);
  assert.equal(await css.text(), ':root{--ink:#18181b}');
  for (const path of [
    `/files/${main}/boards/../canvas.json`,
    `/files/${main}/boards/Missing.html`,
    `/files/${main}/boards/run.sh`,
    `/files/main/boards/Welcome.html`,
  ])
    assert.equal((await call(path)).status, 404, path);
});

test('design branches get unique names and become readable refs', async () => {
  const first = await call('/branches', {
    method: 'POST',
    body: JSON.stringify({ name: 'Title size!' }),
  });
  assert.equal(first.status, 201);
  assert.deepEqual((await first.json()).branch, { name: 'design/title-size', commit: main });
  const second = await call('/branches', {
    method: 'POST',
    body: JSON.stringify({ name: 'title size' }),
  });
  assert.equal((await second.json()).branch.name, 'design/title-size-2');
  const listed = await (await call('')).json();
  assert.deepEqual(listed.branches.map((branch: any) => branch.name).sort(), [
    'design/title-size',
    'design/title-size-2',
  ]);
  assert.equal((await (await call('?ref=design/title-size')).json()).commit, main);
  assert.equal(
    (await call('/branches', { method: 'POST', body: JSON.stringify({ name: '!!!' }) })).status,
    400,
  );
});

test('comments attach to a board or a layer and can be resolved', async () => {
  const created = await call('/comments', {
    method: 'POST',
    body: JSON.stringify({ board: 'Welcome.html', layer: 'title', text: 'Bigger?', commit: main }),
  });
  assert.equal(created.status, 201);
  const { comment } = await created.json();
  assert.equal(comment.layer, 'title');
  assert.equal(comment.resolved, false);
  await call('/comments', {
    method: 'POST',
    body: JSON.stringify({ board: 'Other.html', text: 'Elsewhere' }),
  });
  const onWelcome = await (await call('/comments?board=Welcome.html')).json();
  assert.deepEqual(
    onWelcome.comments.map((row: any) => row.text),
    ['Bigger?'],
  );
  const resolved = await call(`/comments/${comment.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved: true }),
  });
  assert.equal((await resolved.json()).comment.resolved, true);
  assert.equal((await (await call('')).json()).openComments, 1);
  for (const body of [
    { board: '../x.html', text: 'a' },
    { board: 'Welcome.html', layer: 'Bad Layer', text: 'a' },
    { board: 'Welcome.html', text: '   ' },
  ])
    assert.equal(
      (await call('/comments', { method: 'POST', body: JSON.stringify(body) })).status,
      400,
    );
});

test('asking an agent checks the layer and gives it the element and the rules', async () => {
  const missing = await call('/ask', {
    method: 'POST',
    body: JSON.stringify({ board: 'Welcome.html', layer: 'nope', text: 'Bigger' }),
  });
  assert.equal(missing.status, 404);
  const prompt = askPrompt({
    board: 'Welcome.html',
    layer: 'title',
    text: 'Make the title bigger',
    ref: 'HEAD',
    commit: main,
    snippet: '<h1 data-layer="title">Welcome</h1>',
    openComments: ['Bigger?'],
  });
  assert.match(prompt, /layer `title` on the board `design\/boards\/Welcome.html`/);
  assert.match(prompt, /<h1 data-layer="title">Welcome<\/h1>/);
  assert.match(prompt, /- Bigger\?/);
  assert.match(prompt, /Keep every existing data-layer ID/);
  assert.match(prompt, /design\/tools\/render\.mjs/);
});

test('boards render to PNG at a commit when Chromium is installed', async (t) => {
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium is not installed');
  const png = await call(`/render?board=Welcome.html&width=700&ref=${main}`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 700);
  assert.equal((await call('/render?board=Missing.html')).status, 404);
});

test('a task’s design reads from the branch it commits to, or its base before it commits', async () => {
  save('task', 'alice', { id: 'ab12cd34-0000', projectId: 'site', baseRevision: main });
  assert.equal((await (await call('?task=ab12cd34-0000')).json()).commit, main);
  writeFileSync(
    join(repo, 'design/boards/Welcome.html'),
    '<!doctype html><html><body><h1 data-layer="title" style="font-size:30px">Welcome</h1></body></html>',
  );
  await git(['commit', '-am', 'Bigger title']);
  const agent = await git(['rev-parse', 'HEAD']);
  await git(['branch', 'task/ab12cd34', agent]);
  await git(['reset', '--hard', main]);
  const overlay = await (await call('?task=ab12cd34-0000')).json();
  assert.equal(overlay.commit, agent);
  assert.match(await (await call(`/files/${agent}/boards/Welcome.html`)).text(), /font-size:30px/);
  save('task', 'alice', { id: 'other-task', projectId: 'elsewhere', baseRevision: main });
  assert.equal((await call('?task=other-task')).status, 404);
});
