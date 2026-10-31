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
  const changes = await (await call('/changes?task=ab12cd34-0000')).json();
  assert.equal(changes.base, main);
  assert.deepEqual(changes.files, [
    {
      status: 'changed',
      path: 'design/boards/Welcome.html',
      layers: [
        {
          layer: 'title',
          change: 'changed',
          details: [
            'Text “Welcome to deploy.local” → “Welcome”',
            'font-size 30px',
            'Class −dl-title',
          ],
        },
        { layer: 'greeting', change: 'removed', details: [] },
      ],
    },
  ]);
  assert.deepEqual((await (await call('/changes')).json()).files, []);
  assert.match(await (await call(`/files/${agent}/boards/Welcome.html`)).text(), /font-size:30px/);
  save('task', 'alice', { id: 'other-task', projectId: 'elsewhere', baseRevision: main });
  assert.equal((await call('?task=other-task')).status, 404);
});

test('accepting an agent’s changes puts them on a design branch, never straight on main', async () => {
  save('task', 'alice', {
    id: 'ee11ff22-0000',
    projectId: 'site',
    title: 'Design: Welcome › title',
    baseRevision: main,
    createdAt: new Date().toISOString(),
    design: { board: 'Welcome.html', layer: 'title', ref: 'HEAD', commit: main, text: 'Bigger' },
  });
  assert.equal(
    (await call('/accept', { method: 'POST', body: JSON.stringify({ task: 'ee11ff22-0000' }) }))
      .status,
    409,
  );
  writeFileSync(join(repo, 'design/boards/Welcome.html'), '<h1 data-layer="title">Big</h1>');
  writeFileSync(join(repo, 'design/boards/New.html'), '<p data-layer="p">New</p>');
  await git(['add', '.']);
  await git(['commit', '-m', 'Agent work']);
  await git(['branch', 'task/ee11ff22', 'HEAD']);
  await git(['reset', '--hard', main]);

  const asks = await (await call('/asks')).json();
  assert.equal(asks.asks[0].id, 'ee11ff22-0000');
  assert.equal(asks.asks[0].text, 'Bigger');

  const partial = await call('/accept', {
    method: 'POST',
    body: JSON.stringify({ task: 'ee11ff22-0000', paths: ['design/boards/New.html'] }),
  });
  assert.equal(partial.status, 200);
  const first = await partial.json();
  assert.equal(first.branch, 'design/welcome-title');
  assert.deepEqual(first.accepted, ['design/boards/New.html']);
  assert.equal(
    await git(['show', `${first.commit}:design/boards/New.html`]),
    '<p data-layer="p">New</p>',
  );
  assert.match(
    await git(['show', `${first.commit}:design/boards/Welcome.html`]),
    /Welcome to deploy\.local/,
  );
  assert.equal(await git(['rev-parse', 'main']), main);

  const rest = await (
    await call('/accept', {
      method: 'POST',
      body: JSON.stringify({ task: 'ee11ff22-0000', into: first.branch }),
    })
  ).json();
  assert.equal(rest.branch, 'design/welcome-title');
  assert.equal(
    await git(['show', `${rest.commit}:design/boards/Welcome.html`]),
    '<h1 data-layer="title">Big</h1>',
  );
  assert.equal(await git(['rev-parse', `${rest.commit}^`]), first.commit);
  assert.equal(
    (
      await call('/accept', {
        method: 'POST',
        body: JSON.stringify({ task: 'ee11ff22-0000', paths: ['README.md'] }),
      })
    ).status,
    400,
  );
});

