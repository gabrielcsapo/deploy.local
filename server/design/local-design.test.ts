import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalDesign, localDesignApi } from './local-design.ts';

/** A checkout with main on origin, and a design branch with edits not committed yet. */
async function folder() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-design-')));
  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  run(['init', '-q', '--initial-branch=main']);
  write(
    'design/canvas.json',
    JSON.stringify({
      title: 'catan',
      boards: { 'Harbor.html': { x: 0, y: 0, w: 1440, h: 900, title: 'Harbor' } },
      order: ['Harbor.html'],
      notes: {},
    }),
  );
  write(
    'design/boards/Harbor.html',
    '<!doctype html><html><head><link rel="stylesheet" href="../ds/deploy-local/tokens.css"></head><body><main data-layer="page"><h1 data-layer="title">Harbor</h1><p data-layer="menu">Menu</p></main></body></html>',
  );
  run(['add', '.']);
  run(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'Main']);
  run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  run(['checkout', '-qb', 'design/harbor-trade']);
  const local = createLocalDesign({
    root,
    project: 'catan',
    branch: 'design/harbor-trade',
    main: 'origin/main',
    designSystem: (path) =>
      path === 'ds/deploy-local/tokens.css' ? Buffer.from(':root{--ink:#18181b}') : null,
  });
  const server = createServer(async (req, res) => {
    if (!(await local.handle(req, res))) res.writeHead(404).end('elsewhere');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const call = (path: string, body?: unknown) =>
    fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      body: body ? JSON.stringify(body) : undefined,
      headers: { 'content-type': 'application/json' },
    });
  return {
    root,
    write,
    local,
    call,
    close: async () => {
      server.closeAllConnections();
      server.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the Design page reads a folder through the same design API, its version a hash of the files', async () => {
  const at = await folder();
  try {
    const design = await (await at.call(localDesignApi)).json();
    assert.equal(design.ref, 'design/harbor-trade');
    assert.match(design.commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(Object.keys(design.canvas.boards), ['Harbor.html']);
    assert.deepEqual(design.branches, []);
    // The same files, the same version; a save is a new one.
    assert.equal((await (await at.call(localDesignApi)).json()).commit, design.commit);
    const board = await at.call(`${localDesignApi}/files/${design.commit}/boards/Harbor.html`);
    assert.equal(board.status, 200);
    assert.match(board.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.match(await board.text(), /<h1 data-layer="title">Harbor/);
    // A project with no design/ds of its own draws with deploy.local's.
    const tokens = await at.call(`${localDesignApi}/files/abc/ds/deploy-local/tokens.css`);
    assert.equal(await tokens.text(), ':root{--ink:#18181b}');
    for (const path of ['boards/../canvas.json', 'boards/Missing.html', 'boards/run.sh'])
      assert.equal((await at.call(`${localDesignApi}/files/abc/${path}`)).status, 404, path);
    // What only deploy.local has answers empty, so the page shows none of it.
    assert.deepEqual(await (await at.call(`${localDesignApi}/comments`)).json(), { comments: [] });
    assert.deepEqual(await (await at.call(`${localDesignApi}/presence`)).json(), { agents: [] });
    assert.deepEqual(await (await at.call(`${localDesignApi}/proposals`)).json(), {
      proposals: [],
    });
    assert.deepEqual((await (await at.call('/api/inbox?state=waiting')).json()).items, []);
    assert.deepEqual((await (await at.call('/api/projects')).json()).projects[0].name, 'catan');
    assert.equal((await at.call(`${localDesignApi}/ask`, { text: 'x' })).status, 404);
  } finally {
    await at.close();
  }
});

test('edits and canvas changes from the page are written into the folder', async () => {
  const at = await folder();
  try {
    const before = (await (await at.call(localDesignApi)).json()).commit;
    const edited = await (
      await at.call(`${localDesignApi}/edit`, {
        board: 'Harbor.html',
        ref: 'design/harbor-trade',
        edits: [{ op: 'text', layer: 'title', text: 'Harbor trade' }],
      })
    ).json();
    assert.equal(edited.branch, 'design/harbor-trade');
    assert.notEqual(edited.commit, before);
    assert.match(
      readFileSync(join(at.root, 'design/boards/Harbor.html'), 'utf8'),
      /<h1 data-layer="title">Harbor trade<\/h1>/,
    );
    // Main's board stays readable beside it, for measuring what main already had.
    const onMain = await at.call(`${localDesignApi}/main-files/boards/Harbor.html`);
    assert.match(await onMain.text(), /<h1 data-layer="title">Harbor<\/h1>/);
    assert.equal((await at.call(`${localDesignApi}/main-files/boards/New.html`)).status, 404);
    // The answer and the reload after the save name the same version: nothing redraws twice.
    assert.equal((await (await at.call(localDesignApi)).json()).commit, edited.commit);
    const note = await (
      await at.call(`${localDesignApi}/canvas`, { op: 'note', x: 10, y: 1000, text: 'Keep it' })
    ).json();
    assert.match(note.made, /^note-/);
    const board = await (
      await at.call(`${localDesignApi}/canvas`, { op: 'board', x: 1600, y: 0 })
    ).json();
    assert.equal(board.made, 'Board1.html');
    const canvas = JSON.parse(readFileSync(join(at.root, 'design/canvas.json'), 'utf8'));
    assert.equal(canvas.notes[note.made].text, 'Keep it');
    assert.equal(canvas.boards['Board1.html'].w, 1440);
    assert.match(
      readFileSync(join(at.root, 'design/boards/Board1.html'), 'utf8'),
      /width=1440,height=900/,
    );
    const bad = await at.call(`${localDesignApi}/canvas`, { op: 'note', x: 1e9, y: 0 });
    assert.equal(bad.status, 400);
    // Changes on this branch: against where it left main, with what is not committed.
    const changes = await (await at.call(`${localDesignApi}/changes?ref=x`)).json();
    assert.deepEqual(changes.files.map((file: any) => `${file.status} ${file.path}`).sort(), [
      'added design/boards/Board1.html',
      'changed design/boards/Harbor.html',
      'changed design/canvas.json',
    ]);
    assert.equal(
      changes.files.find((file: any) => file.path.endsWith('Harbor.html')).layers[0].layer,
      'title',
    );
  } finally {
    await at.close();
  }
});

test('a saved board is checked the way check would, without drawing it', async () => {
  const at = await folder();
  try {
    assert.deepEqual(at.local.problems('Harbor.html'), []);
    at.write(
      'design/boards/Harbor.html',
      '<main data-layer="page"><h1 data-layer="title">Harbor</h1><p data-layer="nav">Menu</p><a data-layer="to" href="Trade.html">Trade</a></main>',
    );
    at.write('design/boards/Market.html', '<main data-layer="page">Market</main>');
    assert.deepEqual(
      at.local.problems('Harbor.html').map((problem) => `${problem.short} · ${problem.detail}`),
      [
        'lost layer menu · main has it; keep its ID',
        'links to Trade.html · no board has that name',
      ],
    );
    assert.deepEqual(
      at.local.problems('Market.html').map((problem) => problem.short),
      ['is not on the canvas'],
    );
  } finally {
    await at.close();
  }
});
