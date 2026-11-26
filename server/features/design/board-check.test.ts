import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncInstances, type Library } from '../../design/board-html.ts';
import {
  boardWords,
  brokenLinks,
  canvasProblems,
  changedBoardFiles,
  changedComponents,
  checkDesign,
  checkConcurrency,
  checkWidths,
  instanceOnly,
  lostLayers,
  overflowProblems,
  partRow,
  type CheckDrawing,
} from './board-check.ts';
import {
  contentDifferences,
  contrastProblems,
  droppedActions,
  editedInstanceProblems,
  drawnNotes,
  heightProblem,
  noteOverlapProblems,
  layerNameNote,
  localCopyNotes,
  meaninglessLayers,
  renameMeaninglessLayers,
  notATokenProblems,
  overlapProblems,
  questionFindings,
  readTokens,
  screenFamily,
  sourceNotes,
  spacingNotes,
  type DesignTokens,
} from '../../design/board-quality.ts';
import { parseBoardMeta, setBoardMetaHeight } from '../../../shared/v2/design-board-meta.ts';
import { noteRect, placeBoard, rowGap } from '../../design/board-placement.ts';
import { layerFates } from '../../design/board-layers.ts';
import type { Inspection, InspectedText } from '../../../shared/v2/design-inspect.ts';

test('only board files in the design folder count as changed boards', () => {
  assert.deepEqual(
    changedBoardFiles([
      'design/boards/Sidebar.html',
      'design/boards/Sidebar.html',
      'design/canvas.json',
      'design/ds/deploy-local/tokens.css',
      'design/boards/notes.md',
      'app/page.tsx',
      'design/boards/Projects.html',
    ]),
    ['Projects.html', 'Sidebar.html'],
  );
  assert.deepEqual(
    changedBoardFiles(
      ['artifacts/drop/boards/Upload.html', 'design/boards/A.html'],
      'artifacts/drop',
    ),
    ['Upload.html'],
  );
});

test('a layer main has and the branch dropped is lost; renamed text keeps its ID', () => {
  const main =
    '<div data-layer="page"><h1 data-layer="title">Old</h1><p data-layer="menu">Menu</p></div>';
  assert.deepEqual(lostLayers(main, main.replace('Old', 'New')), []);
  assert.deepEqual(
    lostLayers(main, '<div data-layer="page"><h1 data-layer="title">New</h1><p>Menu</p></div>'),
    ['menu'],
    'an element that stays without its ID is lost',
  );
  assert.deepEqual(
    lostLayers(main, main.replace('data-layer="menu"', 'data-layer="nav"')),
    ['menu'],
    'an element that stays under another ID is lost',
  );
  assert.deepEqual(lostLayers(null, main), [], 'a new board loses nothing');
});

test('an element deleted from the board is removed, not lost', () => {
  const main = [
    '<main data-layer="page">',
    '  <h1 data-layer="title">Projects</h1>',
    '  <section data-layer="export" class="card">',
    '    <h2 data-layer="export-title">Export</h2>',
    '    <div class="row"><button data-layer="download">Download</button></div>',
    '  </section>',
    '  <p data-layer="menu">Menu</p>',
    '</main>',
  ].join('\n');
  const without = (html: string, layer: string) =>
    html.replace(new RegExp(`\\s*<[a-z0-9]+ data-layer="${layer}"[^>]*>[^<]*</[a-z0-9]+>`), '');
  assert.doesNotMatch(without(main, 'menu'), /Menu/);
  assert.deepEqual(lostLayers(main, without(main, 'menu')), [], 'one element deleted');
  const noExport = main.replace(/\s*<section[\s\S]*<\/section>/, '');
  assert.doesNotMatch(noExport, /Export|Download/);
  assert.deepEqual(lostLayers(main, noExport), [], 'a container deleted with all it held');
  assert.deepEqual(
    lostLayers(
      main,
      without(main, 'menu').replace(
        '</main>',
        '<button data-layer="show-archived">Show archived</button></main>',
      ),
    ),
    [],
    'an element deleted and an unrelated one added',
  );
  // The removed section held a button like one the branch adds; inside a removed container it is
  // removed too.
  assert.deepEqual(
    lostLayers(
      main,
      noExport.replace(
        '</main>',
        '<div class="row"><button data-layer="download-2">Download</button></div></main>',
      ),
    ),
    [],
  );
});

test('an element moved within the board keeps its ID and is not lost', () => {
  const main =
    '<main data-layer="page"><h1 data-layer="title">Projects</h1><nav data-layer="nav"><a data-layer="inbox">Inbox</a></nav><p data-layer="menu">Menu</p></main>';
  const moved =
    '<main data-layer="page"><p data-layer="menu">Menu</p><h1 data-layer="title">Projects</h1><nav data-layer="nav"></nav><a data-layer="inbox">Inbox</a></main>';
  assert.deepEqual(lostLayers(main, moved), []);
});

