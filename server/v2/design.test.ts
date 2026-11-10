import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
const root = mkdtempSync(join(tmpdir(), 'v2-design-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { gitText } = await import('../workspace/repository-git.ts');
const { v2Api } = await import('./api.ts');
const { askPrompt, componentPrompt } = await import('./design.ts');
const server = createServer(async (req, res) => {
  await v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'alice') }));
});
const inProcess = process.env.DEPLOY_TEST_NO_LISTEN === '1';
if (!inProcess) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
const origin = inProcess
  ? 'http://test.invalid'
  : `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
// Exercise the same HTTP route handlers when the runner cannot bind a loopback socket.
const fetch = inProcess
  ? async (input: string, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(input);
      const headers = Object.fromEntries(new Headers(init.headers));
      const req = Object.assign(Readable.from(init.body ? [Buffer.from(String(init.body))] : []), {
        url: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers,
      }) as unknown as import('node:http').IncomingMessage;
      let status = 200;
      let responseHeaders: Record<string, string> = {};
      let bytes: Buffer = Buffer.alloc(0);
      const res = {
        writeHead(code: number, head: Record<string, string>) {
          status = code;
          responseHeaders = head;
        },
        end(body: string | Buffer = '') {
          bytes = Buffer.from(body);
        },
      } as unknown as import('node:http').ServerResponse;
      await v2Api(req, res, () => ({ username: headers['x-test-owner'] ?? 'alice' }));
      return new Response(new Uint8Array(bytes), { status, headers: responseHeaders });
    }
  : globalThis.fetch;
after(async () => {
  if (!inProcess) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  // Asking about a component: it must exist, and the agent gets its entry and where it is used.
  const unknown = await call('/ask', {
    method: 'POST',
    body: JSON.stringify({ component: 'nope', text: 'Rounder' }),
  });
  assert.equal(unknown.status, 404);
  const about = componentPrompt({
    component: { id: 'notice', name: 'Notice', props: [], html: '<div class="dl-banner"></div>' },
    used: ['Welcome.html'],
    text: 'Rounder corners',
    ref: 'HEAD',
    commit: main,
  });
  assert.match(
    about,
    /the Notice component \(`notice` in `design\/ds\/deploy-local\/components\/library.json`\)/,
  );
  assert.match(
    about,
    /design\/boards\/Welcome.html\. Approving this change on main renders every instance again/,
  );
  assert.match(about, /Keep its id/);
});

test('boards render to PNG at a commit when Chromium is installed', async (t) => {
  if (process.env.DEPLOY_TEST_NO_BROWSER === '1')
    return t.skip('Browser execution disabled for this test run');
  const { chromium } = await import('playwright');
  if (!existsSync(chromium.executablePath())) return t.skip('Chromium is not installed');
  const png = await call(`/render?board=Welcome.html&width=700&ref=${main}`);
  assert.equal(png.status, 200, png.ok ? 'Expected a PNG response' : await png.clone().text());
  assert.equal(png.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await png.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  assert.equal(bytes.readUInt32BE(16), 700);
  for (const scale of [2, 3]) {
    const response = await call(
      `/render?board=Welcome.html&width=700&height=900&ref=${main}&scale=${scale}`,
    );
    assert.equal(response.status, 200);
    const scaled = Buffer.from(await response.arrayBuffer());
    assert.equal(scaled.readUInt32BE(16), 700 * scale);
    assert.equal(scaled.readUInt32BE(20), 900 * scale);
  }
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
  const { answerInboxAsync: answerInbox, syncInbox } = await import('./inbox.ts');
  assert.equal(
    (
      await call('/propose', {
        method: 'POST',
        body: JSON.stringify({
          title: 'welcome title',
          summary: 'Update the design for review.',
          ref: 'main',
        }),
      })
    ).status,
    400,
  );
  const proposed = await call('/propose', {
    method: 'POST',
    body: JSON.stringify({
      title: 'welcome title',
      summary: 'Update the design for review.',
      ref: 'design/welcome-title',
    }),
  });
  assert.equal(proposed.status, 201);
  const { item } = await proposed.json();
  assert.equal(item.kind, 'other');
  assert.equal(item.title, 'welcome title');
  assert.deepEqual(
    item.actions.map((action: any) => action.id),
    ['approve', 'changes', 'update'],
  );
  const listed = (await (await call('/proposals')).json()).proposals[0];
  assert.equal(listed.id, item.id);
  assert.equal(listed.branch, 'design/welcome-title');
  assert.deepEqual(listed.boards.sort(), ['New.html', 'Welcome.html']);
  // The canvas polls this list, so it must not do a review's git work for every proposal.
  assert.equal(listed.counts, undefined);
  // Proposing the same commit again returns the same request.
  const again = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: 'design/welcome-title',
      }),
    })
  ).json();
  assert.equal(again.item.id, item.id);

  const before = await git(['rev-parse', 'main']);
  await answerInbox('alice', item.id, { actionId: 'approve', on: 'web' });
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
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        task: 'ab12cd34-0000',
      }),
    })
  ).json();
  assert.equal(forTask.item.taskId, 'ab12cd34-0000');
  save('run', 'alice', { id: 'design-feedback-run', taskId: 'ab12cd34-0000', status: 'running' });
  await answerInbox('alice', forTask.item.id, {
    actionId: 'changes',
    on: 'web',
    note: 'Too big now',
  });
  const notes = await (await call('/comments?board=Welcome.html')).json();
  assert.ok(notes.comments.some((comment: any) => comment.text === 'Too big now'));
  assert.equal(await git(['rev-parse', 'main']), approved);
});

test('approving a design that removes a board works in a bare repository', async () => {
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  const work = join(root, 'bare-source');
  mkdirSync(join(work, 'design/boards'), { recursive: true });
  const inWork = (args: string[]) => gitText(work, args);
  await inWork(['init', '--initial-branch=main']);
  await inWork(['config', 'user.name', 'Design Test']);
  await inWork(['config', 'user.email', 'test@example.invalid']);
  const canvas = (boards: string[]) =>
    JSON.stringify({
      title: 'Bare',
      boards: Object.fromEntries(
        boards.map((board) => [board, { x: 0, y: 0, w: 390, h: 844, title: board }]),
      ),
      order: boards,
      notes: {},
    });
  writeFileSync(join(work, 'design/canvas.json'), canvas(['Keep.html', 'Old.html']));
  writeFileSync(join(work, 'design/boards/Keep.html'), '<p data-layer="keep">Keep</p>');
  writeFileSync(join(work, 'design/boards/Old.html'), '<p data-layer="old">Old</p>');
  await inWork(['add', '.']);
  await inWork(['commit', '-qm', 'Two boards']);
  await inWork(['checkout', '-q', '-b', 'design/drop-old']);
  await inWork(['rm', '-q', 'design/boards/Old.html']);
  writeFileSync(join(work, 'design/canvas.json'), canvas(['Keep.html']));
  await inWork(['commit', '-qam', 'Drop Old']);
  await inWork(['checkout', '-q', 'main']);
  const bare = join(root, 'bare.git');
  await gitText(root, ['clone', '-q', '--bare', work, bare]);
  save('project', 'alice', { id: 'bare-site', repositoryPath: bare, repositoryStatus: 'ready' });
  const proposed = await fetch(`${origin}/api/v2/projects/bare-site/design/propose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' },
    body: JSON.stringify({
      ref: 'design/drop-old',
      title: 'Remove the old screen',
      summary: 'Remove the unused screen.',
    }),
  });
  const proposal = await proposed.json();
  assert.equal(proposed.status, 201, JSON.stringify(proposal));
  const { item } = proposal;
  await answerInbox('alice', item.id, { actionId: 'approve', on: 'web' });
  const inBare = (args: string[]) => gitText(bare, args);
  const files = await inBare(['ls-tree', '-r', '--name-only', 'main']);
  assert.ok(files.includes('design/boards/Keep.html'));
  assert.ok(!files.includes('design/boards/Old.html'));
  assert.deepEqual(
    Object.keys(JSON.parse(await inBare(['show', 'main:design/canvas.json'])).boards),
    ['Keep.html'],
  );
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
  const here = await designTool(scope, {
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
  await designTool(scope, { action: 'presence' });
  assert.deepEqual((await (await call('/presence')).json()).agents, []);

  const { comment } = await designTool(scope, {
    action: 'comment',
    board: 'Welcome.html',
    layer: 'title',
    text: 'Bigger now; check 390.',
  });
  assert.deepEqual(comment.agent, { taskId: 'ab12cd34-0000', title: 'Design: Welcome › title' });
  const open = (await designTool(scope, { action: 'comments', board: 'Welcome.html' })).comments;
  assert.ok(open.some((row: any) => row.id === comment.id));
  await designTool(scope, { action: 'resolve', commentId: comment.id });
  assert.ok(
    !(await designTool(scope, { action: 'comments', board: 'Welcome.html' })).comments.some(
      (row: any) => row.id === comment.id,
    ),
  );
  await assert.rejects(
    () => designTool(scope, { action: 'presence', board: '../x' }),
    /board must be/,
  );
  await assert.rejects(() => designTool(scope, { action: 'approve' }), /action must be/);
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

test('the pen draws marks on the canvas, beside the boards, and they change a property at a time', async () => {
  const drawn = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'HEAD',
        op: 'mark',
        points: [
          [100, 200],
          [140, 180],
          [180, 230],
        ],
      }),
    })
  ).json();
  assert.match(drawn.made, /^mark-/);
  const edited = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({
        ref: drawn.branch,
        op: 'mark',
        id: drawn.made,
        rotate: -18,
        width: 4,
        arrow: true,
        stroke: 'accent',
      }),
    })
  ).json();
  const canvas = JSON.parse(await git(['show', `${edited.commit}:design/canvas.json`]));
  assert.deepEqual(canvas.notes[drawn.made], {
    kind: 'mark',
    x: 100,
    y: 180,
    w: 80,
    h: 50,
    pw: 80,
    ph: 50,
    path: 'M0 20 L40 0 L80 50',
    stroke: 'accent',
    width: 4,
    rotate: -18,
    arrow: true,
  });
  // A mark is not a board: drawing one changes no board.
  assert.equal(
    await git(['diff', '--name-only', 'HEAD', edited.commit, '--', 'design/boards']),
    '',
  );
  const wrong = await call('/canvas', {
    method: 'POST',
    body: JSON.stringify({ ref: drawn.branch, op: 'mark', id: drawn.made, stroke: 'red' }),
  });
  assert.equal(wrong.status, 400);
  const removed = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: drawn.branch, op: 'remove-note', id: drawn.made }),
    })
  ).json();
  const after = JSON.parse(await git(['show', `${removed.commit}:design/canvas.json`]));
  assert.equal(after.notes[drawn.made], undefined);
});

