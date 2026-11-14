// A new review is drawn in Chromium right after it is proposed. Opening it must not wait for
// those drawings, and a screen someone is looking at is drawn before the rest.
// Chromium here is a stand-in that draws only when the test lets it, so the order is visible.
// Nothing here waits on the clock: each step waits for the queue or the stand-in to say so.
import test, { after } from 'node:test';
import { EventEmitter, once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';
import { chromium } from 'playwright';

const root = mkdtempSync(join(tmpdir(), 'v2-design-drawing-'));
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../store.ts');
const { db, save } = await import('../workspace/store.ts');
const { gitText } = await import('../workspace/repository-git.ts');
const { v2Api } = await import('./api.ts');
const { designWarmUps, drawingQueueEvents, drawingQueueState } = await import('./design.ts');
after(() => {
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

async function call(path: string, body?: object, project = 'many') {
  const url = new URL(`http://test.invalid/api/projects/${project}/design${path}`);
  const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), {
    url: url.pathname + url.search,
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json' },
  }) as unknown as import('node:http').IncomingMessage;
  let status = 200;
  let bytes = Buffer.alloc(0);
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(text: string | Buffer = '') {
      bytes = Buffer.from(text);
    },
  } as unknown as import('node:http').ServerResponse;
  await v2Api(req, res, () => ({ username: 'alice' }));
  return { status, json: JSON.parse(bytes.toString() || 'null') };
}

/** The next change to the queue or the stand-in (or `also` settling). */
async function changed(standIn: EventEmitter, also?: Promise<unknown>) {
  const stop = new AbortController();
  try {
    await Promise.race([
      once(drawingQueueEvents, 'change', { signal: stop.signal }),
      once(standIn, 'change', { signal: stop.signal }),
      ...(also ? [also] : []),
    ]);
  } finally {
    stop.abort();
  }
}
/** Wait until `ready` holds, rechecking whenever the queue or the stand-in changes. */
async function until(ready: () => boolean, standIn: EventEmitter) {
  while (!ready()) await changed(standIn);
}
/** Drawings someone asked for right now that have not started drawing. */
const askedWaiting = () =>
  drawingQueueState().drawings.filter((entry) => entry.priority === 0 && entry.phase !== 'running')
    .length;

/** A 1×1 white PNG, the shape Chromium's screenshots have. */
function png() {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Chromium that starts a drawing when asked and finishes it when the test says so. */
function heldChromium() {
  const started: string[] = [];
  /** What each drawing showed, so a drawing made twice is visible. */
  const drawn: string[] = [];
  const held: { label: string; finish: () => void }[] = [];
  const events = new EventEmitter();
  let connected = true;
  const browser = {
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
    newContext: async (options: { deviceScaleFactor: number; viewport: { width: number } }) => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => {
        let evaluated = 0;
        return {
          setContent: async (html: string) => {
            const label = `${/>(Many\d+)</.exec(html)?.[1]}@${options.deviceScaleFactor}`;
            started.push(label);
            drawn.push(`${html}@${options.viewport.width}@${options.deviceScaleFactor}`);
            const finished = new Promise<void>((finish) => held.push({ label, finish }));
            events.emit('change');
            await finished;
          },
          evaluate: async () => (evaluated++ ? { boxes: {}, textBoxes: [], words: {} } : undefined),
          screenshot: async () => png(),
        };
      },
    }),
  };
  return {
    browser,
    started,
    drawn,
    held,
    events,
    /** Let the oldest held drawing finish, then wait until the next drawing starts. */
    async finishOne() {
      const count = started.length;
      held.shift()!.finish();
      await until(() => started.length > count, events);
    },
    /** Let the held drawings of one screen finish. */
    finishScreen(label: string) {
      for (const drawing of held.filter((entry) => entry.label === label)) {
        held.splice(held.indexOf(drawing), 1);
        drawing.finish();
      }
    },
    /** Let every drawing finish, until every warm-up has finished and no drawing is left. */
    async finishAll() {
      const warmUps = { done: false };
      const finished = designWarmUps().then(() => {
        warmUps.done = true;
      });
      const busy = () => drawingQueueState().drawings.length > 0;
      while (!warmUps.done || held.length || busy()) {
        while (held.length) held.shift()!.finish();
        if (!warmUps.done || busy()) await changed(events, warmUps.done ? undefined : finished);
      }
    },
    /** After the test, pass or fail: nothing stays held, so no later test inherits busy slots. */
    disconnect() {
      connected = false;
      while (held.length) held.shift()!.finish();
    },
  };
}