test('a board drawn again with fresh IDs for the same content loses every layer', () => {
  const main = [
    '<main data-layer="page" class="dl-page">',
    '  <h1 data-layer="title">Projects</h1>',
    '  <ul data-layer="list"><li data-layer="harbor">Harbor</li><li data-layer="trade">Trade</li></ul>',
    '</main>',
  ].join('\n');
  const fresh = main.replace(/data-layer="([a-z-]+)"/g, 'data-layer="x-$1"').replace(/\n\s*/g, '');
  assert.deepEqual(lostLayers(main, fresh), ['page', 'title', 'list', 'harbor', 'trade']);
  assert.deepEqual(
    lostLayers(main, main.replace(/\sdata-layer="[^"]*"/g, '')),
    ['page', 'title', 'list', 'harbor', 'trade'],
    'or with none at all',
  );
});

test('what changed names the board’s layers the way the review does', () => {
  const before = '<main data-layer="page"><h1 data-layer="title">Projects</h1></main>';
  const after =
    '<main data-layer="page"><h1 data-layer="title" style="font-size:22px">Projects</h1><button data-layer="show-menu">Show menu</button></main>';
  assert.equal(boardWords(before, after), 'Projects · New Show menu');
  assert.equal(boardWords(null, after), 'New board');
  assert.equal(boardWords(before, null), 'Board removed');
  assert.equal(boardWords(before, before), 'No visible change');
});

test('canvas and disk must agree, but only mismatches this branch made count', () => {
  assert.deepEqual(
    canvasProblems(
      { disk: ['A.html', 'New.html', 'Old.html'], canvas: ['A.html', 'Ghost.html', 'Gone.html'] },
      { disk: ['A.html', 'Old.html'], canvas: ['A.html', 'Gone.html'] },
    ).map((problem) => problem.label),
    ['New.html is not on the canvas', 'Ghost.html is on the canvas only'],
  );
});

test('links to boards that do not exist are problems', () => {
  const html =
    '<nav data-layer="nav"><a data-layer="to-a" href="A.html">A</a><a data-layer="to-b" href="Missing.html">B</a></nav>';
  assert.deepEqual(brokenLinks(html, ['A.html']), ['Missing.html']);
});

test('web boards draw at 1440 and 700, phone boards at their own width', () => {
  assert.deepEqual(checkWidths(1440), [1440, 700]);
  assert.deepEqual(checkWidths(390), [390]);
  assert.deepEqual(checkWidths(undefined), [1440, 700]);
});

test('cut off and sideways scrolling at 700 are problems only when the branch made them', () => {
  const cut = { scrolls: true, cut: 'Show archived' };
  assert.deepEqual(overflowProblems('Projects.html', 'Projects', { after: cut, before: null }), [
    {
      code: 'text_cut_off',
      file: 'Projects.html',
      board: 'Projects',
      width: 700,
      scheme: 'light',
      label: 'Projects is cut off at 700 px',
      detail: '"Show archived" leaves the page',
      short: 'cut off at 700 px',
      fix: 'let the row wrap or scroll sideways, or shorten the words',
    },
  ]);
  assert.deepEqual(overflowProblems('Projects.html', 'Projects', { after: cut, before: cut }), []);
  assert.equal(
    overflowProblems('P.html', 'P', {
      after: { scrolls: true, cut: null },
      before: { scrolls: false, cut: null },
    })[0]!.label,
    'P overflows at 700 px',
  );
  assert.deepEqual(overflowProblems('P.html', 'P', undefined), []);
});

const library = (label: string): Library => ({
  name: 'Test system',
  components: [
    {
      id: 'sidebar',
      name: 'Sidebar',
      props: [{ id: 'place', default: 'Home' }],
      html: `<nav class="dl-side"><b>${label}</b> {{place}}</nav>`,
    },
    { id: 'tag', name: 'Tag', props: [], html: '<span class="dl-tag">Tag</span>' },
  ],
});
const instance = (text: string, place = 'Home') =>
  `<main data-layer="page"><nav data-layer="side" data-component="sidebar" data-props="{&quot;place&quot;:&quot;${place}&quot;}">x</nav><p data-layer="body">${text}</p></main>\n`;

test('only the components the branch changed are parts', () => {
  const before = library('deploy.local');
  assert.deepEqual(changedComponents(before, library('Projects')), [
    { id: 'sidebar', name: 'Sidebar' },
  ]);
  assert.deepEqual(changedComponents(before, before), []);
  assert.deepEqual(changedComponents(null, before).length, 2, 'a new library is all new');
  assert.deepEqual(changedComponents(before, null), []);
});

test('a board is instance-only when its whole change is its instances drawn again', () => {
  const main = syncInstances(instance('Welcome'), library('deploy.local'));
  const next = library('Projects');
  const synced = syncInstances(main, next);
  assert.equal(instanceOnly(synced, [main], next), true);
  assert.equal(instanceOnly(`${synced.trimEnd()}\n\n`, [main], next), true, 'trailing space');
  // Its own change as well: a change of the branch's own.
  assert.equal(instanceOnly(synced.replace('Welcome', 'Hello'), [main], next), false);
  // Synced from another version of the board, main's now or where the branch started.
  const edited = syncInstances(instance('Welcome, edited'), library('deploy.local'));
  assert.equal(instanceOnly(syncInstances(edited, next), [main, edited], next), true);
  assert.equal(instanceOnly(main, [main], next), false, 'unchanged is not a change');
  assert.equal(instanceOnly(synced, [null], next), false, 'a new board is its own');
  assert.equal(instanceOnly(synced, [main], null), false);
});

test('a part is one row with its screens, and one problem for every board it carries', () => {
  const sidebar = { id: 'sidebar', name: 'Sidebar' };
  assert.deepEqual(partRow(sidebar, 242, 0), {
    row: {
      file: 'part:sidebar',
      part: 'sidebar',
      title: 'Sidebar',
      status: 'part',
      words: '242 screens',
    },
    problems: [],
  });
  assert.deepEqual(partRow(sidebar, 242, 234).problems, [
    {
      code: 'part_carried',
      file: 'part:sidebar',
      fix: 'deploy design check --drop-instances',
      label: 'Sidebar is carried on 234 screens',
      detail: 'landing draws them; run deploy design check --drop-instances',
      short: 'carried on 234 screens',
    },
  ]);
  assert.equal(partRow(sidebar, 1, 1).row.words, '1 screen');
});

/** A repository with main, and a commit beside it as a terminal's working copy would push it. */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'board-check-')));
  const run = (args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  run(['init', '-q', '--initial-branch=main']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'user.email', 'test@example.invalid']);
  const write = (file: string, text: string) => {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  return { root, run, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const git = (root: string) => ({
  read: async (args: string[]) => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trimEnd();
    } catch {
      return null;
    }
  },
});

/** Draws nothing: each picture says what it is, and 700 px light reports what it was told. */
function drawing(cut: Record<string, string | null> = {}) {
  const shots: string[] = [];
  const drawer: CheckDrawing = {
    shoot: async ({ commit, file, width, scheme, measure }) => {
      shots.push(`${file} ${commit.slice(0, 7)} ${width} ${scheme}`);
      return {
        png: Buffer.from(`${file}@${commit}`),
        measured: measure ? { scrolls: false, cut: cut[`${file}@${commit}`] ?? null } : null,
      };
    },
    pair: async ({ before, after, width, scheme }) =>
      Buffer.from(`${before ?? 'none'} | ${after} ${width} ${scheme}`),
  };
  return { drawer, shots };
}

test('a working copy is checked against main: named, drawn, and its problems found', async () => {
  const repo = repository();
  try {
    repo.write(
      'design/canvas.json',
      JSON.stringify({ boards: { 'Projects.html': { x: 0, y: 0, w: 1440, h: 900 } } }),
    );
    repo.write(
      'design/boards/Projects.html',
      '<main data-layer="page"><h1 data-layer="title">Projects</h1><p data-layer="menu">Menu</p></main>',
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/show']);
    repo.write(
      'design/boards/Projects.html',
      '<main data-layer="page"><h1 data-layer="title">Projects</h1><button>Show archived</button></main>',
    );
    repo.write('design/boards/Trade.html', '<main><a href="Harbor.html">Harbor</a></main>');
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: {
          'Projects.html': { x: 0, y: 0, w: 1440, h: 900 },
          'Trade.html': { x: 1600, y: 0, w: 1440, h: 900 },
        },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Working copy']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer, shots } = drawing({ [`Projects.html@${commit}`]: 'Show archived' });
    let clock = 0;
    const result = await checkDesign(
      { commit, base: main },
      git(repo.root),
      drawer,
      () => (clock += 2500),
    );
    assert.equal(result.named, 3);
    assert.deepEqual(Object.keys(result.layers), ['Projects.html', 'Trade.html']);
    assert.match(result.layers['Projects.html']!, /<button data-layer="[a-z0-9-]+">Show archived/);
    assert.equal(result.drawn, 2);
    assert.deepEqual(result.widths, [1440, 700]);
    assert.equal(result.seconds, 3);
    assert.deepEqual(
      result.boards.map((board) => [board.title, board.words, board.problems]),
      [
        ['Projects', 'New Show archived · Menu removed', ['cut off at 700 px']],
        ['Trade', 'New board', ['links to Harbor.html']],
      ],
    );
    assert.deepEqual(
      result.problems.map((problem) => `${problem.label} · ${problem.detail}`),
      [
        'Trade links to Harbor.html · no board has that name',
        'Projects is cut off at 700 px · "Show archived" leaves the page',
      ],
    );
    assert.deepEqual(
      result.pictures.map((picture) => picture.name),
      [
        'Projects-1440-light.png',
        'Projects-1440-dark.png',
        'Projects-700-light.png',
        'Projects-700-dark.png',
        'Trade-1440-light.png',
        'Trade-1440-dark.png',
        'Trade-700-light.png',
        'Trade-700-dark.png',
      ],
    );
    // A new board has no Before.
    assert.match(
      Buffer.from(result.pictures[4]!.png, 'base64').toString(),
      /^none \| Trade\.html@/,
    );
    assert.equal(shots.length, 12, 'Projects twice (main and here) at 4 sizes, Trade once');
  } finally {
    repo.cleanup();
  }
});

test('many boards are drawn at once, reported as they finish, and listed in order', async () => {
  const repo = repository();
  try {
    repo.write('design/canvas.json', JSON.stringify({ boards: {} }));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/many']);
    const files = Array.from({ length: 20 }, (_, at) => `Board${String(at).padStart(2, '0')}.html`);
    for (const file of files) repo.write(`design/boards/${file}`, `<main>${file}</main>`);
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: Object.fromEntries(files.map((file) => [file, { x: 0, y: 0, w: 390, h: 800 }])),
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Twenty boards']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    let running = 0;
    let most = 0;
    const { drawer } = drawing();
    const slow: CheckDrawing = {
      ...drawer,
      // Earlier boards take longer, so they finish after later ones.
      shoot: async (input) => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 40 - files.indexOf(input.file) * 2));
        running--;
        return drawer.shoot(input);
      },
    };
    const seen: { drawn: number; total: number }[] = [];
    const result = await checkDesign(
      { commit, base: main },
      git(repo.root),
      slow,
      Date.now,
      (state) => seen.push(state),
    );
    assert.equal(result.drawn, 20);
    assert.ok(most > 1 && most <= checkConcurrency * 2, `drew ${most} at once`);
    assert.deepEqual(
      result.pictures.map((picture) => picture.name),
      files.flatMap((file) => [
        `${file.replace('.html', '')}-390-light.png`,
        `${file.replace('.html', '')}-390-dark.png`,
      ]),
    );
    assert.deepEqual(seen[0], { drawn: 0, total: 20 });
    assert.deepEqual(seen.at(-1), { drawn: 20, total: 20 });
    assert.equal(seen.length, 21);
  } finally {
    repo.cleanup();
  }
});