test('Assets lists the library and its use, and approving a library change updates every instance', async () => {
  const { spawnSync } = await import('node:child_process');
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  // Commit files onto a branch without touching the checkout.
  const commitFiles = (branch: string, from: string, files: Record<string, string>) => {
    const env = {
      ...process.env,
      GIT_INDEX_FILE: join(root, `index-${branch.replace(/\//g, '-')}`),
    };
    const run = (args: string[], input?: string) =>
      spawnSync('git', ['-C', repo, ...args], { env, input, encoding: 'utf8' }).stdout.trim();
    run(['read-tree', from]);
    for (const [path, content] of Object.entries(files))
      run([
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${run(['hash-object', '-w', '--stdin'], content)},${path}`,
      ]);
    const commit = run(['commit-tree', run(['write-tree']), '-p', from, '-m', `Change ${branch}`]);
    run(['update-ref', `refs/heads/${branch}`, commit]);
    return commit;
  };
  const library = (html: string) =>
    JSON.stringify({
      name: 'Test system',
      components: [{ id: 'tag', name: 'Tag', props: [{ id: 'label', default: 'Draft' }], html }],
    });
  const path = 'design/ds/deploy-local/components/library.json';
  commitFiles('main', await git(['rev-parse', 'main']), {
    [path]: library('<span class="dl-tag">{{label}}</span>'),
  });
  const placed = await (
    await call('/edit', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        board: 'Welcome.html',
        edits: [{ op: 'insert', component: { id: 'tag', props: { label: 'New' }, x: 10, y: 20 } }],
      }),
    })
  ).json();
  assert.ok(placed.commit, JSON.stringify(placed));
  assert.match(
    await git(['show', `${placed.commit}:design/boards/Welcome.html`]),
    /data-component="tag" data-name="Tag" style="position:absolute;left:10px;top:20px">New<\/span>/,
  );
  const listed = await (await call(`/components?ref=${encodeURIComponent(placed.branch)}`)).json();
  assert.equal(listed.library.components[0].name, 'Tag');
  assert.deepEqual(listed.usage, { tag: ['Welcome.html'] });
  // Put the instance on main, then approve a change to the component from another branch.
  const withInstance = commitFiles('main', await git(['rev-parse', 'main']), {
    'design/boards/Welcome.html': await git([
      'show',
      `${placed.commit}:design/boards/Welcome.html`,
    ]),
  });
  commitFiles('design/tag-style', withInstance, {
    [path]: library('<em class="dl-tag">{{label}}</em>'),
  });
  const { item } = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: 'design/tag-style',
      }),
    })
  ).json();
  await answerInbox('alice', item.id, { actionId: 'approve', on: 'web' });
  assert.match(
    await git(['show', 'main:design/boards/Welcome.html']),
    /<em data-layer="[^"]+" class="dl-tag" data-props="[^"]+" data-component="tag" data-name="Tag" style="position:absolute;left:10px;top:20px">New<\/em>/,
  );
});

test('approving one design branch keeps what another approval added to main since it started', async () => {
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  // Two branches from the same main: one adds a board, the other a note.
  const board = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', op: 'board', kind: 'phone', x: 9000, y: 9000 }),
    })
  ).json();
  const note = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', op: 'note', x: 9100, y: 9100, text: 'Kept beside it' }),
    })
  ).json();
  for (const ref of [board.branch, note.branch]) {
    const { item } = await (
      await call('/propose', {
        method: 'POST',
        body: JSON.stringify({
          title: 'welcome title',
          summary: 'Update the design for review.',
          ref,
        }),
      })
    ).json();
    await answerInbox('alice', item.id, { actionId: 'approve', on: 'web' });
  }
  const canvas = JSON.parse(await git(['show', 'main:design/canvas.json']));
  assert.ok(canvas.boards[board.made], 'the first approval’s board is still on main');
  assert.equal(canvas.notes[note.made]?.text, 'Kept beside it');
  assert.match(await git(['show', `main:design/boards/${board.made}`]), /design-board/);
});

test('approving stops when main rewrote the same lines of a board since the branch started', async () => {
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  const edit = async (text: string) =>
    (
      await call('/edit', {
        method: 'POST',
        body: JSON.stringify({
          ref: 'main',
          board: 'Welcome.html',
          edits: [{ op: 'text', layer: 'title', text }],
        }),
      })
    ).json();
  const [first, second] = [await edit('Hello there'), await edit('Hi again')];
  const propose = async (ref: string) =>
    (
      await (
        await call('/propose', {
          method: 'POST',
          body: JSON.stringify({
            title: 'welcome title',
            summary: 'Update the design for review.',
            ref,
          }),
        })
      ).json()
    ).item;
  await answerInbox('alice', (await propose(first.branch)).id, { actionId: 'approve', on: 'web' });
  const later = await propose(second.branch);
  await assert.rejects(
    () => answerInbox('alice', later.id, { actionId: 'approve', on: 'web' }),
    /conflict with main/,
  );
});

test('a layer links to a board, the links are listed per commit, and Play starts where the page says', async () => {
  const linked = await (
    await call('/edit', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'main',
        board: 'Welcome.html',
        edits: [{ op: 'link', layer: 'title', to: 'Welcome.html' }],
      }),
    })
  ).json();
  assert.match(
    await git(['show', `${linked.commit}:design/boards/Welcome.html`]),
    /data-layer="title"[^>]*href="Welcome.html"/,
  );
  const { links } = await (await call(`/links?ref=${encodeURIComponent(linked.branch)}`)).json();
  assert.deepEqual(
    links.find((link: any) => link.layer === 'title'),
    {
      from: 'Welcome.html',
      layer: 'title',
      to: 'Welcome.html',
      text: 'Hello there',
      sidebar: false,
    },
  );
  const bad = await call('/edit', {
    method: 'POST',
    body: JSON.stringify({
      ref: linked.branch,
      board: 'Welcome.html',
      edits: [{ op: 'link', layer: 'title', to: 'https://example.com' }],
    }),
  });
  assert.equal(bad.status, 400);
  const unlinked = await (
    await call('/edit', {
      method: 'POST',
      body: JSON.stringify({
        ref: linked.branch,
        board: 'Welcome.html',
        edits: [{ op: 'link', layer: 'title', to: null }],
      }),
    })
  ).json();
  assert.doesNotMatch(
    await git(['show', `${unlinked.commit}:design/boards/Welcome.html`]),
    /href=/,
  );
  const start = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({
        ref: linked.branch,
        op: 'start',
        page: 'section-start',
        board: 'Welcome.html',
      }),
    })
  ).json();
  const canvas = JSON.parse(await git(['show', `${start.commit}:design/canvas.json`]));
  assert.deepEqual(canvas.starts, { 'section-start': 'Welcome.html' });
});

test('a design review gives the apps its boards, their pages and what changed', async () => {
  const listed = (await (await call('/proposals')).json()).proposals;
  const proposal = listed.find((item: any) => item.branch === 'design/welcome-title');
  assert.ok(proposal, 'the earlier proposal is listed');
  const review = await (await call(`/review?item=${encodeURIComponent(proposal.id)}`)).json();
  assert.equal(review.item.id, proposal.id);
  assert.equal(review.branch, 'design/welcome-title');
  const welcome = review.boards.find((board: any) => board.file === 'Welcome.html');
  assert.equal(welcome.w, 1440);
  assert.ok(welcome.lines.length > 0, JSON.stringify(welcome));
  assert.equal((await call('/review?item=design:other:x:y')).status, 404);
});

test('a review of a canvas note says so in words and gives its lines before and after', async () => {
  const note = await (
    await call('/canvas', {
      method: 'POST',
      body: JSON.stringify({ ref: 'HEAD', op: 'note', x: 40, y: 40, text: 'Gutters\nKeep 16 px' }),
    })
  ).json();
  const { item } = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: note.branch,
      }),
    })
  ).json();
  assert.equal(item.text, `The note “Gutters” was added on ${note.branch}.`);
  const review = await (await call(`/review?item=${encodeURIComponent(item.id)}`)).json();
  assert.deepEqual(review.boards, []);
  assert.equal(review.notes.length, 1);
  assert.equal(review.notes[0].title, 'Gutters');
  assert.equal(review.notes[0].before, null);
  assert.deepEqual(review.notes[0].after, [
    { text: 'Gutters', added: true },
    { text: 'Keep 16 px', added: true },
  ]);
  assert.equal(review.notes[0].changed, 2);
});

test('review identifies new and removed boards and preserves the removed board dimensions', async () => {
  // Earlier tests leave edits in the working tree; set them aside for this branch.
  const stashed = (await git(['stash', 'push', '--include-untracked'])).includes('Saved');
  await git(['checkout', '-b', 'design/compare-states', 'refs/heads/main']);
  const canvas = JSON.parse(await git(['show', 'refs/heads/main:design/canvas.json']));
  canvas.boards['NewPhone.html'] = { x: 0, y: 0, w: 390, h: 844, title: 'New phone' };
  delete canvas.boards['Welcome.html'];
  canvas.order = ['NewPhone.html'];
  writeFileSync(join(repo, 'design/canvas.json'), JSON.stringify(canvas));
  rmSync(join(repo, 'design/boards/Welcome.html'));
  writeFileSync(
    join(repo, 'design/boards/NewPhone.html'),
    '<html><body><p data-layer="new">New phone</p></body></html>',
  );
  await git(['add', 'design']);
  await git(['commit', '-m', 'Replace a board']);
  // The coordinator's main is the checked-out branch.
  await git(['checkout', 'main']);
  try {
    const response = await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: 'design/compare-states',
      }),
    });
    assert.equal(response.status, 201);
    const { item } = await response.json();
    const review = await (await call(`/review?item=${encodeURIComponent(item.id)}`)).json();
    const added = review.boards.find((board: any) => board.file === 'NewPhone.html');
    const removed = review.boards.find((board: any) => board.file === 'Welcome.html');
    assert.equal(added.added, true);
    assert.equal(added.removed, false);
    assert.equal(added.w, 390);
    assert.equal(removed.added, false);
    assert.equal(removed.removed, true);
    assert.equal(removed.w, 1440);
    assert.equal(removed.h, 900);
    assert.equal(removed.title, 'Welcome');
  } finally {
    await git(['checkout', 'main']);
    if (stashed) await git(['stash', 'pop']);
  }
});

test('boards render with the deploy account’s Chromium when the service user has none', async () => {
  const { boardBrowser } = await import('./design.ts');
  const root = '/root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome';
  const user = '/home/deploy/.cache/ms-playwright/chromium-1234/chrome-linux/chrome';
  assert.equal(
    boardBrowser(root, '/home/deploy', (p) => p === root),
    root,
  );
  assert.equal(
    boardBrowser(root, '/home/deploy', (p) => p === user),
    user,
  );
  assert.equal(
    boardBrowser(root, '/home/deploy', () => false),
    null,
  );
  assert.equal(
    boardBrowser(root, undefined, () => false),
    null,
  );
});

test('a newer commit withdraws the older request and tells clients, which replay events', async () => {
  const stashed = (await git(['stash', 'push', '--include-untracked'])).includes('Saved');
  await git(['checkout', '-b', 'design/withdraw-me', 'refs/heads/main']);
  const propose = async (text: string) => {
    writeFileSync(join(repo, 'design/boards/Welcome.html'), `<p data-layer="title">${text}</p>`);
    await git(['commit', '-qam', text]);
    await git(['checkout', 'main']);
    const { item } = await (
      await call('/propose', {
        method: 'POST',
        body: JSON.stringify({
          title: 'welcome title',
          summary: 'Update the design for review.',
          ref: 'design/withdraw-me',
        }),
      })
    ).json();
    await git(['checkout', 'design/withdraw-me']);
    return item;
  };
  try {
    const first = await propose('First');
    await propose('Second');
    const announced = (
      db.prepare("SELECT payload FROM events WHERE owner='alice' AND type='v2.inbox'").all() as {
        payload: string;
      }[]
    )
      .map((row) => JSON.parse(row.payload).item)
      .filter((item: any) => item.id === first.id);
    assert.equal(announced.at(-1).state, 'withdrawn');
  } finally {
    await git(['checkout', 'main']);
    if (stashed) await git(['stash', 'pop']);
  }
});

/** Each review scenario owns its repository so main can advance without contaminating others. */
async function reviewFixture(name: string) {
  const path = join(root, name);
  mkdirSync(join(path, 'design/boards'), { recursive: true });
  const run = (args: string[]) => gitText(path, args);
  await run(['init', '--initial-branch=main']);
  await run(['config', 'user.name', 'Review Test']);
  await run(['config', 'user.email', 'review@example.invalid']);
  const canvas = {
    boards: {
      'Alpha.html': { x: 100, y: 100, w: 1440, h: 900, title: 'Agent details' },
      'Beta.html': { x: 1700, y: 100, w: 390, h: 844, title: 'Meet your agent on iPhone' },
      'Removed.html': { x: 3400, y: 100, w: 1440, h: 900, title: 'Old screen' },
      'Other.html': { x: 0, y: 2200, w: 1440, h: 900, title: 'Other screen' },
    },
    order: ['Beta.html', 'Removed.html', 'Alpha.html', 'Other.html'],
    notes: {
      'section-agents': { x: 0, y: 0, text: 'Agents and trust' },
      'section-other': { x: 0, y: 2000, text: 'Other page' },
    },
  };
  writeFileSync(join(path, 'design/canvas.json'), JSON.stringify(canvas));
  for (const file of Object.keys(canvas.boards))
    writeFileSync(join(path, 'design/boards', file), '<h1 data-layer="title">Before</h1>');
  await run(['add', '.']);
  await run(['commit', '-qm', 'Base']);
  const base = await run(['rev-parse', 'HEAD']);
  const project = { id: name, name, repositoryPath: path, repositoryStatus: 'ready' };
  save('project', 'alice', project);
  await run(['checkout', '-qb', 'design/review']);
  writeFileSync(
    join(path, 'design/boards/Alpha.html'),
    '<h1 data-layer="title" style="font-size:22px">Sources for preferences</h1>',
  );
  writeFileSync(
    join(path, 'design/boards/Beta.html'),
    '<h1 data-layer="title">Suggestions wrap</h1>',
  );
  await run(['commit', '-qam', 'Proposed']);
  const callReview = (suffix: string, body?: object, method = 'POST') =>
    fetch(
      `${origin}/api/v2/projects/${name}/design${suffix}`,
      body
        ? {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {},
    );
  const propose = async (extra: object = {}) => {
    const checkedOut = await run(['branch', '--show-current']);
    await run(['checkout', '-q', 'main']);
    const response = await callReview('/propose', {
      ref: 'design/review',
      title: 'Agents you make yourself',
      summary: 'Keep sources beside preferences and let suggestions wrap.',
      ...extra,
    });
    await run(['checkout', '-q', checkedOut]);
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    return (await response.json()).item;
  };
  const read = async (item: { id: string }) =>
    await (await callReview(`/review?item=${encodeURIComponent(item.id)}`)).json();
  const commit = async (message: string) => {
    await run(['add', '-A']);
    await run(['commit', '-qm', message]);
    return run(['rev-parse', 'HEAD']);
  };
  return { path, run, base, canvas, project, call: callReview, propose, read, commit };
}

test('review stores proposer summary and plain title, returns actual attribution and legacy null summaries', async () => {
  const f = await reviewFixture('review-summary');
  const item = await f.propose({
    summary:
      'Keep the source beside each preference. Let suggestions wrap so they can be read in full.',
  });
  const review = await f.read(item);
  assert.equal(item.title, 'Agents you make yourself');
  assert.equal(
    review.summary,
    'Keep the source beside each preference. Let suggestions wrap so they can be read in full.',
  );
  assert.equal(review.proposer.name, 'You');
  const row = (await import('../workspace/store.ts')).get('v2-inbox-native', 'alice', item.id);
  assert.equal(row.context.summary, review.summary);
  const landing = await (
    await fetch(`${origin}/api/v2/design/reviews?project=${f.project.id}`)
  ).json();
  assert.equal(landing.proposals.length, 1);
  assert.equal(landing.proposals[0].title, item.title);
  assert.deepEqual(landing.proposals[0].counts, { screens: 2, changed: 2, new: 0, removed: 0 });
  const other = await reviewFixture('review-legacy');
  const legacy = await other.propose();
  const legacyRow = (await import('../workspace/store.ts')).get(
    'v2-inbox-native',
    'alice',
    legacy.id,
  );
  save('v2-inbox-native', 'alice', {
    ...legacyRow,
    context: { ...legacyRow.context, summary: null },
  });
  assert.equal((await other.read(legacy)).summary, null);
  assert.equal(
    (await f.call('/propose', { ref: 'design/review', summary: 'x'.repeat(4001) })).status,
    400,
  );
});

test('review groups by actual canvas page and board order, interleaving changed, new and removed screens', async () => {
  const f = await reviewFixture('review-order');
  const canvas: any = f.canvas;
  delete canvas.boards['Removed.html'];
  canvas.boards['New.html'] = { x: 400, y: 100, w: 390, h: 844, title: 'Choose an avatar' };
  canvas.order = ['Beta.html', 'New.html', 'Alpha.html', 'Other.html'];
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(canvas));
  rmSync(join(f.path, 'design/boards/Removed.html'));
  writeFileSync(join(f.path, 'design/boards/New.html'), '<p data-layer="new">New</p>');
  writeFileSync(join(f.path, 'design/boards/Other.html'), '<p data-layer="other">Other</p>');
  await f.commit('New, removed and another page');
  const review = await f.read(await f.propose());
  assert.deepEqual(
    review.boards.map((b: any) => [b.file, b.status]),
    [
      ['Beta.html', 'changed'],
      ['New.html', 'new'],
      ['Removed.html', 'removed'],
      ['Alpha.html', 'changed'],
      ['Other.html', 'changed'],
    ],
  );
  assert.deepEqual(
    review.groups.map((g: any) => [g.title, g.boards.length]),
    [
      ['Agents and trust', 4],
      ['Other page', 1],
    ],
  );
  assert.equal(review.boards[2].w, 1440);
  assert.deepEqual(review.counts, { screens: 5, changed: 3, new: 1, removed: 1 });
});

async function assertReviewSummary(
  f: Awaited<ReturnType<typeof reviewFixture>>,
  item: { id: string },
) {
  const response = await fetch(`${origin}/api/v2/design/reviews?project=${f.project.id}`);
  assert.equal(response.status, 200);
  const { proposals } = await response.json();
  assert.equal(proposals.length, 1);
  const review = await f.read(item);
  assert.deepEqual(
    proposals[0],
    Object.fromEntries(Object.keys(proposals[0]).map((key) => [key, review[key]])),
  );
  return proposals[0];
}

test('review list agrees with the full review for changed, new and removed boards and conflicts', async () => {
  const f = await reviewFixture('review-list-boards');
  rmSync(join(f.path, 'design/boards/Removed.html'));
  writeFileSync(join(f.path, 'design/boards/New screen.html'), '<p>New screen</p>');
  await f.commit('Add and remove screens');
  const item = await f.propose();
  let summary = await assertReviewSummary(f, item);
  const counts = { screens: 4, changed: 2, new: 1, removed: 1 };
  assert.deepEqual(summary.counts, counts);
  assert.equal(summary.stale, false);
  assert.deepEqual(summary.conflicts, []);

  await f.run(['checkout', '-q', 'main']);
  writeFileSync(join(f.path, 'design/boards/Alpha.html'), '<p>Main changed this screen</p>');
  writeFileSync(join(f.path, 'design/boards/New screen.html'), '<p>Main added this screen</p>');
  await f.commit('Conflicting screens on main');
  summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.counts, counts);
  assert.equal(summary.stale, true);
  assert.deepEqual(summary.conflicts, ['Alpha.html', 'New screen.html']);

  writeFileSync(join(f.path, 'design/boards/New screen.html'), '<p>New screen</p>');
  await f.commit('Same new screen on main');
  summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.conflicts, ['Alpha.html']);
});

test('review list agrees with the full review for canvas placement and note conflicts', async () => {
  const f = await reviewFixture('review-list-canvas');
  const proposed = structuredClone(f.canvas);
  proposed.boards['Alpha.html'].x = 200;
  proposed.notes['section-agents'].text = 'Proposed section';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(proposed));
  await f.commit('Move a board and edit a note');
  const item = await f.propose();
  assert.equal((await assertReviewSummary(f, item)).stale, false);

  await f.run(['checkout', '-q', 'main']);
  const target = structuredClone(f.canvas);
  target.boards['Other.html'].x = 200;
  target.notes['section-other'].text = 'Unrelated section';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(target));
  await f.commit('Unrelated canvas changes on main');
  assert.equal((await assertReviewSummary(f, item)).stale, false);

  target.boards['Alpha.html'].x = 300;
  target.notes['section-agents'].text = 'Main section';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(target));
  await f.commit('Conflicting canvas changes on main');
  let summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.counts, { screens: 2, changed: 2, new: 0, removed: 0 });
  assert.equal(summary.stale, true);
  assert.deepEqual(summary.conflicts, ['Alpha.html', 'note:section-agents']);

  writeFileSync(join(f.path, 'design/canvas.json'), 'invalid JSON');
  await f.commit('Invalid canvas on main');
  summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.conflicts, ['Alpha.html', 'note:section-agents']);
  rmSync(join(f.path, 'design/canvas.json'));
  await f.commit('Missing canvas on main');
  summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.conflicts, ['Alpha.html', 'note:section-agents']);
});

test('review list preserves missing commit and main check failure behavior', async () => {
  const f = await reviewFixture('review-list-failures');
  const item = await f.propose();
  const { get } = await import('../workspace/store.ts');
  const row = get('v2-inbox-native', 'alice', item.id);
  const context = { ...row.context };
  row.context.commit = '0'.repeat(40);
  save('v2-inbox-native', 'alice', row);
  const summary = await assertReviewSummary(f, item);
  assert.deepEqual(summary.counts, { screens: 2, changed: 0, new: 0, removed: 2 });
  assert.equal(summary.stale, false);

  for (const change of [{ main: 'missing-main' }, { base: '0'.repeat(40) }]) {
    row.context = { ...context, ...change };
    save('v2-inbox-native', 'alice', row);
    const landing = await fetch(`${origin}/api/v2/design/reviews?project=${f.project.id}`);
    const review = await f.call(`/review?item=${encodeURIComponent(item.id)}`);
    assert.equal(landing.status, 409);
    assert.equal(review.status, 409);
    const error = await landing.json();
    assert.deepEqual(error, await review.json());
    assert.match(JSON.stringify(error), /Main could not be checked\. Try again\./);
  }
});

test('per-width preview boxes use native coordinates and change words never expose raw diffs', async () => {
  const f = await reviewFixture('review-boxes');
  const review = await f.read(
    await f.propose({
      changeWords: { 'Alpha.html': { title: 'Keep the source beside the preference' } },
    }),
  );
  const alpha = review.boards.find((b: any) => b.file === 'Alpha.html');
  const beta = review.boards.find((b: any) => b.file === 'Beta.html');
  assert.deepEqual(alpha.lines, ['Keep the source beside the preference']);
  assert.deepEqual(beta.lines, ['Suggestions wrap']);
  assert.doesNotMatch(
    JSON.stringify([alpha.changes, beta.changes]),
    /font-size|Text |Class | added| removed|→/,
  );
  const { reviewPreview } = await import('./design.ts');
  for (const width of [1440, 700]) {
    const before = { x: width / 4, y: 100, w: 200, h: 40 },
      after = { x: width / 4, y: 108, w: 240, h: 60 };
    const preview = await reviewPreview(
      f.path,
      f.project.id,
      alpha,
      width,
      async (_repo, revision) => ({
        png: Buffer.alloc(0),
        boxes: { title: revision === review.before ? before : after },
      }),
    );
    assert.deepEqual(preview.areas, [{ layer: 'title', words: alpha.lines[0], before, after }]);
    assert.deepEqual(preview.layers, { before: { title: before }, after: { title: after } });
    assert.equal(preview.width, width);
    assert.equal(preview.crop.x, after.x - 48);
    assert.equal(preview.crop.w, after.w + 96);
    assert.match(preview.after!, new RegExp(`width=${width}`));
  }
});

test('preview payload merges changed regions for all clients and suppresses screen containers', async () => {
  const f = await reviewFixture('review-merged-areas');
  const review = await f.read(await f.propose());
  const board = review.boards.find((b: any) => b.file === 'Alpha.html');
  const { reviewPreview } = await import('./design.ts');
  for (const width of [390, 700, 1440]) {
    const boxes = {
      root: { x: 0, y: 0, w: width, h: board.h * 0.8 },
      first: { x: 10, y: 500, w: 50, h: 40 },
      last: { x: 110, y: 500, w: 50, h: 40 },
      child: { x: 20, y: 510, w: 20, h: 10 },
      bridge: { x: 68, y: 500, w: 34, h: 40 },
      separate: { x: 10, y: 600, w: 100, h: 30 },
    };
    const changes = Object.keys(boxes).map((layer) => ({ layer, words: `Words for ${layer}` }));
    const render = async (_repo: string, revision: string) => ({
      png: Buffer.alloc(0),
      boxes: Object.fromEntries(
        Object.entries(boxes).map(([layer, rect]) => [
          layer,
          { ...rect, y: rect.y + (revision === board.before || layer === 'root' ? 0 : 12) },
        ]),
      ),
    });
    const preview = await reviewPreview(f.path, f.project.id, { ...board, changes }, width, render);
    assert.deepEqual(preview.areas, [
      {
        layer: 'first',
        words: 'Words for first',
        before: { x: 10, y: 500, w: 150, h: 40 },
        after: { x: 10, y: 512, w: 150, h: 40 },
      },
      {
        layer: 'separate',
        words: 'Words for separate',
        before: boxes.separate,
        after: { ...boxes.separate, y: 612 },
      },
    ]);
    assert.equal(preview.crop.y, 512 - 48);
    // Note anchors use actual element boxes, never the coalesced outline's union.
    assert.deepEqual(preview.layers?.before.child, boxes.child);
    assert.deepEqual(preview.layers?.after.first, { ...boxes.first, y: 512 });
    // A sole container must have neither an outline nor per-area words.
    const rootOnly = await reviewPreview(
      f.path,
      f.project.id,
      { ...board, changes: [changes[0]] },
      width,
      render,
    );
    assert.deepEqual(rootOnly.areas, []);
    assert.equal(rootOnly.crop.y, 0);
  }
  const { reviewAreas } = await import('../../shared/v2/design-review.ts');
  const rect = { x: 10, y: 20, w: 50, h: 40 };
  assert.deepEqual(
    reviewAreas(
      [
        { layer: 'removed', words: 'Replace the control' },
        { layer: 'added', words: 'New control' },
        { layer: 'hidden', words: 'Hidden text' },
      ],
      { removed: rect },
      { added: rect },
      390,
      844,
    ),
    [{ layer: 'removed', words: 'Replace the control', before: rect, after: rect }],
  );
  assert.equal(
    reviewAreas(
      [
        { layer: 'a', words: 'First' },
        { layer: 'b', words: 'Separate' },
      ],
      {},
      { a: rect, b: { ...rect, x: 69 } },
      390,
      844,
    ).length,
    2,
  );
});

test('unrelated main screens update automatically; overlapping edits block both decisions atomically', async () => {
  const f = await reviewFixture('review-stale');
  const item = await f.propose();
  assert.equal((await f.read(item)).stale, false);
  await f.run(['checkout', '-q', 'main']);
  writeFileSync(join(f.path, 'design/boards/Other.html'), '<p>Changed elsewhere</p>');
  await f.commit('Other screen on main');
  let review = await f.read(item);
  assert.equal(review.stale, false);
  assert.ok(review.updatedWithMainAt);
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  writeFileSync(
    join(f.path, 'design/boards/Alpha.html'),
    '<h1 data-layer="title">Main rewrote this screen</h1>',
  );
  const main = await f.commit('Same screen');
  // No fresh GET is needed for the server to refuse a decision against stale data.
  for (const actionId of ['approve', 'changes'])
    await assert.rejects(
      () => answerInbox('alice', item.id, { actionId, on: 'web', note: 'Please adjust' }),
      /conflict with main/,
    );
  assert.equal(await f.run(['rev-parse', 'main']), main);
  review = await f.read(item);
  assert.deepEqual(review.conflicts, ['Alpha.html']);
  assert.equal(review.stale, true);
  await answerInbox('alice', item.id, { actionId: 'update', on: 'web' });
  const feedback = (await import('../workspace/store.ts')).get(
    'design-review-feedback',
    'alice',
    item.id,
  );
  assert.match(feedback.content, /rebase design\/review onto main.*propose again/);
  assert.equal((await f.read(item)).item.state, 'answered');
});

test('pins persist as board comments, edits retain positions, deletion never reuses numbers, and asking sends every open pin once', async () => {
  const f = await reviewFixture('review-pins');
  const item = await f.propose();
  const first = await f.read(item);
  const pin = (board: string, text: string) =>
    f.call('/review/pins', {
      item: item.id,
      board,
      width: board === 'Beta.html' ? 390 : 1440,
      revision: first.after,
      x: 110,
      y: 220,
      text,
    });
  const drawing = {
    side: 'after',
    nativeWidth: 1440,
    nativeHeight: 900,
    anchor: { x: 110 / 1440, y: 220 / 900 },
    weight: 3,
    strokes: [
      [
        { x: 0.1, y: 0.2 },
        { x: 0.3, y: 0.4 },
      ],
      [{ x: 0.5, y: 0.6 }],
    ],
  };
  assert.equal(
    (
      await f.call('/review/pins', {
        item: item.id,
        board: 'Alpha.html',
        width: 1440,
        revision: first.after,
        x: 110,
        y: 220,
        text: 'Keep the name visible.',
        drawing,
      })
    ).status,
    200,
  );
  await pin('Beta.html', 'Wrap this suggestion.');
  let review = await f.read(item);
  assert.deepEqual(
    review.pins.map((p: any) => p.number),
    [1, 2],
  );
  const comments = await (await f.call('/comments')).json();
  assert.equal(comments.comments.length, 2);
  assert.deepEqual(comments.comments[0].position, {
    width: 1440,
    revision: first.after,
    x: 110,
    y: 220,
    noteId: null,
  });
  await f.call(
    '/review/pins',
    { item: item.id, id: review.pins[0].id, text: 'Keep the name visible while scrolling.' },
    'PATCH',
  );
  await f.call('/review/pins', { item: item.id, id: review.pins[1].id }, 'DELETE');
  await pin('Beta.html', 'Let it wrap to two lines.');
  review = await f.read(item);
  assert.deepEqual(
    review.pins.map((p: any) => p.number),
    [1, 3],
  );
  assert.equal(review.pins[0].x, 110);
  assert.deepEqual(review.pins[0].drawing, drawing);
  assert.equal(
    (
      await f.call('/review/pins', {
        item: item.id,
        board: 'Alpha.html',
        revision: first.after,
        width: 1440,
        x: -1,
        y: 0,
        text: 'No',
      })
    ).status,
    400,
  );
  const taskId = 'review-pin-task';
  save('task', 'alice', { id: taskId, projectId: f.project.id, revision: 1 });
  save('run', 'alice', { id: 'review-pin-run', taskId, status: 'running' });
  const store = await import('../workspace/store.ts');
  const row = store.get('v2-inbox-native', 'alice', item.id);
  save('v2-inbox-native', 'alice', { ...row, context: { ...row.context, taskId } });
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  const answer = await answerInbox('alice', item.id, { actionId: 'changes', on: 'web' });
  assert.equal(answer.answer?.actionId, 'changes');
  const message = store.get('queued-message', 'alice', taskId).content;
  assert.match(message, /Pin 1.*Alpha.html/);
  assert.match(message, /Pin 3.*Beta.html/);
  assert.match(message, /Keep the name visible while scrolling\. \(drawn on the screen\)/);
  assert.equal(message.match(/Pin 1 ·/g)?.length, 1);
  assert.match(message, /Let it wrap to two lines/);
  await assert.rejects(
    () => answerInbox('alice', item.id, { actionId: 'changes', on: 'web' }),
    /already resolved/,
  );
  assert.equal(store.get('queued-message', 'alice', taskId).content, message);
});

test('seen state is owner/revision/screen scoped and round two retains only unchanged seen screens and original pins', async () => {
  const f = await reviewFixture('review-round-two');
  const item = await f.propose();
  const initial = await f.read(item);
  for (const board of initial.boards) {
    const response = await f.call('/review/seen', {
      item: item.id,
      board: board.file,
      revision: initial.after,
    });
    assert.equal(response.status, 200);
  }
  assert.ok((await f.read(item)).boards.every((board: any) => board.seen));
  assert.equal(
    (await f.call('/review/seen', { item: item.id, board: 'Alpha.html', revision: f.base })).status,
    409,
  );
  assert.equal(
    (
      await fetch(
        `${origin}/api/v2/projects/${f.project.id}/design/review?item=${encodeURIComponent(item.id)}`,
        { headers: { 'x-test-owner': 'mallory' } },
      )
    ).status,
    404,
  );
  await f.call('/review/pins', {
    item: item.id,
    board: 'Alpha.html',
    revision: initial.after,
    width: 1440,
    x: 60,
    y: 100,
    text: 'Explain the source.',
    drawing: {
      side: 'after',
      nativeWidth: 1440,
      nativeHeight: 900,
      weight: 3,
      anchor: { x: 60 / 1440, y: 100 / 900 },
      strokes: [
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      ],
    },
  });
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  await answerInbox('alice', item.id, { actionId: 'changes', on: 'web' });
  const pin = (await f.read(item)).pins[0];
  save('task', 'alice', { id: 'review-resolve-task', projectId: f.project.id });
  const { designTool } = await import('./design.ts');
  await designTool(
    { owner: 'alice', taskId: 'review-resolve-task' },
    { action: 'resolve', commentId: pin.id, reply: 'Added the source and date.' },
  );
  writeFileSync(
    join(f.path, 'design/boards/Alpha.html'),
    '<h1 data-layer="title">You told me on Tuesday</h1>',
  );
  await f.commit('Address source pin');
  const next = await f.propose({ summary: 'Added the source and date. Suggestions still wrap.' });
  const round = await f.read(next);
  assert.equal(round.round, 2);
  assert.equal(round.before, initial.after);
  assert.equal(round.previousItemId, item.id);
  assert.deepEqual(
    round.boards.filter((b: any) => b.changedSinceReview).map((b: any) => b.file),
    ['Alpha.html'],
  );
  assert.deepEqual(
    round.boards.filter((b: any) => b.seen).map((b: any) => b.file),
    ['Beta.html'],
  );
  assert.equal(round.pins[0].text, 'Explain the source.');
  assert.equal(round.pins[0].reply, 'Added the source and date.');
  assert.equal(round.pins[0].resolved, true);
  assert.equal(round.pins[0].revision, initial.after);
  assert.deepEqual(round.pins[0].drawing, pin.drawing);
  await f.call('/review/seen', { item: next.id, board: 'Alpha.html', revision: round.after });
  assert.equal((await f.read(next)).pins[0].resolved, true, 'looking does not change resolution');
  await f.call('/review/pins', { item: next.id, id: pin.id, resolved: false }, 'PATCH');
  assert.equal((await f.read(next)).pins[0].resolved, false);
  await answerInbox('alice', next.id, { actionId: 'approve', on: 'web' });
  assert.equal((await f.read(next)).pins[0].text, 'Explain the source.', 'approval keeps comments');
});

test('deploy_design propose accepts summary/title and attributes the saved agent and avatar', async () => {
  const f = await reviewFixture('review-tool');
  const taskId = 'f00dface-0000';
  await f.run(['branch', 'task/f00dface', 'HEAD']);
  await f.run(['checkout', '-q', 'main']);
  const avatar = { glyph: 'variant28', color: 'af61f2' };
  save('agent', 'alice', { id: 'review-agent', name: 'Release notes writer', avatar });
  save('task', 'alice', {
    id: taskId,
    projectId: f.project.id,
    agentId: 'review-agent',
    title: 'Update agent details',
    baseRevision: f.base,
  });
  const { designTool } = await import('./design.ts');
  const result = await designTool(
    { owner: 'alice', taskId },
    {
      action: 'propose',
      title: 'Agents you make yourself',
      summary: 'Keep sources beside preferences. Let suggestions wrap.',
    },
  );
  const review = await f.read((result as { item: { id: string } }).item);
  assert.equal(review.summary, 'Keep sources beside preferences. Let suggestions wrap.');
  assert.deepEqual(review.proposer, { id: 'review-agent', name: 'Release notes writer', avatar });
  assert.equal(review.item.from, 'review-agent');
});

test('round two sends only still-open requests and keeps addressed requests with their replies', async () => {
  const f = await reviewFixture('review-addressed');
  const item = await f.propose();
  const initial = await f.read(item);
  for (const [board, text, width] of [
    ['Alpha.html', 'Add a source.', 1440],
    ['Beta.html', 'Keep the name.', 390],
  ]) {
    assert.equal(
      (
        await f.call('/review/pins', {
          item: item.id,
          board,
          text,
          width,
          revision: initial.after,
          x: 40,
          y: 50,
        })
      ).status,
      200,
    );
  }
  const { answerInboxAsync: answerInbox } = await import('./inbox.ts');
  await answerInbox('alice', item.id, { actionId: 'changes', on: 'web' });
  const pins = (await f.read(item)).pins;
  save('task', 'alice', { id: 'addressed-task', projectId: f.project.id });
  const { designTool } = await import('./design.ts');
  await designTool(
    { owner: 'alice', taskId: 'addressed-task' },
    {
      action: 'resolve',
      commentId: pins[0].id,
      reply: 'The source is now next to the preference.',
    },
  );
  writeFileSync(
    join(f.path, 'design/boards/Alpha.html'),
    '<h1 data-layer="title">The source and date</h1>',
  );
  await f.commit('Added the source');
  const next = await f.propose();
  await answerInbox('alice', next.id, { actionId: 'changes', on: 'web' });
  const feedback = (await import('../workspace/store.ts')).get(
    'design-review-feedback',
    'alice',
    next.id,
  );
  assert.deepEqual(feedback.pins, [pins[1].id]);
  assert.doesNotMatch(feedback.content, /Add a source/);
  assert.match(feedback.content, /Keep the name/);
  assert.equal((await f.read(next)).pins[0].reply, 'The source is now next to the preference.');
});

test('review preview density defaults to 1, preserves CSS geometry and separates render caches', async () => {
  const f = await reviewFixture('review-density');
  const item = await f.propose();
  const review = await f.read(item);
  const board = review.boards.find((b: any) => b.file === 'Alpha.html');
  const { reviewPreview, renderBoardLayout, previewScale } = await import('./design.ts');
  assert.equal(previewScale(new URL('https://test.invalid')), 1);
  const calls: number[] = [];
  const draw = async (
    _repo: string,
    _commit: string,
    _board: string,
    width: number,
    height = 900,
    scale = 1,
  ) => {
    calls.push(scale);
    return {
      png: Buffer.from(`${width * scale}x${height * scale}`),
      boxes: { title: { x: 30, y: 40, w: 240, h: 60 } },
    };
  };
  const render: typeof renderBoardLayout = (repo, commit, file, width, height, scale) =>
    renderBoardLayout(repo, commit, file, width, height, scale, draw);
  const baseline = await reviewPreview(f.path, f.project.id, board, 1440, render);
  assert.match(baseline.after!, /scale=1$/);
  const defaultResponse = await f.call(
    `/review/preview?item=${encodeURIComponent(item.id)}&board=Alpha.html&width=1440`,
  );
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(await defaultResponse.json(), baseline);
  for (const scale of [1, 2, 3, 1.5]) {
    const previews = await Promise.all(
      [0, 1].map(() => reviewPreview(f.path, f.project.id, board, 1440, render, scale)),
    );
    for (const preview of previews) {
      assert.deepEqual(preview.areas, baseline.areas);
      assert.deepEqual(preview.crop, baseline.crop);
      assert.equal(preview.width, 1440);
      assert.equal(preview.height, 900);
      assert.equal(new URL(preview.after!, origin).searchParams.get('scale'), String(scale));
      assert.equal(new URL(preview.before!, origin).searchParams.get('scale'), String(scale));
    }
    const png = (await render(f.path, board.after, board.file, 1440, 900, scale)).png;
    assert.equal(png.toString(), `${1440 * scale}x${900 * scale}`);
    assert.equal(
      calls.filter((value) => value === scale).length,
      2,
      'one render per revision and density, including concurrent requests',
    );
    // Exercise the actual HTTP handlers against those cached renders without a browser/socket.
    const response = await f.call(
      `/review/preview?item=${encodeURIComponent(item.id)}&board=Alpha.html&width=1440&scale=${scale}`,
    );
    assert.equal(response.status, 200);
    const metadata = await response.json();
    assert.deepEqual(metadata, previews[0]);
    const image = await fetch(new URL(metadata.after!, origin).href);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), `${1440 * scale}x${900 * scale}`);
  }
  for (const scale of ['0', '4', '-1', 'NaN', 'Infinity', '']) {
    const response = await f.call(
      `/review/preview?item=${encodeURIComponent(item.id)}&board=Alpha.html&width=1440&scale=${scale}`,
    );
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Scale must be 1 to 3/);
    assert.equal(
      (await f.call(`/render?ref=${board.after}&board=Alpha.html&width=1440&scale=${scale}`))
        .status,
      400,
    );
  }
});

test('drawing pins validate native coordinates, side, dimensions and bounded paths; edits preserve association', async () => {
  const f = await reviewFixture('review-drawings');
  const item = await f.propose(),
    review = await f.read(item);
  const drawing = {
    side: 'before',
    nativeWidth: 390,
    nativeHeight: 844,
    anchor: { x: 0.5, y: 0.5 },
    weight: 3,
    strokes: [
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
    ],
  };
  const body = {
    item: item.id,
    board: 'Beta.html',
    width: 390,
    revision: review.before,
    x: 195,
    y: 422,
    text: 'Keep this.',
    drawing,
  };
  for (const invalid of [
    null,
    {},
    { ...drawing, side: 'after' },
    { ...drawing, weight: 0 },
    { ...drawing, nativeWidth: 700 },
    { ...drawing, nativeHeight: 900 },
    { ...drawing, anchor: { x: 0, y: 0 } },
    { ...drawing, strokes: [] },
    { ...drawing, strokes: [[]] },
    { ...drawing, strokes: [[{ x: -0.1, y: 0 }]] },
    { ...drawing, strokes: [[{ x: 0, y: 1.1 }]] },
    { ...drawing, strokes: [[{ x: '0.5', y: 0 }]] },
    { ...drawing, strokes: [[{ x: null, y: 0 }]] },
    { ...drawing, strokes: Array.from({ length: 129 }, () => [{ x: 0, y: 0 }]) },
    { ...drawing, strokes: [Array.from({ length: 4097 }, () => ({ x: 0, y: 0 }))] },
    {
      ...drawing,
      strokes: Array.from({ length: 5 }, () =>
        Array.from({ length: 4096 }, () => ({ x: 0, y: 0 })),
      ),
    },
  ])
    assert.equal((await f.call('/review/pins', { ...body, drawing: invalid })).status, 400);
  assert.equal((await f.read(item)).pins.length, 0);
  assert.equal((await f.call('/review/pins', body)).status, 200);
  const pin = (await f.read(item)).pins[0];
  assert.deepEqual(pin.drawing, drawing);
  assert.equal(pin.number, 1);
  assert.equal(
    (
      await f.call(
        '/review/pins',
        { item: item.id, id: pin.id, drawing: { ...drawing, side: 'after' } },
        'PATCH',
      )
    ).status,
    400,
  );
  await f.call(
    '/review/pins',
    { item: item.id, id: pin.id, text: 'Keep all of this.', resolved: true },
    'PATCH',
  );
  const edited = (await f.read(item)).pins[0];
  assert.deepEqual(edited.drawing, drawing);
  assert.equal(edited.revision, review.before);
  assert.equal(edited.resolved, true);
  await f.call('/review/pins', { item: item.id, id: pin.id }, 'DELETE');
  assert.equal((await f.read(item)).pins.length, 0);
  const maximum = {
    ...drawing,
    strokes: Array.from({ length: 128 }, () =>
      Array.from({ length: 128 }, () => ({ x: 0.5, y: 0.5 })),
    ),
  };
  assert.equal((await f.call('/review/pins', { ...body, drawing: maximum })).status, 200);
  assert.deepEqual((await f.read(item)).pins[0].drawing, maximum);
});

// Git is awaited, so requests overlap; these would lose work or fail without the repository lock.
test('concurrent edits to one branch all land, one on top of the other', async () => {
  const branch = (
    await (await call('/branches', { method: 'POST', body: '{"name":"racing"}' })).json()
  ).branch.name as string;
  const start = await git(['rev-parse', branch]);
  const post = (path: string, body: object) =>
    call(path, {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: branch,
        ...body,
      }),
    });
  const responses = await Promise.all([
    ...['one', 'two', 'three'].map((text) =>
      post('/canvas', { op: 'note', x: 0, y: 0, text: `Note ${text}` }),
    ),
    ...['first', 'second'].map((value) =>
      post('/canvas', { op: 'board', x: 0, y: 0, kind: value === 'first' ? 'phone' : 'web' }),
    ),
    ...['one', 'two'].map((text) =>
      post('/canvas', { op: 'note', x: 1, y: 1, text: `Later ${text}` }),
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200, 200, 200, 200],
  );
  const commits = await Promise.all(responses.map((response) => response.json()));
  // Every commit is on the branch: each was built on the one before, none replaced another.
  const history = (await git(['rev-list', `${start}..${branch}`])).split('\n');
  assert.equal(history.length, commits.length);
  for (const { commit } of commits) assert.ok(history.includes(commit));
  // And every change is in what the branch ends with.
  const canvas = JSON.parse(await git(['show', `${branch}:design/canvas.json`]));
  const notes = Object.values(canvas.notes).map((note: any) => note.text);
  for (const text of ['Note one', 'Note two', 'Note three', 'Later one', 'Later two'])
    assert.ok(notes.includes(text), text);
  const made = commits.flatMap((commit) => (/^Board/.test(commit.made) ? [commit.made] : []));
  assert.equal(new Set(made).size, 2);
  for (const board of made) {
    assert.ok(canvas.boards[board]);
    await git(['rev-parse', '--verify', `${branch}:design/boards/${board}`]);
  }

  // An edit that names the commit it was made from still sees a branch that moved under it.
  const head = await git(['rev-parse', branch]);
  const stale = await Promise.all(
    ['Big', 'Bigger'].map((text) =>
      post('/edit', {
        board: 'Welcome.html',
        expect: head,
        edits: [{ op: 'text', layer: 'title', text }],
      }),
    ),
  );
  assert.deepEqual(stale.map((response) => response.status).sort(), [200, 409]);
  assert.match(
    (await stale.find((response) => response.status === 409)!.json()).error,
    /changed since you loaded/,
  );
  assert.equal(await git(['rev-parse', `${branch}^`]), head);
});

test('branches made at the same moment get different names', async () => {
  const made = await Promise.all(
    Array.from({ length: 4 }, () =>
      call('/branches', { method: 'POST', body: JSON.stringify({ name: 'same name' }) }),
    ),
  );
  assert.deepEqual(
    made.map((response) => response.status),
    [201, 201, 201, 201],
  );
  const names = await Promise.all(
    made.map(async (response) => (await response.json()).branch.name as string),
  );
  assert.deepEqual(names.sort(), [
    'design/same-name',
    'design/same-name-2',
    'design/same-name-3',
    'design/same-name-4',
  ]);
});

test('two people approving at once make one commit on main; the other hears it was decided', async () => {
  await git(['checkout', '-q', '-f', '-B', 'scratch', 'main']);
  const onlyOnce = 'design/approved-twice';
  await git(['checkout', '-q', '-b', onlyOnce]);
  writeFileSync(join(repo, 'design/boards/Twice.html'), '<p data-layer="p">Twice</p>');
  await git(['add', '.']);
  await git(['commit', '-qm', 'Add a board']);
  await git(['checkout', '-q', '-f', 'main']);
  const { item } = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: onlyOnce,
      }),
    })
  ).json();
  const before = await git(['rev-parse', 'main']);
  const answers = await Promise.all(
    [1, 2].map(() =>
      fetch(`${origin}/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' },
        body: JSON.stringify({ actionId: 'approve', on: 'web' }),
      }),
    ),
  );
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
  assert.equal(await git(['rev-parse', 'main^']), before);
  assert.equal(await git(['show', 'main:design/boards/Twice.html']), '<p data-layer="p">Twice</p>');
});