test('proposing asks in Waiting on you; approving puts the design on main, asking for changes notes it', async () => {
  const { answerInbox, syncInbox } = await import('./inbox.ts');
  assert.equal(
    (await call('/propose', { method: 'POST', body: JSON.stringify({ ref: 'main' }) })).status,
    400,
  );
  const proposed = await call('/propose', {
    method: 'POST',
    body: JSON.stringify({ ref: 'design/welcome-title' }),
  });
  assert.equal(proposed.status, 201);
  const { item } = await proposed.json();
  assert.equal(item.kind, 'other');
  assert.match(item.title, /^Approve the .+ design\?$/);
  assert.deepEqual(
    item.actions.map((action: any) => action.id),
    ['approve', 'changes'],
  );
  const listed = (await (await call('/proposals')).json()).proposals[0];
  assert.equal(listed.id, item.id);
  assert.equal(listed.branch, 'design/welcome-title');
  assert.deepEqual(listed.boards.sort(), ['New.html', 'Welcome.html']);
  // Proposing the same commit again returns the same request.
  const again = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({ ref: 'design/welcome-title' }),
    })
  ).json();
  assert.equal(again.item.id, item.id);

  const before = await git(['rev-parse', 'main']);
  answerInbox('alice', item.id, { actionId: 'approve', on: 'web' });
  const approved = await git(['rev-parse', 'main']);
  assert.notEqual(approved, before);
  assert.equal(await git(['rev-parse', `${approved}^`]), before);
  assert.equal(
    await git(['show', 'main:design/boards/Welcome.html']),
    '<h1 data-layer="title">Big</h1>',
  );
  assert.equal(await git(['show', 'main:design/boards/New.html']), '<p data-layer="p">New</p>');
  assert.equal(syncInbox('alice').find((entry) => entry.id === item.id)!.state, 'answered');

  // A task's design asks for changes: the note lands on its first changed board.
  // Approving moved main under the checked-out tree; work on a scratch branch from it.
  await git(['checkout', '-q', '-f', '-B', 'scratch', 'main']);
  writeFileSync(join(repo, 'design/boards/Welcome.html'), '<h1 data-layer="title">Huge</h1>');
  await git(['commit', '-qam', 'Huge']);
  await git(['branch', '-f', 'task/ab12cd34', 'HEAD']);
  await git(['checkout', '-q', '-f', 'main']);
  const forTask = await (
    await call('/propose', { method: 'POST', body: JSON.stringify({ task: 'ab12cd34-0000' }) })
  ).json();
  assert.equal(forTask.item.taskId, 'ab12cd34-0000');
  answerInbox('alice', forTask.item.id, { actionId: 'changes', on: 'web', note: 'Too big now' });
  const notes = await (await call('/comments?board=Welcome.html')).json();
  assert.ok(notes.comments.some((comment: any) => comment.text === 'Too big now'));
  assert.equal(await git(['rev-parse', 'main']), approved);
});

test('agents show where they work, comment and resolve through deploy_design', async () => {
  // Each action returns its own shape; the test reads them loosely.
  const designTool = (await import('./design.ts')).designTool as (
    scope: object,
    args: object,
  ) => any;
  const scope = { owner: 'alice', taskId: 'ab12cd34-0000' };
  save('task', 'alice', {
    id: 'ab12cd34-0000',
    projectId: 'site',
    title: 'Design: Welcome › title',
    baseRevision: main,
  });
  const here = designTool(scope, {
    action: 'presence',
    board: 'Welcome.html',
    layer: 'title',
    note: 'Making it bigger',
  });
  assert.equal(here.presence.title, 'Welcome › title');
  const live = await (await call('/presence')).json();
  assert.deepEqual(
    live.agents.map((agent: any) => [agent.taskId, agent.board, agent.layer, agent.note]),
    [['ab12cd34-0000', 'Welcome.html', 'title', 'Making it bigger']],
  );
  assert.deepEqual(
    (await (await call('/presence', { owner: 'mallory' })).json?.())?.agents ?? [],
    [],
  );
  designTool(scope, { action: 'presence' });
  assert.deepEqual((await (await call('/presence')).json()).agents, []);

  const { comment } = designTool(scope, {
    action: 'comment',
    board: 'Welcome.html',
    layer: 'title',
    text: 'Bigger now; check 390.',
  });
  assert.deepEqual(comment.agent, { taskId: 'ab12cd34-0000', title: 'Design: Welcome › title' });
  const open = designTool(scope, { action: 'comments', board: 'Welcome.html' }).comments;
  assert.ok(open.some((row: any) => row.id === comment.id));
  designTool(scope, { action: 'resolve', commentId: comment.id });
  assert.ok(
    !designTool(scope, { action: 'comments', board: 'Welcome.html' }).comments.some(
      (row: any) => row.id === comment.id,
    ),
  );
  assert.throws(() => designTool(scope, { action: 'presence', board: '../x' }), /board must be/);
  assert.throws(() => designTool(scope, { action: 'approve' }), /action must be/);
});