test('a board that cannot be drawn stops the rest and is a problem', async () => {
  const repo = repository();
  try {
    repo.write('design/canvas.json', JSON.stringify({ boards: {} }));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/broken']);
    const files = Array.from({ length: 12 }, (_, at) => `Board${String(at).padStart(2, '0')}.html`);
    for (const file of files) repo.write(`design/boards/${file}`, `<main>${file}</main>`);
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Boards']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer, shots } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), {
      ...drawer,
      shoot: async (input) => {
        if (input.file === 'Board00.html') throw new Error('Chromium went away\nstack');
        return drawer.shoot(input);
      },
    });
    assert.ok(result.drawn < files.length);
    assert.ok(shots.length < files.length * 4, 'boards after the failure were not started');
    assert.deepEqual(
      result.problems.filter((problem) => problem.file === null).map((p) => p.detail),
      ['Chromium went away'],
    );
  } finally {
    repo.cleanup();
  }
});

test('drop lists the carried boards to put back, and the check passes', async () => {
  const repo = repository();
  try {
    const path = 'design/ds/deploy-local/components/library.json';
    const boards = ['Alpha.html', 'Beta.html', 'Gamma.html'];
    repo.write(path, JSON.stringify(library('deploy.local')));
    for (const file of boards)
      repo.write(`design/boards/${file}`, syncInstances(instance(file), library('deploy.local')));
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: Object.fromEntries(boards.map((file) => [file, { x: 0, y: 0, w: 1440, h: 900 }])),
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/sidebar']);
    repo.write(path, JSON.stringify(library('Projects')));
    // Two boards come along re-synced; Gamma is left to the landing.
    for (const file of ['Alpha.html', 'Beta.html'])
      repo.write(
        `design/boards/${file}`,
        syncInstances(syncInstances(instance(file), library('deploy.local')), library('Projects')),
      );
    repo.run(['commit', '-qam', 'Sidebar shows projects']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const carried = await checkDesign({ commit, base: main }, git(repo.root), drawing().drawer);
    assert.deepEqual(
      carried.boards.map((board) => [board.title, board.words]),
      [['Sidebar', '3 screens']],
      'the part is one row; the carried boards are not rows of their own',
    );
    assert.deepEqual(
      carried.problems.map((problem) => problem.label),
      ['Sidebar is carried on 2 screens'],
    );
    assert.equal(carried.drawn, 0, 'nothing of the branch’s own to draw');
    assert.equal(carried.dropped, undefined);
    assert.deepEqual(carried.restore, []);

    const fixed = await checkDesign(
      { commit, base: main, drop: true },
      git(repo.root),
      drawing().drawer,
    );
    assert.equal(fixed.dropped, 2);
    assert.deepEqual(fixed.problems, []);
    assert.deepEqual(fixed.restore, [{ commit: main, files: ['Alpha.html', 'Beta.html'] }]);
    assert.deepEqual(
      fixed.boards.map((board) => [board.title, board.words]),
      [['Sidebar', '3 screens']],
    );
  } finally {
    repo.cleanup();
  }
});

// ── The checks a person would make ───────────────────────────────────────────────────────────────

const tokens: DesignTokens = readTokens(
  JSON.stringify({
    color: {
      tokens: [
        { name: 'surface', value: { light: '#ffffff', dark: '#24222a' } },
        { name: 'paper', value: { light: '#f7f7f8', dark: '#18171b' } },
        { name: 'ink', value: { light: '#1c1b1f', dark: '#f3f2f5' } },
        { name: 'muted', value: { light: '#67636f', dark: '#9a95a3' } },
      ],
    },
    type: {
      groups: [{ styles: [{ fontSize: '13px' }, { fontSize: '12px' }, { fontSize: '22px' }] }],
    },
    spacing: { tokens: [{ value: '4px' }, { value: '8px' }, { value: '12px' }, { value: '16px' }] },
  }),
  null,
)!;
const board = (style: string, body: string) =>
  `<!doctype html><html><head><meta name="design-board" content="width=1440,height=900"><style>${style}</style></head><body>${body}</body></html>`;

test("a board's head may say its platform, schemes, source and what it replaces; old heads still read", () => {
  assert.deepEqual(parseBoardMeta(board('', '')), {
    width: 1440,
    height: 900,
    platform: null,
    schemes: null,
    replaces: null,
    replacesAll: [],
    source: null,
    copiedFrom: null,
    title: null,
    other: {},
  });
  const phone = parseBoardMeta(
    '<meta name="design-board" content="platform=phone; schemes=light dark; title=Inbox, phone; source=PipelineRun; replaces=OldInbox.html; height=844">',
  );
  assert.equal(phone.platform, 'phone');
  assert.deepEqual(phone.schemes, ['light', 'dark']);
  assert.equal(phone.title, 'Inbox, phone');
  assert.equal(phone.source, 'PipelineRun.html');
  assert.equal(phone.replaces, 'OldInbox.html');
  assert.equal(phone.height, 844);
  assert.equal(
    parseBoardMeta('<meta name="design-board" content="width=390,height=844,source=Inbox.html">')
      .source,
    'Inbox.html',
  );
  assert.match(setBoardMetaHeight(board('', ''), 1200), /content="width=1440,height=1200"/);
  assert.match(
    setBoardMetaHeight('<meta name="design-board" content="platform=web; title=A">', 960),
    /content="platform=web; title=A; height=960"/,
  );
});

test("a colour the branch hard-codes is a problem that names the token; main's are not", () => {
  const before = board('body{background:#fafafb}', '<p data-layer="name">Name</p>');
  const after = board(
    'body{background:#fafafb}.row{color:#ffffff;border:1px solid var(--line)}',
    '<p data-layer="name" style="background:color-mix(in srgb, #fff 80%, black)">Name</p><p data-layer="tint" style="color:var(--ink)">Fine</p>',
  );
  const found = notATokenProblems({ file: 'A.html', title: 'A', before, after, tokens });
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.label, problem.layer ?? null, problem.fix]),
    [
      [
        'not_a_token',
        'A hard-codes #ffffff',
        null,
        'use var(--surface), which is #ffffff, so it works in dark too',
      ],
      [
        'not_a_token',
        'A hard-codes color-mix(in srgb, #fff 80%, black)',
        'name',
        'use a colour token from design/ds, so it works in dark too',
      ],
    ],
  );
  assert.deepEqual(
    notATokenProblems({ file: 'A.html', title: 'A', before, after: before, tokens }),
    [],
  );
});