async function manyBoards(name: string) {
  const repo = join(root, name);
  mkdirSync(join(repo, 'design/boards'), { recursive: true });
  const git = (args: string[]) => gitText(repo, args);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Review Test']);
  await git(['config', 'user.email', 'review@example.invalid']);
  const boards = Array.from({ length: 24 }, (_, index) => `Many${index}.html`);
  const canvas = {
    boards: Object.fromEntries(
      boards.map((file, index) => [
        file,
        { x: index * 1500, y: 0, w: 1440, h: 900, title: file.replace('.html', '') },
      ]),
    ),
    order: boards,
    notes: {},
  };
  writeFileSync(join(repo, 'design/canvas.json'), JSON.stringify(canvas));
  const page = (label: string, board: string) =>
    `<main data-layer="page" data-fixture="${name}"><nav data-layer="sidebar">${label}</nav><h1 data-layer="title">${board.replace('.html', '')}</h1></main>`;
  for (const board of boards)
    writeFileSync(join(repo, 'design/boards', board), page('Design', board));
  await git(['add', '.']);
  await git(['commit', '-qm', 'Base']);
  await git(['checkout', '-qb', 'design/many']);
  for (const board of boards)
    writeFileSync(join(repo, 'design/boards', board), page('Artifacts', board));
  await git(['commit', '-qam', 'Rename in every sidebar']);
  await git(['checkout', '-q', 'main']);
  save('project', 'alice', {
    id: name,
    name,
    repositoryPath: repo,
    repositoryStatus: 'ready',
  });

  return { repo, git, boards, page };
}

test('opening a many-screen review never waits for its drawings, and a looked-at screen draws first', async (t) => {
  const { boards } = await manyBoards('many');
  const chromiumStandIn = heldChromium();
  t.mock.method(chromium, 'executablePath', () => process.execPath);
  t.mock.method(chromium, 'launch', async () => chromiumStandIn.browser);
  t.after(() => chromiumStandIn.disconnect());

  const proposed = await call('/propose', {
    ref: 'design/many',
    title: 'Artifacts',
    summary: 'Rename Design to Artifacts in the sidebar.',
  });
  assert.equal(proposed.status, 201);
  const item = proposed.json.item.id;
  // The proposal starts drawing every screen in the background (two sides, then two densities),
  // a few at a time: wait until every slot is taken and more wait in line.
  await until(() => drawingQueueState().queued > 0, chromiumStandIn.events);
  const atOnce = drawingQueueState().running;
  assert.ok(atOnce >= 3 && atOnce < boards.length, `${atOnce} drawings at a time`);
  await until(() => chromiumStandIn.started.length === atOnce, chromiumStandIn.events);

  // The canvas opens the review while no drawing has finished. (Were it to wait, nothing would
  // ever finish and the test would not end.)
  const opened = await call(`/review?item=${encodeURIComponent(item)}&evidence=text`);
  assert.equal(opened.status, 200);
  assert.equal(opened.json.boards.length, boards.length);
  assert.equal(chromiumStandIn.started.length, atOnce, 'opening it started no drawing');
  assert.equal(chromiumStandIn.held.length, atOnce, 'and finished none');

  // Looking at the last screen asks for its areas; both its drawings go ahead of everything
  // waiting, at the width the warm-up draws (shared with it) and at one it never draws (so the
  // preview's drawings are still reading their board from Git when a slot comes free).
  // A screen none of whose drawings has started: the warm-up takes screens in whatever order
  // their files come back from Git.
  const last = opened.json.boards.findLast(
    (board: { file: string }) =>
      !chromiumStandIn.started.includes(`${board.file.replace('.html', '')}@1`),
  );
  const name = `${last.file.replace('.html', '')}@1`;
  for (const width of last.widths) {
    const preview = call(
      `/review/preview?item=${encodeURIComponent(item)}&board=${last.file}&width=${width}&scale=1`,
    );
    await until(() => askedWaiting() === 2, chromiumStandIn.events);
    const before = chromiumStandIn.started.length;
    await chromiumStandIn.finishOne();
    await chromiumStandIn.finishOne();
    assert.deepEqual(chromiumStandIn.started.slice(before, before + 2), [name, name], `${width}px`);
    // The preview answers once its own two drawings finish.
    chromiumStandIn.finishScreen(name);
    assert.equal((await preview).status, 200);
  }
  await chromiumStandIn.finishAll();

  // Without evidence=text the review still waits for its drawings, so iPhone sees what it did.
  const drawn = await call(`/review?item=${encodeURIComponent(item)}`);
  assert.equal(drawn.status, 200);
  assert.deepEqual(drawn.json.boards, opened.json.boards);
  // One drawing per side per screen for the review, two densities more for the warm previews,
  // the last screen's sides at its other width, and nothing drawn twice.
  assert.equal(
    new Set(chromiumStandIn.drawn).size,
    chromiumStandIn.drawn.length,
    'none drawn twice',
  );
  assert.equal(chromiumStandIn.drawn.length, boards.length * 2 * 3 + 2);
});