test('direct edits commit to a design branch, starting one from main, and refuse a stale head', async () => {
  const before = await git(['rev-parse', 'main']);
  const first = await call('/edit', {
    method: 'POST',
    body: JSON.stringify({
      ref: 'HEAD',
      board: 'Welcome.html',
      edits: [{ op: 'style', layer: 'title', prop: 'text-align', value: 'left' }],
    }),
  });
  assert.equal(first.status, 200);
  const edited = await first.json();
  assert.match(edited.branch, /^design\/welcome-edits/);
  assert.equal(await git(['rev-parse', 'main']), before);
  assert.match(
    await git(['show', `${edited.commit}:design/boards/Welcome.html`]),
    /text-align:left/,
  );
  const second = await (
    await call('/edit', {
      method: 'POST',
      body: JSON.stringify({
        ref: edited.branch,
        expect: edited.commit,
        board: 'Welcome.html',
        edits: [{ op: 'revert', layer: 'title' }],
      }),
    })
  ).json();
  assert.equal(await git(['rev-parse', `${second.commit}^`]), edited.commit);
  assert.doesNotMatch(
    await git(['show', `${second.commit}:design/boards/Welcome.html`]),
    /text-align/,
  );
  const stale = await call('/edit', {
    method: 'POST',
    body: JSON.stringify({
      ref: edited.branch,
      expect: edited.commit,
      board: 'Welcome.html',
      edits: [{ op: 'style', layer: 'title', prop: 'color', value: 'red' }],
    }),
  });
  assert.equal(stale.status, 409);
  const bad = await call('/edit', {
    method: 'POST',
    body: JSON.stringify({
      ref: edited.branch,
      board: 'Welcome.html',
      edits: [{ op: 'text', layer: 'nope', text: 'x' }],
    }),
  });
  assert.equal(bad.status, 400);
});

test('drawing adds layers to a board, and the canvas takes new boards and sticky notes', async () => {
  const drawn = await call('/edit', {
    method: 'POST',
    body: JSON.stringify({
      ref: 'HEAD',
      board: 'Welcome.html',
      edits: [{ op: 'insert', shape: { kind: 'rectangle', x: 40, y: 60, w: 200, h: 100 } }],
    }),
  });
  assert.equal(drawn.status, 200);
  const shape = await drawn.json();
  assert.equal(shape.layers.length, 1);
  assert.match(
    await git(['show', `${shape.commit}:design/boards/Welcome.html`]),
    new RegExp(`data-layer="${shape.layers[0]}" data-name="Rectangle"`),
  );
  const board = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: shape.branch, op: 'board', kind: 'phone', x: 5000, y: 100 }),
    })
  ).json();
  assert.equal(board.made, 'Board1.html');
  const canvas = JSON.parse(await git(['show', `${board.commit}:design/canvas.json`]));
  assert.deepEqual(canvas.boards['Board1.html'], {
    x: 5000,
    y: 100,
    w: 390,
    h: 844,
    title: 'Board 1',
  });
  assert.match(
    await git(['show', `${board.commit}:design/boards/Board1.html`]),
    /<meta name="design-board" content="width=390,height=844">/,
  );
  const note = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: shape.branch, op: 'note', x: 10, y: 20, text: 'Move this up?' }),
    })
  ).json();
  const edited = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: shape.branch, op: 'note', id: note.made, text: 'Move it up?' }),
    })
  ).json();
  const notes = JSON.parse(await git(['show', `${edited.commit}:design/canvas.json`])).notes;
  assert.deepEqual(notes[note.made], { x: 10, y: 20, w: 240, h: 160, text: 'Move it up?' });
  const section = await call('/canvas', {
    method: 'POST',
    body: JSON.stringify({ ref: shape.branch, op: 'remove-note', id: 'section-start' }),
  });
  assert.equal(section.status, 404);
});