test('boards placed on top of each other are a problem only when the branch did it, with a free place', () => {
  const boards = {
    'A.html': { x: 0, y: 0, w: 1440, h: 900 },
    'B.html': { x: 1600, y: 0, w: 1440, h: 900 },
  };
  const main = { boards };
  assert.deepEqual(overlapProblems(main, main), []);
  const moved = { boards: { ...boards, 'C.html': { x: 1000, y: 100, w: 1440, h: 900 } } };
  const [problem] = overlapProblems(moved, main);
  assert.equal(problem!.code, 'boards_overlap');
  assert.equal(problem!.file, 'C.html');
  // The row's gap is 160: the free place is after B, at the row's y.
  assert.match(problem!.fix!, /^move it to x -1600, y 0 in canvas\.json/);
  // Two boards that already overlapped on main are not this branch's problem.
  assert.deepEqual(overlapProblems(moved, moved), []);
});

test('a board on a canvas note or section title is a problem; --fix places new boards beside their source', () => {
  const canvas = {
    boards: {
      'Run.html': { x: 0, y: 400, w: 1440, h: 900 },
      'Runs.html': { x: 1640, y: 400, w: 1440, h: 900 },
      'RunPhone.html': { x: 200, y: 0, w: 390, h: 844 },
    },
    notes: {
      section: { x: 0, y: 0, text: 'Pipelines', kind: 'title1', size: 'xxl', maxW: 4000 },
      how: { x: 3300, y: 400, w: 420, text: 'How runs work' },
    },
  };
  const main = {
    boards: { 'Run.html': canvas.boards['Run.html'], 'Runs.html': canvas.boards['Runs.html'] },
    notes: canvas.notes,
  };
  const found = noteOverlapProblems(canvas, main);
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.file, problem.label]),
    [
      [
        'board_overlaps_note',
        'RunPhone.html',
        'RunPhone.html covers the section title "Pipelines"',
      ],
    ],
  );
  // Beside Run, past Runs and the note, with the row's 200 px gap.
  const spot = placeBoard({
    canvas,
    file: 'RunPhone.html',
    size: { w: 390, h: 844 },
    near: 'Run.html',
  });
  assert.deepEqual(spot, { x: -590, y: 400, side: 'left', near: 'Run.html' });
  assert.equal(rowGap(canvas, 400), 200);
  assert.deepEqual(noteRect({ x: 0, y: 0, w: 420, text: 'one line' }), {
    x: 0,
    y: 0,
    w: 420,
    h: 44,
  });
});

test('a height the canvas and the head disagree on is a problem with a fix', () => {
  const problem = heightProblem({
    file: 'A.html',
    title: 'A',
    canvasHeight: 900,
    metaHeight: 1100,
  });
  assert.equal(problem!.code, 'height_differs');
  assert.match(problem!.fix!, /--fix/);
  assert.equal(
    heightProblem({ file: 'A.html', title: 'A', canvasHeight: 900, metaHeight: 900 }),
    null,
  );
  assert.equal(
    heightProblem({
      file: 'A.html',
      title: 'A',
      canvasHeight: 900,
      metaHeight: 1100,
      mainCanvasHeight: 900,
      mainMetaHeight: 1100,
    }),
    null,
    'main already disagreed',
  );
});

test('new layers whose names say nothing are one note; named ones and old ones are fine', () => {
  const before = '<main data-layer="page"><p data-layer="t">Old</p></main>';
  const after =
    '<main data-layer="page"><p data-layer="t">Old</p><span data-layer="a">x</span><span data-layer="t-2">y</span><svg data-layer="svg-3"></svg><b data-layer="item-3">z</b><i data-layer="on"></i><p data-layer="run-status">Passed</p></main>';
  const note = layerNameNote({ file: 'A.html', title: 'A', before, after });
  assert.equal(note!.code, 'layer_name_says_nothing');
  assert.equal(note!.detail, 'a, t-2, svg-3, item-3, on');
  assert.equal(layerNameNote({ file: 'A.html', title: 'A', before, after: before }), null);
});

test('a question is an open note; a layer that asks one and states a date or number is a problem', () => {
  const before = board('', '<p data-layer="kept">Kept files</p>');
  const after = board(
    '',
    '<p data-layer="kept" data-question="How long are kept files kept?">Kept for 30 days</p><p data-layer="where" data-question="Where do they go?">Somewhere</p>',
  );
  const found = questionFindings({ file: 'Run.html', title: 'Run', before, after });
  assert.deepEqual(
    found.problems.map((problem) => [problem.code, problem.layer, problem.detail]),
    [
      [
        'question_invented',
        'kept',
        '"How long are kept files kept?" but it says "Kept for 30 days"',
      ],
    ],
  );
  assert.deepEqual(
    found.notes.map((note) => [note.code, note.label]),
    [
      ['open_question', 'Run asks: How long are kept files kept?'],
      ['open_question', 'Run asks: Where do they go?'],
    ],
  );
  // Questions main already asks are not new notes.
  assert.equal(
    questionFindings({ file: 'Run.html', title: 'Run', before: after, after }).notes.length,
    0,
  );
});

test('a board drawn from a source lists what the source shows or reaches that it does not', () => {
  const source = board(
    '',
    '<nav data-component="sidebar"><a href="Home.html">Home</a></nav><main><h1>Pipeline run</h1><a href="PipelineRuns.html">5 runs</a><button>Download</button><p>Kept files</p></main>',
  );
  const phone = board(
    '',
    '<main><h1>Pipeline run</h1><p>Kept files</p><p>Swipe to retry</p></main>',
  );
  assert.deepEqual(contentDifferences(phone, source), {
    onlySource: ['5 runs', 'Download'],
    onlyBoard: ['Swipe to retry'],
    linksOnlySource: ['PipelineRuns.html'],
  });
  const notes = sourceNotes({
    file: 'PipelineRunPhone.html',
    title: 'Pipeline Run on iPhone',
    source: 'PipelineRun.html',
    before: null,
    after: phone,
    sourceBefore: null,
    sourceAfter: source,
  });
  assert.deepEqual(
    notes.map((note) => note.label),
    [
      'PipelineRunPhone has no "Download"; PipelineRun does',
      'PipelineRun leads to PipelineRuns; PipelineRunPhone has no way to reach it',
      'PipelineRun shows "5 runs"; PipelineRunPhone does not',
      'PipelineRunPhone shows "Swipe to retry"; PipelineRun does not',
    ],
  );
  assert.deepEqual(
    notes.map((note) => note.code),
    ['source_action_missing', 'differs_from_source', 'differs_from_source', 'differs_from_source'],
  );
});

