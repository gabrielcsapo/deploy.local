// A new review is drawn in Chromium right after it is proposed. Opening it must not wait for
// those drawings, and a screen someone is looking at is drawn before the rest.
// Chromium here is a stand-in that draws only when the test lets it, so the order is visible.
import test, { after } from 'node:test';
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
after(() => {
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});

async function call(path: string, body?: object, project = 'many') {
  const url = new URL(`http://test.invalid/api/v2/projects/${project}/design${path}`);
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

/** How many drawings have started once no more start. */
async function settled(started: string[]) {
  let count = -1;
  for (let wait = 0; wait < 400 && (count !== started.length || !count); wait++) {
    count = started.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return started.length;
}

function within<T>(ms: number, work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

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
  const held: (() => void)[] = [];
  let connected = true;
  const browser = {
    isConnected: () => connected,
    close: async () => {
      connected = false;
    },
    newContext: async (options: { deviceScaleFactor: number }) => ({
      route: async () => {},
      close: async () => {},
      newPage: async () => {
        let evaluated = 0;
        return {
          setContent: async (html: string) => {
            started.push(`${/>(Many\d+)</.exec(html)?.[1]}@${options.deviceScaleFactor}`);
            drawn.push(`${html}@${options.deviceScaleFactor}`);
            await new Promise<void>((resolve) => held.push(resolve));
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
    /** Let the oldest held drawing finish, and wait until the next ones have started. */
    async finishOne() {
      const count = started.length;
      held.shift()?.();
      for (let wait = 0; wait < 200 && started.length === count; wait++)
        await new Promise((resolve) => setTimeout(resolve, 5));
    },
    /** Let every drawing finish, including those that start meanwhile, until none is left. */
    async finishAll() {
      for (let idle = 0; idle < 20; idle++) {
        if (held.length) idle = 0;
        while (held.length) held.shift()!();
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    disconnect() {
      connected = false;
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
    `<main data-layer="page"><nav data-layer="sidebar">${label}</nav><h1 data-layer="title">${board.replace('.html', '')}</h1></main>`;
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
  // a few at a time.
  const atOnce = await settled(chromiumStandIn.started);
  assert.ok(atOnce >= 3 && atOnce < boards.length, `${atOnce} drawings at a time`);

  // The canvas opens the review while no drawing has finished.
  const opened = await within(
    5000,
    call(`/review?item=${encodeURIComponent(item)}&evidence=text`),
    'the review waited for drawings',
  );
  assert.equal(opened.status, 200);
  assert.equal(opened.json.boards.length, boards.length);
  assert.equal(chromiumStandIn.held.length, atOnce, 'opening it drew nothing and finished nothing');

  // Looking at the last screen asks for its areas; its two drawings go ahead of the rest.
  const last = opened.json.boards.at(-1);
  const preview = call(
    `/review/preview?item=${encodeURIComponent(item)}&board=${last.file}&width=1440&scale=1`,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = chromiumStandIn.started.length;
  await chromiumStandIn.finishOne();
  await chromiumStandIn.finishOne();
  const next = chromiumStandIn.started.slice(before, before + 2);
  assert.deepEqual(next, [
    `${last.file.replace('.html', '')}@1`,
    `${last.file.replace('.html', '')}@1`,
  ]);
  await chromiumStandIn.finishAll();
  assert.equal((await preview).status, 200);

  // Without evidence=text the review still waits for its drawings, so iPhone sees what it did.
  const drawn = await call(`/review?item=${encodeURIComponent(item)}`);
  assert.equal(drawn.status, 200);
  assert.deepEqual(drawn.json.boards, opened.json.boards);
  // One drawing per side per screen for the review, two densities more for the warm previews,
  // and nothing drawn twice.
  assert.equal(chromiumStandIn.started.length, boards.length * 2 * 3);
  assert.equal(new Set(chromiumStandIn.started).size, boards.length * 3);
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
  await settled(chromiumStandIn.started);
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
  assert.equal(chromiumStandIn.drawn.length, boards.length * 2 * 3);
});