test('a review and a proposal of the same commit can overlap its approval', async () => {
  await git(['checkout', '-q', '-f', '-B', 'scratch', 'main']);
  const name = 'design/approved-beside-edits';
  await git(['checkout', '-q', '-b', name]);
  writeFileSync(join(repo, 'design/boards/Beside.html'), '<p data-layer="p">Beside</p>');
  await git(['add', '.']);
  await git(['commit', '-qm', 'Add a board']);
  await git(['checkout', '-q', '-f', 'main']);
  const { item } = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: name,
      }),
    })
  ).json();
  // The proposal's reviewer reads while it is decided: never a half-made answer or a server error.
  const [answer, review, proposed] = await Promise.all([
    fetch(`${origin}/api/v2/inbox/${encodeURIComponent(item.id)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-owner': 'alice' },
      body: JSON.stringify({ actionId: 'approve', on: 'web' }),
    }),
    call(`/review?item=${encodeURIComponent(item.id)}`),
    // Proposing the same commit while it is decided returns the request as it stands.
    call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: name,
      }),
    }),
  ]);
  assert.equal(answer.status, 200);
  assert.equal(review.status, 200);
  assert.equal((await review.json()).boards.length, 1);
  assert.equal(proposed.status, 201);
  assert.equal(
    await git(['show', 'main:design/boards/Beside.html']),
    '<p data-layer="p">Beside</p>',
  );
});

test('pins dropped at the same moment get their own numbers', async () => {
  await git(['checkout', '-q', '-f', '-B', 'scratch', 'main']);
  const name = 'design/pinned-together';
  await git(['checkout', '-q', '-b', name]);
  writeFileSync(join(repo, 'design/boards/Welcome.html'), '<h1 data-layer="title">Pinned</h1>');
  await git(['add', '.']);
  await git(['commit', '-qm', 'Pinned']);
  await git(['checkout', '-q', '-f', 'main']);
  const { item } = await (
    await call('/propose', {
      method: 'POST',
      body: JSON.stringify({
        title: 'welcome title',
        summary: 'Update the design for review.',
        ref: name,
      }),
    })
  ).json();
  const query = `/review?item=${encodeURIComponent(item.id)}`;
  const review = await (await call(query)).json();
  const screen = review.boards[0];
  const pins = await Promise.all(
    [1, 2, 3, 4].map((n) =>
      call('/review/pins', {
        method: 'POST',
        body: JSON.stringify({
          item: item.id,
          board: screen.file,
          revision: screen.after,
          width: screen.widths[0],
          x: n,
          y: n,
          text: `Pin ${n}`,
        }),
      }),
    ),
  );
  assert.deepEqual(
    pins.map((pin) => pin.status),
    [200, 200, 200, 200],
  );
  const after = await (await call(query)).json();
  assert.deepEqual(
    after.pins.map((pin: any) => pin.number),
    [1, 2, 3, 4],
  );
});

test('web and agent proposals require both meaningful fields', async () => {
  const f = await reviewFixture('review-required');
  for (const extra of [
    {},
    { title: 'Title' },
    { summary: 'Summary' },
    { title: ' ', summary: 'Summary' },
  ]) {
    assert.equal((await f.call('/propose', { ref: 'design/review', ...extra })).status, 400);
  }
  const { proposeDesign } = await import('./design.ts');
  await assert.rejects(
    () => proposeDesign('alice', f.project, { ref: 'design/review', title: 'Title' }),
    /title and a summary/,
  );
});

test('delayed approval persists, undo restores waiting, and a fresh worker lands it once', async () => {
  const f = await reviewFixture('review-delayed');
  const item = await f.propose();
  const { answerInboxAsync } = await import('./inbox.ts');
  const { landDesignApprovals } = await import('./design.ts');
  const before = await f.run(['rev-parse', 'main']);
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'web', delay: true });
  const review = await f.read(item);
  assert.equal(review.landing.state, 'pending');
  assert.equal(await f.run(['rev-parse', 'main']), before);
  await landDesignApprovals(Date.parse(review.landing.at) - 1);
  assert.equal(await f.run(['rev-parse', 'main']), before);
  assert.equal((await f.call('/review/undo', { item: item.id })).status, 200);
  await landDesignApprovals(Date.parse(review.landing.at) + 1);
  assert.equal(await f.run(['rev-parse', 'main']), before);
  assert.equal((await f.read(item)).item.state, 'waiting');
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'web', delay: true });
  const pending = await f.read(item);
  // A new process loads only persisted records, as on a server restart.
  const { execFileSync } = await import('node:child_process');
  execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `const { landDesignApprovals } = await import('./server/v2/design.ts'); await landDesignApprovals(${Date.parse(pending.landing.at) + 1});`,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, DEPLOY_DATA_DIR: root, DEPLOY_MDNS_ADDRESS: '127.0.0.1' },
    },
  );
  const landed = await f.run(['rev-parse', 'main']);
  assert.notEqual(landed, before);
  assert.equal((await f.read(item)).landing.state, 'landed');
  await landDesignApprovals(Date.parse(pending.landing.at) + 1);
  assert.equal(await f.run(['rev-parse', 'main']), landed);
  assert.equal((await f.call('/review/undo', { item: item.id })).status, 409);
});

test('a conflict at delayed landing returns the review to waiting', async () => {
  const f = await reviewFixture('review-delayed-conflict');
  const item = await f.propose();
  const { answerInboxAsync } = await import('./inbox.ts');
  const { landDesignApprovals } = await import('./design.ts');
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'web', delay: true });
  const pending = await f.read(item);
  await f.run(['checkout', '-q', 'main']);
  writeFileSync(
    join(f.path, 'design/boards/Alpha.html'),
    '<p data-layer="other">Conflicting main</p>',
  );
  await f.commit('Change the same screen on main');
  await landDesignApprovals(Date.parse(pending.landing.at) + 1);
  const review = await f.read(item);
  assert.equal(review.item.state, 'waiting');
  assert.equal(review.landing.state, 'conflict');
});

test('a group can be seen together and anchored area notes accept a dragged width', async () => {
  const f = await reviewFixture('review-group-seen');
  const item = await f.propose();
  const review = await f.read(item);
  const boards = review.boards.map((board: any) => board.file);
  assert.equal(
    (
      await f.call('/review/seen', {
        item: item.id,
        boards: [...boards, 'Unknown.html'],
        revision: review.after,
      })
    ).status,
    409,
  );
  assert.equal(
    (await f.read(item)).boards.some((board: any) => board.seen),
    false,
  );
  assert.equal(
    (await f.call('/review/seen', { item: item.id, boards, revision: review.after })).status,
    200,
  );
  assert.equal(
    (await f.read(item)).boards.every((board: any) => board.seen),
    true,
  );
  const body = {
    item: item.id,
    board: 'Alpha.html',
    revision: review.after,
    width: 812,
    x: 40,
    y: 60,
    layer: 'title',
    offset: { x: 0.5, y: 0.25 },
    area: { x: 20, y: 30, w: 200, h: 80 },
    text: 'Keep the name bold.',
  };
  const response = await f.call('/review/pins', body);
  assert.equal(response.status, 200);
  const pin = (await response.json()).pins[0];
  assert.equal(pin.layer, 'title');
  assert.deepEqual(pin.offset, body.offset);
  assert.deepEqual(pin.area, body.area);
  assert.equal((await f.call('/review/pins', { ...body, offset: { x: 2, y: 0 } })).status, 400);
});

test('approved designs show build reports and only linked open tasks without reports', async () => {
  const f = await reviewFixture('review-built');
  const item = await f.propose();
  const { get } = await import('../workspace/store.ts');
  const { answerInboxAsync } = await import('./inbox.ts');
  const { designTool } = await import('./design.ts');
  const row = get('v2-inbox-native', 'alice', item.id);
  const readApproved = async () =>
    (await (await fetch(`${origin}/api/v2/design/reviews?project=${f.project.id}`)).json())
      .approved;
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'cli' });
  assert.deepEqual(await readApproved(), []);
  const taskId = 'built-task';
  save('task', 'alice', { id: taskId, projectId: f.project.id, status: 'open', title: 'Build it' });
  save('v2-inbox-native', 'alice', {
    ...get('v2-inbox-native', 'alice', item.id),
    context: { ...row.context, taskId },
  });
  // A person proposed this one, so no agent is named.
  assert.match((await readApproved())[0].detail, /· being built$/);
  await assert.rejects(
    () => designTool({ owner: 'alice', taskId }, { action: 'built', state: 'differs' }),
    /differences count/,
  );
  await designTool({ owner: 'alice', taskId }, { action: 'built', state: 'matches' });
  assert.equal((await readApproved())[0].detail, 'Built · matches the design');
  await assert.rejects(
    () =>
      designTool({ owner: 'alice', taskId }, { action: 'built', state: 'differs', differences: 1 }),
    /plain words/,
  );
  await designTool(
    { owner: 'alice', taskId },
    {
      action: 'built',
      state: 'differs',
      differences: 2,
      text: 'History wraps, and the count is smaller.',
    },
  );
  assert.equal((await readApproved())[0].detail, 'Built · 2 differences to look at');
  const built = get('design-review-built', 'alice', item.id);
  save('design-review-built', 'alice', { ...built, state: 'kept' });
  assert.equal((await readApproved())[0].detail, 'Built · matches the design');
  save('design-review-built', 'alice', { ...built, state: 'waiting' });
  assert.match((await readApproved())[0].detail, /being built$/);
});

test('an approved design starts its build once it is on main, and only once', async () => {
  const f = await reviewFixture('review-build-loop');
  const item = await f.propose();
  const { get, list } = await import('../workspace/store.ts');
  const { answerInboxAsync } = await import('./inbox.ts');
  const { landDesignApprovals, designBuildBrief } = await import('./design.ts');
  const builds = () =>
    list('task', 'alice').filter((task: any) => String(task.title).startsWith('Build: '));
  const before = builds().length;
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'cli' });
  await landDesignApprovals();
  const landing = get('design-review-landing', 'alice', item.id);
  assert.equal(landing.state, 'landed');
  assert.ok(landing.build, 'the landing records what followed it');
  if (landing.build.failed) {
    // No computer takes tasks in this fixture: the review says why instead of retrying forever.
    assert.equal(builds().length, before);
  } else {
    assert.equal(landing.build.started, true);
    assert.equal(builds().length, before + 1);
    const task = get('task', 'alice', landing.build.taskId);
    assert.equal(task.title, `Build: ${item.title}`);
    // The review now leads to its builder, so "built" reports and To review can find it.
    assert.equal(get('v2-inbox-native', 'alice', item.id).context.taskId, task.id);
  }
  await landDesignApprovals();
  assert.equal(builds().length, before + (landing.build.failed ? 0 : 1));
  assert.deepEqual(get('design-review-landing', 'alice', item.id).build, landing.build);

  const brief = designBuildBrief({
    title: 'A way back',
    summary: 'Project pages get a breadcrumb.',
    commit: '0123456789abcdef',
    main: 'main',
    paths: ['design/boards/Project.html'],
  });
  assert.match(brief, /“A way back” is approved and on main at 01234567\./);
  assert.match(brief, /Project pages get a breadcrumb\./);
  assert.match(brief, /- design\/boards\/Project\.html/);
  assert.match(brief, /action "built"/);
});

async function mergeFixture(name: string, overlap: boolean, malformed = false) {
  const f = await reviewFixture(name);
  await f.run(['checkout', '-q', 'main']);
  const base =
    '<main data-layer="page"><header data-layer="header" data-name="header row">Old</header><p data-layer="release" data-name="release list">One</p><footer data-layer="footer">End</footer></main>';
  writeFileSync(join(f.path, 'design/boards/Alpha.html'), base);
  await f.commit('Element base');
  await f.run(['checkout', '-qB', 'design/review', 'main']);
  const proposal = base.replace('>Old<', '>Proposal<').replace('>End<', '>Done<');
  writeFileSync(join(f.path, 'design/boards/Alpha.html'), proposal);
  await f.commit('Proposal elements');
  const item = await f.propose();
  await f.run(['checkout', '-q', 'main']);
  const main = malformed
    ? '<p>No stable layers</p>'
    : base.replace('>One<', '>Two<').replace('>Old<', overlap ? '>Main<' : '>Old<');
  writeFileSync(join(f.path, 'design/boards/Alpha.html'), main);
  await f.commit('Main elements');
  const choice = async (value: 'main' | 'proposal' | null, snapshot?: any) => {
    const review = snapshot ?? (await f.read(item));
    return f.call('/review/choice', {
      item: item.id,
      file: 'Alpha.html',
      choice: value,
      main: review.main,
      proposal: review.after,
    });
  };
  return { ...f, item, choice, baseHTML: base, mainHTML: main, proposalHTML: proposal };
}

test('element-level auto merge is resolved and approval lands both changes', async () => {
  const f = await mergeFixture('elements-both', false);
  const review = await f.read(f.item);
  assert.equal(review.stale, false);
  assert.equal(review.resolutions[0].kind, 'kept-both');
  assert.match(review.resolutions[0].mainChanged, /release list/);
  assert.match(review.resolutions[0].proposalChanged, /header row/);
  assert.equal(review.boards[0].main, review.main);
  const { answerInboxAsync } = await import('./inbox.ts');
  await answerInboxAsync('alice', f.item.id, { actionId: 'approve', on: 'cli' });
  const landed = await f.run(['show', 'main:design/boards/Alpha.html']);
  assert.match(landed, />Two</);
  assert.match(landed, />Proposal</);
  assert.match(landed, />Done</);
});

for (const value of ['main', 'proposal'] as const)
  test(`overlapping elements require a choice; ${value} keeps independent changes too`, async () => {
    const f = await mergeFixture(`elements-${value}`, true);
    const { answerInboxAsync } = await import('./inbox.ts');
    for (const actionId of ['approve', 'changes'])
      await assert.rejects(
        () => answerInboxAsync('alice', f.item.id, { actionId, on: 'web', note: 'Adjust' }),
        /Resolve them in the review/,
      );
    const review = await f.read(f.item);
    assert.equal(review.resolutions[0].kind, 'same-part');
    assert.equal(
      (
        await f.call('/review/pins', {
          item: f.item.id,
          board: 'Alpha.html',
          revision: review.main,
          width: 1440,
          x: 10,
          y: 10,
          text: 'A note on main',
        })
      ).status,
      200,
    );
    assert.equal((await f.choice(value)).status, 200);
    assert.equal((await f.read(f.item)).stale, false);
    assert.equal((await f.choice(null)).status, 200);
    assert.equal((await f.read(f.item)).stale, true);
    assert.equal((await f.choice(value)).status, 200);
    await answerInboxAsync('alice', f.item.id, { actionId: 'approve', on: 'web' });
    const landed = await f.run(['show', 'main:design/boards/Alpha.html']);
    assert.match(landed, value === 'main' ? />Main</ : />Proposal</);
    assert.match(landed, />Two</);
    assert.match(landed, />Done</);
  });

test('unparseable boards use a whole-screen choice and main moves invalidate saved answers', async () => {
  const f = await mergeFixture('elements-fallback', true, true);
  let review = await f.read(f.item);
  assert.equal(review.resolutions[0].kind, 'same-part');
  assert.equal((await f.choice('main')).status, 200);
  writeFileSync(join(f.path, 'design/boards/Alpha.html'), '<p>New main</p>');
  await f.commit('Moved main');
  assert.equal((await f.choice('proposal', review)).status, 409);
  review = await f.read(f.item);
  assert.equal(review.resolutions[0].choice, null);
  assert.equal(review.stale, true);
  const { get } = await import('../workspace/store.ts');
  assert.deepEqual(get('v2-inbox-native', 'alice', f.item.id).context.choices, {});
  const { answerInboxAsync } = await import('./inbox.ts');
  await assert.rejects(
    () => answerInboxAsync('alice', f.item.id, { actionId: 'approve', on: 'web' }),
    /Resolve them/,
  );
  assert.equal((await f.choice('main')).status, 200);
  await answerInboxAsync('alice', f.item.id, { actionId: 'approve', on: 'web' });
  assert.equal(await f.run(['show', 'main:design/boards/Alpha.html']), '<p>New main</p>');
});

test('owner Ask to update creates and links a task, once, with the conflicting screens', async () => {
  const f = await mergeFixture('elements-owner', true);
  const { answerInboxAsync } = await import('./inbox.ts');
  const { get, list } = await import('../workspace/store.ts');
  const before = list('task', 'alice').length;
  await answerInboxAsync('alice', f.item.id, { actionId: 'update', on: 'web' });
  const review = await f.read(f.item);
  assert.ok(review.item.taskId);
  const task = get('task', 'alice', review.item.taskId);
  assert.equal(task.projectId, f.project.id);
  assert.equal(task.baseRevision, review.after);
  const feedback = get('design-review-feedback', 'alice', f.item.id);
  assert.match(feedback.content, /Alpha.html.*propose again/);
  assert.equal(feedback.taskId, task.id);
  await assert.rejects(
    () => answerInboxAsync('alice', f.item.id, { actionId: 'update', on: 'web' }),
    /already resolved/,
  );
  assert.equal(list('task', 'alice').length, before + 1);
});

test('different canvas notes merge, the same note takes a reversible choice', async () => {
  const f = await reviewFixture('elements-notes');
  f.canvas.notes['section-agents'].text = 'Proposal agent note';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(f.canvas));
  await f.commit('Proposal note');
  const item = await f.propose();
  await f.run(['checkout', '-q', 'main']);
  const mainCanvas = JSON.parse(await f.run(['show', 'main:design/canvas.json']));
  mainCanvas.notes['section-other'].text = 'Main other note';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(mainCanvas));
  await f.commit('Different note');
  let review = await f.read(item);
  assert.equal(review.resolutions[0].kind, 'kept-both');
  mainCanvas.notes['section-agents'].text = 'Main agent note';
  writeFileSync(join(f.path, 'design/canvas.json'), JSON.stringify(mainCanvas));
  await f.commit('Same note');
  review = await f.read(item);
  assert.equal(review.stale, true);
  assert.equal(
    (
      await f.call('/review/choice', {
        item: item.id,
        file: 'note:section-agents',
        choice: 'main',
        main: review.main,
        proposal: review.after,
      })
    ).status,
    200,
  );
  const { answerInboxAsync } = await import('./inbox.ts');
  await answerInboxAsync('alice', item.id, { actionId: 'approve', on: 'web' });
  const landed = JSON.parse(await f.run(['show', 'main:design/canvas.json']));
  assert.equal(landed.notes['section-agents'].text, 'Main agent note');
  assert.equal(landed.notes['section-other'].text, 'Main other note');
});

test('a new proposal commit never inherits a choice made for the previous commit', async () => {
  const f = await mergeFixture('elements-new-proposal', true);
  assert.equal((await f.choice('main')).status, 200);
  await f.run(['checkout', '-q', 'design/review']);
  writeFileSync(
    join(f.path, 'design/boards/Alpha.html'),
    f.proposalHTML.replace('>Proposal<', '>Revised<'),
  );
  await f.commit('Revise proposal');
  const next = await f.propose();
  assert.notEqual(next.id, f.item.id);
  const review = await f.read(next);
  assert.equal(review.resolutions[0].choice, null);
  assert.equal(review.stale, true);
});

test('Ask to update retains the proposer task and appends its update brief', async () => {
  const f = await mergeFixture('elements-agent-update', true);
  const { get, list } = await import('../workspace/store.ts');
  const taskId = 'elements-agent-task';
  save('task', 'alice', { id: taskId, projectId: f.project.id, revision: 1 });
  save('run', 'alice', { id: 'elements-agent-run', taskId, status: 'running' });
  save('queued-message', 'alice', {
    id: taskId,
    taskId,
    status: 'queued',
    content: 'Keep this existing request.',
  });
  const row = get('v2-inbox-native', 'alice', f.item.id);
  save('v2-inbox-native', 'alice', {
    ...row,
    item: { ...row.item, taskId },
    context: { ...row.context, taskId },
  });
  const before = list('task', 'alice').length;
  const { answerInboxAsync } = await import('./inbox.ts');
  await answerInboxAsync('alice', f.item.id, { actionId: 'update', on: 'web' });
  assert.equal(list('task', 'alice').length, before);
  assert.equal((await f.read(f.item)).item.taskId, taskId);
  assert.match(
    get('queued-message', 'alice', taskId).content,
    /Keep this existing request\.[\s\S]*Alpha.html[\s\S]*propose again/,
  );
});