const text = (layer: string, extra: Partial<InspectedText> = {}): InspectedText => ({
  layer,
  text: layer,
  size: 13,
  weight: 400,
  color: [28, 27, 31],
  bg: [255, 255, 255],
  left: 32,
  top: 0,
  width: 100,
  height: 20,
  ...extra,
});
const inspection = (extra: Partial<Inspection> = {}): Inspection => ({
  height: 900,
  texts: [],
  aligned: [],
  rows: {},
  boxes: [],
  primaries: [],
  ...extra,
});

test('white text on white in dark is low contrast; what main already had is not reported', () => {
  const dark = inspection({
    texts: [
      text('row-title', { color: [243, 242, 245], bg: [255, 255, 255] }),
      text('ok', { color: [243, 242, 245], bg: [36, 34, 42] }),
      text('photo', { color: [255, 255, 255], bg: null }),
    ],
  });
  const found = contrastProblems({
    file: 'Run.html',
    title: 'Run',
    width: 1440,
    scheme: 'dark',
    after: dark,
    before: inspection(),
    tokens,
  });
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.layer, problem.scheme, problem.label]),
    [['low_contrast', 'row-title', 'dark', 'Run row-title is 1.1:1 in dark']],
  );
  assert.match(found[0]!.detail, /#f3f2f5 on #ffffff, needs 4.5:1/);
  assert.match(found[0]!.fix!, /var\(--/);
  assert.deepEqual(
    contrastProblems({
      file: 'Run.html',
      title: 'Run',
      width: 1440,
      scheme: 'dark',
      after: dark,
      before: dark,
      tokens,
    }),
    [],
  );
});

test('taste: type and spacing off the scale, near edges, odd rows, a box in a card, two primaries', () => {
  const after = inspection({
    texts: [
      text('label', { size: 11 }),
      text('title', { size: 22 }),
      text('old-small', { size: 19 }),
    ],
    aligned: [{ a: 'title', b: 'label', dx: 2 }],
    rows: { 'dl-item': [64, 64, 64] },
    boxes: [{ layer: 'files', inside: 'card' }],
    primaries: ['publish', 'retry'],
  });
  const before = inspection({
    texts: [text('old-small', { size: 19 })],
    rows: { 'dl-item': [48] },
  });
  const notes = drawnNotes({
    file: 'Run.html',
    title: 'Run',
    width: 1440,
    after,
    before,
    tokens,
    siblings: [{ file: 'Runs.html', rows: { 'dl-item': [48, 48] } }],
  });
  assert.deepEqual(
    notes.map((note) => [note.code, note.label]),
    [
      ['type_off_scale', 'Run sets 11 px type'],
      ['nearly_aligned', 'Run label starts 2 px from title'],
      ['row_height_differs', 'Run dl-item rows are 64 px; 48 px on Runs'],
      ['box_in_card', 'Run draws a box, files, inside card'],
      ['second_primary', 'Run shows 2 primary buttons'],
    ],
  );
  assert.deepEqual(
    drawnNotes({ file: 'Run.html', title: 'Run', width: 1440, after, before: after, tokens }),
    [],
  );

  const spaced = spacingNotes({
    file: 'Run.html',
    title: 'Run',
    before: board('.a{padding:10px}', ''),
    after: board('.a{padding:10px}.b{margin:0 12px 6px;gap:var(--space-2)}', ''),
    tokens,
  });
  assert.deepEqual(
    spaced.map((note) => [note.code, note.label]),
    [['spacing_off_scale', 'Run spaces by 6 px']],
  );
});

test('a board-local rule that copies a design-system class is a note pointing at the component', () => {
  const bundle =
    '.dl-item{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--ink)}';
  const notes = localCopyNotes({
    file: 'Run.html',
    title: 'Run',
    before: board('', ''),
    after: board(
      '.pk-row{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px}',
      '',
    ),
    bundle,
    library: {
      components: [{ id: 'list-group', name: 'List row', html: '<div class="dl-item"></div>' }],
    } as any,
  });
  assert.deepEqual(
    notes.map((note) => [note.code, note.label, note.fix]),
    [
      [
        'local_copy_of_component',
        'Run .pk-row copies .dl-item',
        'use the List row component (class dl-item) instead',
      ],
    ],
  );
});

test("a board's screen is the shortest board name before it that keeps the group small", () => {
  const files = [
    'App.html',
    ...Array.from({ length: 20 }, (_, at) => `AppThing${at}.html`),
    'AppPerformance.html',
    'AppPerformancePhone.html',
    'AppPerformanceEmpty.html',
    'Apps.html',
    'PipelineRun.html',
  ];
  assert.deepEqual(screenFamily('AppPerformanceEmpty.html', files), [
    'AppPerformance.html',
    'AppPerformancePhone.html',
  ]);
  assert.deepEqual(screenFamily('PipelineRunPhone.html', files), ['PipelineRun.html']);
});

test('the check reports drawn problems and notes, measures heights for --fix, and keeps to schemes', async () => {
  const repo = repository();
  try {
    repo.write(
      'design/ds/deploy-local/tokens.json',
      readFileSync(
        join(import.meta.dirname, '../../../design/ds/deploy-local/tokens.json'),
        'utf8',
      ),
    );
    repo.write(
      'design/canvas.json',
      JSON.stringify({ boards: { 'Run.html': { x: 0, y: 0, w: 1440, h: 900 } } }),
    );
    repo.write(
      'design/boards/Run.html',
      board('', '<main data-layer="page"><p data-layer="name">Run</p></main>'),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'kept-files']);
    repo.write(
      'design/boards/Run.html',
      board(
        '.row{background:#fff}',
        '<main data-layer="page"><p data-layer="name">Run</p><p data-layer="kept-row" class="row">Kept</p></main>',
      ).replace('width=1440,height=900', 'width=1440,height=1100; schemes=dark'),
    );
    repo.run(['commit', '-qam', 'Kept files']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const asked: string[] = [];
    const drawer: CheckDrawing = {
      shoot: async ({ commit: at, width, scheme, inspect }) => {
        asked.push(
          `${at === commit ? 'branch' : 'main'} ${width} ${scheme}${inspect ? ' inspect' : ''}`,
        );
        return {
          png: Buffer.from('png'),
          measured: null,
          inspected: inspect
            ? inspection({
                height: 1240,
                texts:
                  at === commit
                    ? [text('kept-row', { color: [243, 242, 245], bg: [255, 255, 255], size: 11 })]
                    : [],
              })
            : null,
        };
      },
      pair: async () => Buffer.from('pair'),
    };
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(asked, [
      'branch 1440 dark inspect',
      'main 1440 dark inspect',
      'branch 700 dark',
      'main 700 dark',
    ]);
    assert.deepEqual(result.schemes, ['dark']);
    assert.deepEqual(
      result.problems.map((problem) => problem.code),
      ['not_a_token', 'height_differs', 'low_contrast'],
    );
    assert.deepEqual(
      result.notes.map((note) => note.code),
      ['type_off_scale'],
    );
    assert.deepEqual(result.heights, { 'Run.html': 1240 });
  } finally {
    repo.cleanup();
  }
});