test('proposing the same branch again drops the earlier warm-up and draws only what changed', async (t) => {
  const { git, boards, page, repo } = await manyBoards('again');
  const chromiumStandIn = heldChromium();
  t.mock.method(chromium, 'executablePath', () => process.execPath);
  t.mock.method(chromium, 'launch', async () => chromiumStandIn.browser);
  t.after(() => chromiumStandIn.disconnect());
  const propose = () =>
    call(
      '/propose',
      { ref: 'design/many', title: 'Artifacts', summary: 'Rename Design to Artifacts.' },
      'again',
    );
  assert.equal((await propose()).status, 201);
  await until(() => drawingQueueState().queued > 0, chromiumStandIn.events);
  // Every drawing given a slot has reached the stand-in, so none starts unseen meanwhile.
  await until(
    () => chromiumStandIn.started.length === drawingQueueState().running,
    chromiumStandIn.events,
  );
  const changedBoard = boards[23].replace('.html', '');
  // The first round's own copy of the screen the second round changes: only the second round
  // differs from it, so once the first round is dropped it is never drawn again.
  const firstRoundOnly = (drawing: string) =>
    drawing.includes(`>Artifacts</nav><h1 data-layer="title">${changedBoard}<`);
  const drawnBefore = chromiumStandIn.drawn.length;
  // A second round changes one screen while the first round's screens are still drawing.
  await git(['checkout', '-q', 'design/many']);
  writeFileSync(join(repo, 'design/boards', boards[23]), page('Artifacts!', boards[23]));
  await git(['commit', '-qam', 'One more change']);
  await git(['checkout', '-q', 'main']);
  assert.equal((await propose()).status, 201);
  await chromiumStandIn.finishAll();
  // Every screen before and after, at 1×, 2× and 3×, each drawn once: the first round's other
  // drawings were dropped, and the second round reused what both rounds show.
  assert.equal(
    new Set(chromiumStandIn.drawn).size,
    chromiumStandIn.drawn.length,
    'none drawn twice',
  );
  const later = chromiumStandIn.drawn.slice(drawnBefore);
  assert.deepEqual(
    later.filter(firstRoundOnly),
    [],
    'the first round drew nothing more of its own',
  );
  assert.equal(
    chromiumStandIn.drawn.length,
    boards.length * 2 * 3 +
      chromiumStandIn.drawn.slice(0, drawnBefore).filter(firstRoundOnly).length,
  );
});