test('a colour main already had is not new, even when its declaration changed around it', () => {
  const before = board(
    '.live{box-shadow:0 0 0 3px color-mix(in srgb,#0e9f8e 25%,#fff)}.ghost{box-shadow:0 4px 8px rgba(20,20,30,.2)}',
    '',
  );
  const after = board(
    '.live{box-shadow:0 0 0 3px color-mix(in srgb,#0e9f8e 25%,var(--surface))}.ghost{box-shadow:0 4px 8px rgba(20,20,30,.2)}.new{box-shadow:0 1px 2px rgba(0,0,0,.3)}',
    '',
  );
  const found = notATokenProblems({ file: 'A.html', title: 'A', before, after, tokens });
  assert.deepEqual(
    found.map((problem) => [problem.label, problem.fix]),
    [
      [
        'A hard-codes rgba(0,0,0,.3)',
        'use a shadow token: var(--shadow-sm), var(--shadow-raised), var(--shadow-lg) or var(--shadow-xl), so it works in dark too',
      ],
    ],
  );
  // A new board drawn from another is judged against it.
  assert.equal(
    notATokenProblems({ file: 'B.html', title: 'B', before: null, origin: before, after, tokens })
      .length,
    1,
  );
  assert.equal(
    notATokenProblems({ file: 'B.html', title: 'B', before: null, after, tokens }).length,
    3,
  );
});

test('a board-local copy of a component is noted once, and only for a rule the branch added', () => {
  const bundle =
    '.dl-item{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--ink)}';
  const rule =
    '.pk-row{display:flex;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px}';
  const notes = (before: string, after: string) =>
    localCopyNotes({
      file: 'R.html',
      title: 'R',
      before: board(before, ''),
      after: board(after, ''),
      bundle,
    });
  assert.equal(notes(rule.replace('12px 16px', '8px'), rule).length, 0, 'a changed rule');
  assert.equal(notes('', `${rule}${rule}@media(max-width:800px){${rule}}`).length, 1);
});

test('an ID main has must survive its element: renamed and lost are problems, removed is a note', () => {
  const main = [
    '<main data-layer="page">',
    '<div data-layer="setting" class="dl-setting"><span data-layer="typecheck">typecheck</span>',
    '<span data-layer="passed-41-s">Passed · 41 s</span><a data-layer="log" class="dl-btn">Log</a></div>',
    '<p data-layer="old-hint">Gone</p>',
    '<svg data-layer="svg-5" class="dl-run"></svg>',
    '</main>',
  ].join('');
  // Rows rebuilt: typecheck under a new ID, the log link with no ID, the svg in its place under
  // another name, the hint removed.
  const branch = [
    '<main data-layer="page">',
    '<div data-layer="job" class="dl-setting"><span data-layer="job-name">typecheck</span>',
    '<span data-layer="passed-41-s">Passed · 41 s</span><a class="dl-btn">Log</a></div>',
    '<svg data-layer="run-icon" class="dl-run"></svg>',
    '</main>',
  ].join('');
  assert.deepEqual(layerFates(main, branch), [
    { layer: 'setting', fate: 'renamed', to: 'job' },
    { layer: 'typecheck', fate: 'renamed', to: 'job-name' },
    { layer: 'log', fate: 'lost' },
    { layer: 'old-hint', fate: 'removed' },
    { layer: 'svg-5', fate: 'renamed', to: 'run-icon' },
  ]);
  assert.deepEqual(layerFates(main, main), []);
});

test('the check reports renamed, lost and removed layers against what the board was written as', async () => {
  const repo = repository();
  try {
    repo.write(
      'design/canvas.json',
      JSON.stringify({ boards: { 'A.html': { x: 0, y: 0, w: 1440, h: 900 } } }),
    );
    repo.write(
      'design/boards/A.html',
      '<main data-layer="page"><p data-layer="t-2">Hi</p><p data-layer="menu">Menu</p><p data-layer="gone">Bye</p></main>',
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'rename']);
    repo.write(
      'design/boards/A.html',
      '<main data-layer="page"><p data-layer="greeting">Hi</p><p>Menu</p></main>',
    );
    repo.run(['commit', '-qam', 'Rename']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.problems
        .filter((p) => /layer/.test(p.code ?? ''))
        .map((p) => [p.code, p.layer, p.fix]),
      [
        [
          'layer_renamed',
          't-2',
          'keep the ID t-2 on greeting: move data-layer="t-2" onto the new element',
        ],
        ['lost_layer', 'menu', 'put data-layer="menu" back on the element'],
      ],
    );
    assert.deepEqual(
      result.notes.filter((n) => n.code === 'layer_removed').map((n) => n.detail),
      ['gone'],
    );
  } finally {
    repo.cleanup();
  }
});

test('a phone board drawn from a web one: status glyphs and row taps are fine, a dropped action is a problem', () => {
  const web = board(
    '',
    '<main><h1>Run 4f2e9a1</h1><button class="dl-btn secondary" data-layer="run-pipeline">Run pipeline</button>' +
      '<div class="dl-setting"><span>typecheck</span><span>Passed · 41 s</span><a href="#" class="dl-btn quiet">Log</a></div></main>',
  );
  const phone = board(
    '',
    '<main><h1>Run 4f2e9a1</h1><a class="dl-ph-row" href="#"><svg aria-label="Passed"></svg><span>typecheck</span><span>41 s</span></a></main>',
  );
  const found = sourceNotes({
    file: 'RunPhone.html',
    title: 'Run on iPhone',
    source: 'Run.html',
    before: null,
    after: phone,
    sourceBefore: null,
    sourceAfter: web,
  });
  assert.deepEqual(
    found.map((finding) => [finding.code, finding.label]),
    [['source_action_missing', 'RunPhone has no "Run pipeline"; Run does']],
  );
  assert.deepEqual(
    droppedActions(phone, web).map((action) => action.layer),
    ['run-pipeline'],
  );
  // A question on the board saying why is enough.
  const asked = phone.replace(
    '<main>',
    '<main data-question="Should the phone run a pipeline, or only show runs?">',
  );
  assert.deepEqual(droppedActions(asked, web), []);
});

test('a new board copied from another is judged against it, named or found', async () => {
  const repo = repository();
  try {
    const original = board(
      '.chrome{background:#fafafb}\n.side-row{padding:6px 10px;color:#55525b}\n.side-head{font-size:11px}\n.pane{border:1px solid #e6e5ea}',
      '<main class="chrome pane"><nav class="side-row">Projects</nav><h1 class="side-head">Run</h1></main>',
    );
    repo.write(
      'design/ds/deploy-local/tokens.json',
      readFileSync(
        join(import.meta.dirname, '../../../design/ds/deploy-local/tokens.json'),
        'utf8',
      ),
    );
    repo.write('design/boards/Run.html', original);
    repo.write(
      'design/boards/DesignSystemRows.html',
      board('', '<main><p>reports/junit.xml 86 KB</p><p>Row specimen title</p></main>'),
    );
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: {
          'Run.html': { x: 0, y: 0, w: 1440, h: 900 },
          'DesignSystemRows.html': { x: 0, y: 2000, w: 1440, h: 900 },
        },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'copy']);
    // A copy with no head saying so, one new colour, and a specimen's file name.
    repo.write(
      'design/boards/RunKept.html',
      original
        .replace('.pane{', '.kept{color:#123456}\n.pane{')
        .replace(
          '<h1 class="side-head">Run</h1>',
          '<h1 class="side-head">Run</h1><p>reports/junit.xml 86 KB</p>',
        ),
    );
    // A copy that says where it came from.
    repo.write(
      'design/boards/RunOther.html',
      original.replace('width=1440,height=900', 'width=1440,height=900,copied_from=Run.html'),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Copies']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.problems.filter((p) => p.code === 'not_a_token').map((p) => [p.file, p.label]),
      [['RunKept.html', 'Run Kept hard-codes #123456']],
    );
    const kept = result.boards.find((row) => row.file === 'RunKept.html')!;
    assert.equal(kept.comparedWith, 'Run.html');
    assert.match(kept.words, /judged against Run$/);
    assert.equal(
      result.boards.find((row) => row.file === 'RunOther.html')!.comparedWith,
      undefined,
    );
    assert.deepEqual(
      result.notes
        .filter((n) => n.code === 'specimen_text')
        .map((n) => [n.file, n.label, n.detail]),
      [
        [
          'RunKept.html',
          'Run Kept shows sample words from DesignSystemRows',
          '"reports/junit.xml 86 KB"',
        ],
      ],
    );
    assert.equal(result.notes.filter((n) => n.code === 'type_off_scale').length, 0);
  } finally {
    repo.cleanup();
  }
});

test('type scale: a phone board is judged by the phone scale, a web board by the web one', () => {
  const scaled = readTokens(
    JSON.stringify({
      color: { tokens: [{ name: 'ink', value: { light: '#1c1b1f', dark: '#f3f2f5' } }] },
      type: {
        groups: [
          { name: 'App', styles: [{ fontSize: '12px' }, { fontSize: '13px' }] },
          { name: 'Phone', styles: [{ fontSize: '11px' }, { fontSize: '17px' }] },
        ],
      },
      spacing: { tokens: [{ value: '4px' }] },
    }),
    null,
  ) as DesignTokens;
  const after = inspection({ texts: [text('status-label', { size: 11 })] });
  const codes = (platform: string, width: number) =>
    drawnNotes({
      file: 'Run.html',
      title: 'Run',
      width,
      after,
      before: null,
      tokens: scaled,
      platform,
    })
      .map((note) => note.code)
      .filter((code) => code === 'type_off_scale');
  assert.deepEqual(codes('web', 1440), ['type_off_scale']);
  assert.deepEqual(codes('phone', 390), []);
});

// The Packages section of deploy.local's canvas, as it was when --fix put PipelineRunPhone 10,600 px
// away from PipelineRun.
const packagesCanvas = {
  boards: {
    'Packages.html': { x: 500, y: 73720, w: 1440, h: 900 },
    'Package.html': { x: 2020, y: 73720, w: 1440, h: 1100 },
    'PipelineRun.html': { x: 500, y: 74700, w: 1440, h: 900 },
    'PackagesCache.html': { x: 3540, y: 73720, w: 1440, h: 1500 },
    'PackagesSetup.html': { x: 5060, y: 73720, w: 1440, h: 1400 },
    'TaskPublish.html': { x: 6580, y: 73720, w: 1440, h: 900 },
    'CliPackages.html': { x: 8100, y: 73720, w: 1440, h: 760 },
    'PackagesPhone.html': { x: 9620, y: 73720, w: 390, h: 844 },
    'PackageVersionsPhone.html': { x: 10030, y: 73720, w: 390, h: 844 },
    'PackagesEmptyPhone.html': { x: 10440, y: 73720, w: 390, h: 844 },
    'PackagesErrorPhone.html': { x: 10850, y: 73720, w: 390, h: 844 },
    'PackagesUnreachablePhone.html': { x: 11260, y: 73720, w: 390, h: 844 },
    'SettingsPackagesRowPhone.html': { x: 11670, y: 73720, w: 390, h: 900 },
    'PackageVersionsErrorPhone.html': { x: 12080, y: 73720, w: 390, h: 844 },
    'PackagesLongNamePhone.html': { x: 12490, y: 73720, w: 390, h: 844 },
    'NpmSignIn.html': { x: 2020, y: 76100, w: 1440, h: 900 },
    'NpmSignInDone.html': { x: 3540, y: 76100, w: 1440, h: 900 },
  },
  notes: {
    'section-packages': {
      x: 0,
      y: 73000,
      text: '10 \u00b7 Packages (for approval)',
      kind: 'title1',
      size: 'xxl',
      maxW: 10100,
    },
    'packages-col-web': { fill: 'purple', w: 260, x: 500, y: 73500, text: 'Web app and Mac app' },
    'packages-col-cli': { fill: 'purple', w: 260, x: 8100, y: 73500, text: 'CLI' },
    'packages-col-phone': { fill: 'purple', w: 260, x: 9620, y: 73500, text: 'iPhone' },
    'packages-how': {
      fill: 'orange',
      w: 440,
      x: -520,
      y: 73720,
      text: "Proposal. deploy.local hosts npm packages and Cargo crates, and keeps a copy of everything projects install from npmjs.org and crates.io, so installs keep working when those sites are down.\n\n\u2022 Packages sits in the sidebar under Computers. It appears once deploy.local has served a package: a private one, or a copy. On approval, every board's sidebar gets the same row.\n\u2022 Tabs: Private, Copies, Set up. A package opens its page: install, versions, the projects that use it (read from each project's lockfile on main).\n\u2022 Versions are never replaced or deleted. npm versions can be deprecated and crates yanked from the package page's version rows.\n\u2022 Who publishes: pipelines, so nobody has to release a package by hand. deploy.yaml's pipeline gets a publish list. Once every job passes on main, each listed package whose version is new is published (PipelineRun), and a version already published is skipped. A failed publish fails the run, and Run pipeline retries it. Merging a new version is what starts it (TaskPublish). Pull requests never publish. People can still run deploy packages publish, for a package with no pipeline. Tasks and agents never publish; their computers' keys only install. There is no publish card in Waiting on you.\n\u2022 A project with a pipeline shows Pipelines after Apps, as the app has today. This board is the first to draw that tab.\n\u2022 Copies tab, normal state: no banner, both sources read Reachable, Packages kept has one row for all projects, and the sidebar row shows nothing. While a source is down the sidebar shows Using copies, as drawn. Only projects with a problem get their own row, with the cause. A missing package is fetched on its own when the source is back. A version its source removed stops installing until the project moves off it.\n\u2022 Copies cover npm packages and crates. App builds also need their Docker image, which deploy.local doesn't keep.\n\u2022 Package keys (Settings, General) are made by deploy packages login from your CLI sign-in. Installs only or Installs and publishes. Remove revokes it at once.\n\u2022 Project settings get a Packages group with one switch, Install through deploy.local (on). A project with packages gets a Packages tab after Releases, listing its own packages with the same rows.\n\u2022 Mac app: the window loads these web pages; nothing native is added. iPhone: Settings \u2192 Packages is read-only (PackagesPhone). Rows open the package's versions in a sheet.",
    },
    'packages-phone-first-run': {
      fill: 'yellow',
      w: 760,
      x: 9620,
      y: 74670,
      text: 'Drawn after the iPhone screens were first seen running.\n\n\u2022 Packages and a package\u2019s versions both open as sheets, like every other Settings destination.\n\u2022 The two parts load separately: if one fails, the other still shows. A failed part with nothing to show says it could not be refreshed. One with rows keeps them.\n\u2022 Storage reads like web: gigabytes of 1024\u00b3, then the limit (6.2 GB of 20 GB).\n\u2022 Version dates carry the year. Today\u2019s reads Today, 7:57 AM.\n\u2022 Kept on SER opens nothing, so it has no chevron.\n\u2022 A latest version over 12 characters is capped at 96 pt and shortened in the middle, so it can\u2019t squeeze the name. The versions sheet shows it in full.',
    },
  },
};

test('--fix places a new phone board nearest its source on the real canvas, never across it', () => {
  const spot = placeBoard({
    canvas: packagesCanvas,
    file: 'PipelineRunPhone.html',
    size: { w: 390, h: 844 },
    near: 'PipelineRun.html',
  });
  // Right of PipelineRun is Package; left is the section's note: so just below it.
  assert.deepEqual(spot, { x: 500, y: 75760, side: 'below', near: 'PipelineRun.html' });
  // With room to its right, it goes there, at the row's gap.
  const roomy = {
    ...packagesCanvas,
    boards: { ...packagesCanvas.boards, 'Package.html': { x: 20000, y: 73720, w: 1440, h: 1100 } },
  };
  assert.equal(
    placeBoard({
      canvas: roomy,
      file: 'PipelineRunPhone.html',
      size: { w: 390, h: 844 },
      near: 'PipelineRun.html',
    }).x,
    2100,
  );
});

test('what is typed inside a component instance is a problem naming its props', () => {
  const library = {
    components: [
      {
        id: 'design-editor',
        name: 'Design editor',
        props: [
          { id: 'mode', default: 'Editing' },
          { id: 'branch', default: 'design/x' },
        ],
        html: '<div class="ed"><span>{{mode}}</span><span>{{branch}}</span></div>',
      },
    ],
  } as any;
  const drawn = syncInstances(
    '<main><div data-layer="editor" data-component="design-editor" data-props=\'{"mode":"Editing","branch":"design/x"}\'></div></main>',
    library,
  );
  const typed = drawn.replace(
    '</span></div>',
    '</span><form><textarea>Leave a comment</textarea><button>Send</button></form></div>',
  );
  const found = editedInstanceProblems({
    file: 'A.html',
    title: 'A',
    before: null,
    after: typed,
    library,
  });
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.layer, problem.detail, problem.fix]),
    [
      [
        'edited_inside_component',
        'editor',
        'never drawn: "Leave a comment", "Send"',
        'set it with data-props (props: mode, branch) or put it outside the instance',
      ],
    ],
  );
  // As the component draws it, or as main already had it, it is fine.
  assert.deepEqual(
    editedInstanceProblems({ file: 'A.html', title: 'A', before: null, after: drawn, library }),
    [],
  );
  assert.deepEqual(
    editedInstanceProblems({ file: 'A.html', title: 'A', before: typed, after: typed, library }),
    [],
  );
});

test('a phone board is compared with its source without the web chrome, and a phone counterpart answers a link', () => {
  const web = board(
    '',
    '<header class="dl-head"><button aria-label="Show sidebar" class="dl-icon-btn"></button><button class="dl-icon-btn" aria-label="Search"></button><a class="dl-btn primary" href="Home.html">New task</a></header>' +
      '<main><h1>Package</h1><a class="dl-btn secondary" href="Package.html">Versions</a></main>',
  );
  const phone = board(
    '',
    '<main><h1>Package</h1><a class="dl-ph-row" href="PackageVersionsPhone.html">Versions</a></main>',
  );
  const notes = (counterparts = {}) =>
    sourceNotes({
      file: 'PackagePhone.html',
      title: 'Package on iPhone',
      source: 'Package2.html',
      before: null,
      after: phone,
      sourceBefore: null,
      sourceAfter: web,
      counterparts,
    }).map((finding) => finding.label);
  assert.deepEqual(notes({ 'Package.html': ['PackageVersionsPhone.html'] }), []);
  assert.deepEqual(notes(), ['Package2 leads to Package; PackagePhone has no way to reach it']);
});

test('question_invented says the thing without a value and keeps the question', () => {
  const [problem] = questionFindings({
    file: 'A.html',
    title: 'A',
    before: null,
    after: board('', '<p data-layer="kept" data-question="How long?">Deleted after 30 days</p>'),
  }).problems;
  assert.equal(
    problem!.fix,
    "say the thing without a value, e.g. 'Kept files are deleted after a period the owner will set', and keep the data-question",
  );
});

test('two primaries, meaningless names the board was written with, and cut-off text are problems', async () => {
  const repo = repository();
  try {
    repo.write(
      'design/canvas.json',
      JSON.stringify({ boards: { 'P.html': { x: 0, y: 0, w: 390, h: 844 } } }),
    );
    repo.write(
      'design/boards/P.html',
      '<main data-layer="page"><p data-layer="title">Run</p></main>',
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'more']);
    // t-2 is the agent's; the new <p> gets its name from the check, which is never a problem.
    repo.write(
      'design/boards/P.html',
      '<main data-layer="page"><p data-layer="title">Run</p><span data-layer="t-2">Kept</span><p>Logs</p></main>',
    );
    repo.run(['commit', '-qam', 'More']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const drawer: CheckDrawing = {
      shoot: async ({ commit: at, inspect }) => ({
        png: Buffer.from('png'),
        measured: null,
        inspected: inspect
          ? inspection(
              at === commit
                ? {
                    primaries: ['publish', 'retry'],
                    clipped: [{ layer: 'logs', text: 'Logs', by: 'bar', frame: 'tab-bar' }],
                  }
                : {},
            )
          : null,
      }),
      pair: async () => Buffer.from('pair'),
    };
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.problems.map((problem) => [problem.code, problem.detail]),
      [
        ['layer_name_says_nothing', 't-2'],
        ['second_primary', 'publish, retry'],
        ['cut_off_bottom', '"Logs" is partly hidden'],
      ],
    );
    assert.equal(result.problems[2]!.label, 'P logs sits under tab-bar');
  } finally {
    repo.cleanup();
  }
});

test('--fix names again only the new layers that say nothing', () => {
  const before = '<main data-layer="page"><p data-layer="t-1">Old</p></main>';
  const after =
    '<main data-layer="page"><p data-layer="t-1">Old</p><div class="dl-item"><span data-layer="report">report.xml</span><span data-layer="212-kb">212 KB</span></div></main>';
  assert.deepEqual(meaninglessLayers(before, after), ['212-kb']);
  const renamed = renameMeaninglessLayers(before, after);
  assert.match(renamed, /data-layer="t-1"/, "main's IDs stay, even when they say nothing");
  assert.match(renamed, /<span data-layer="file-report-xml-size">212 KB<\/span>/);
});

test('the check counts a link to a phone counterpart, by name or by source=, as reaching the web board', async () => {
  const repo = repository();
  try {
    const boards = {
      'Run.html':
        '<main><h1>Run</h1><a href="Package.html">Package</a><a href="Versions.html">Versions</a></main>',
      'Package.html': '<main>Package</main>',
      'Versions.html': '<main>Versions</main>',
      'PackagePhone.html': '<main>Package</main>',
      'VersionListPhone.html':
        '<meta name="design-board" content="width=390,height=844,source=Versions.html"><main>Versions</main>',
    };
    for (const [file, html] of Object.entries(boards)) repo.write(`design/boards/${file}`, html);
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: Object.fromEntries(
          Object.keys(boards).map((file, at) => [file, { x: at * 2000, y: 0, w: 1440, h: 900 }]),
        ),
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'phone']);
    repo.write(
      'design/boards/RunPhone.html',
      '<meta name="design-board" content="width=390,height=844,source=Run.html"><main><h1>Run</h1><a href="PackagePhone.html">Package</a><a href="VersionListPhone.html">Versions</a></main>',
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Phone']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.notes.filter((note) => note.code === 'differs_from_source').map((note) => note.label),
      [],
    );
  } finally {
    repo.cleanup();
  }
});
