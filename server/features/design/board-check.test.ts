import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  drawSteps,
  drawnAt,
  platformInfo,
  platformSchemes,
  printGeometry,
} from '../../../shared/v2/design-platforms.ts';
import {
  assignLayerIds,
  instanceQuestions,
  syncInstances,
  type Library,
} from '../../design/board-html.ts';
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
  type CheckShot,
} from './board-check.ts';
import { shortLastPageNote, type LogoMarks } from '../../design/kind-checks.ts';
import {
  contentDifferences,
  contrastProblems,
  droppedActions,
  editedInstanceProblems,
  drawnNotes,
  cutOffSideProblems,
  heightProblem,
  inlineStyleNotes,
  noteOverlapProblems,
  phoneMappings,
  layerNameNote,
  localCopyNotes,
  meaninglessLayers,
  saysNothing,
  notATokenProblems,
  overlapProblems,
  questionFindings,
  readTokens,
  unflaggedClaimsNote,
  tokensFromCss,
  typeScaleFor,
  schemeDroppedProblem,
  schemePinnedProblems,
  screenFamily,
  sourceNotes,
  spaceScaleFor,
  spacingNotes,
  type DesignTokens,
} from '../../design/board-quality.ts';
import { parseBoardMeta, setBoardMetaHeight } from '../../../shared/v2/design-board-meta.ts';
import {
  boardOrder,
  knownOrder,
  noteRect,
  placeBoard,
  rowGap,
} from '../../design/board-placement.ts';
import { layerFates } from '../../design/board-layers.ts';
import {
  fixedHeight,
  phoneScreen,
  screenSafeAreaProblems,
  statusBarNote,
} from '../../design/kind-checks.ts';
import { buildBoardPage } from '../../design/check-drawing.ts';
import { designSystemFolder, designSystemPaths } from '../../../shared/v2/design-system-path.ts';
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

test('components no screen shows yet are one line, not a "0 screens" row each', async () => {
  const repo = repository();
  try {
    repo.write('design/canvas.json', JSON.stringify({ boards: {} }));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/kit']);
    // A new project's kit: a library of parts, and one board using none of them. All of it is
    // new, so the check says nothing about the parts.
    repo.write('design/ds/deploy-local/components/library.json', JSON.stringify(library('Kit')));
    repo.write('design/boards/Title.html', '<main><h1>Lantern Rooms</h1></main>');
    repo.write(
      'design/canvas.json',
      JSON.stringify({ boards: { 'Title.html': { x: 0, y: 0, w: 1440, h: 900 } } }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Kit']);
    const kit = await checkDesign(
      { commit: repo.run(['rev-parse', 'HEAD']), base: main },
      git(repo.root),
      drawing().drawer,
    );
    assert.ok(!kit.boards.some((board) => board.status === 'part'), JSON.stringify(kit.boards));
    // A part changed in a library main already has: a line, not a "0 screens" row.
    repo.run(['checkout', '-q', 'main']);
    repo.run(['merge', '-q', '--ff-only', 'design/kit']);
    const merged = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'design/more']);
    repo.write('design/ds/deploy-local/components/library.json', JSON.stringify(library('More')));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'More']);
    const result = await checkDesign(
      { commit: repo.run(['rev-parse', 'HEAD']), base: merged },
      git(repo.root),
      drawing().drawer,
    );
    const words = result.boards.map((board) => [board.title, board.words]);
    assert.ok(!words.some(([, said]) => /^0 screens$/.test(said)), JSON.stringify(words));
    assert.deepEqual(words[0], ['Sidebar', 'on no screen yet']);
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
    page: null,
    size: null,
    bleed: null,
    safe: null,
    device: null,
    other: {},
  });
  const print = parseBoardMeta(
    '<meta name="design-board" content="platform=print,size=85x55mm,bleed=3mm,safe=4mm">',
  );
  assert.deepEqual(
    [print.platform, print.size, print.bleed, print.safe],
    ['print', '85x55mm', '3mm', '4mm'],
  );
  assert.equal(
    parseBoardMeta('<meta name="design-board" content="platform=doc,page=letter">').page,
    'letter',
  );
  assert.equal(
    parseBoardMeta('<meta name="design-board" content="platform=game,device=phone">').device,
    'phone',
  );
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
  assert.equal(note!.detail, 'a, t-2, svg-3, on', 'item-3 is a role with its number');
  assert.equal(layerNameNote({ file: 'A.html', title: 'A', before, after: before }), null);
});

test('a question is an open note; a layer that asks one and shows a sample value is a note, not a problem', () => {
  const before = board('', '<p data-layer="kept">Kept files</p>');
  const after = board(
    '',
    '<p data-layer="kept" data-question="How long are kept files kept?">Kept for 30 days</p><p data-layer="where" data-question="Where do they go?">Somewhere</p>',
  );
  const found = questionFindings({ file: 'Run.html', title: 'Run', before, after });
  assert.deepEqual(found.problems, []);
  assert.deepEqual(
    found.notes.map((note) => [note.code, note.layer]),
    [
      ['question_sample_value', 'kept'],
      ['open_question', 'kept'],
      ['open_question', 'where'],
    ],
  );
  assert.deepEqual(
    found.notes.filter((note) => note.code === 'open_question').map((note) => note.label),
    ['Run asks: How long are kept files kept?', 'Run asks: Where do they go?'],
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
    // The web board is already on main; the phone board is new.
    sourceBefore: source,
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

test('a changed board stating prices, figures or policies with no question is a note', () => {
  const page = (body: string) => `<html><body>${body}</body></html>`;
  const after = page(
    '<p data-layer="price">Croissant $4.50</p>' +
      '<p data-layer="claim">Loved by 2,000 families</p>' +
      '<p data-layer="returns">Free returns within 30 days</p>' +
      '<p data-layer="asked" data-question="What does delivery cost?">Delivery $6</p>' +
      '<p data-layer="session">Focus 25 min · Today, Friday 27 November · 184 KB</p>' +
      '<p data-layer="kit">Saved 12%</p>',
  );
  const note = unflaggedClaimsNote({
    file: 'Shop.html',
    title: 'Shop',
    before: page('<p data-layer="price">Croissant $4.50</p>'),
    after,
    samples: new Set(['12%']),
  });
  assert.ok(note);
  assert.equal(note.code, 'unflagged_claims');
  assert.equal(note.label, 'Shop states 2 claims no question flags');
  assert.equal(note.detail, '"Loved by 2,000 families", "Free returns within 30 days"');
  assert.equal(
    unflaggedClaimsNote({ file: 'Shop.html', title: 'Shop', before: after, after }),
    null,
  );
});

test('tables of one kind stacked with columns in different places are a note', () => {
  const table = (layer: string, top: number, columns: number[]) => ({
    layer,
    kind: 'ds-mac-table',
    left: 240,
    top,
    columns,
  });
  const after = inspection({
    tables: [
      table('day-today', 100, [240, 356, 700]),
      table('day-yesterday', 220, [240, 348, 700]),
      table('day-wednesday', 340, [240, 333, 700]),
      table('totals', 460, [240, 500]),
      // Far down the page, in another section: not part of the stack.
      table('appendix', 2000, [240, 300, 700]),
    ],
  });
  const notes = drawnNotes({
    file: 'Main.html',
    title: 'Main',
    width: 1440,
    after,
    before: null,
    tokens,
  });
  const ragged = notes.filter((note) => note.code === 'tables_misaligned');
  assert.equal(ragged.length, 1);
  assert.equal(ragged[0].label, "Main stacks 3 tables whose columns don't line up");
  assert.match(
    ragged[0].detail,
    /day-today, day-yesterday, day-wednesday: columns start up to 23 px apart/,
  );
  // Main already drew them this way: not news.
  assert.equal(
    drawnNotes({ file: 'Main.html', title: 'Main', width: 1440, after, before: after, tokens })
      .length,
    0,
  );
  const even = inspection({
    tables: [table('a', 100, [240, 356, 700]), table('b', 220, [240, 357, 700])],
  });
  assert.equal(
    drawnNotes({ file: 'Main.html', title: 'Main', width: 1440, after: even, before: null, tokens })
      .length,
    0,
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
      // The height is measured in a window too short to hand the canvas's height back.
      'branch 1440 dark inspect',
      'branch 700 dark',
      'main 700 dark',
    ]);
    assert.deepEqual(result.schemes, ['dark']);
    assert.deepEqual(
      result.problems.map((problem) => problem.code),
      ['not_a_token', 'missing_scheme', 'height_differs', 'low_contrast'],
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
    sourceBefore: web,
    sourceAfter: web,
  });
  assert.deepEqual(
    found.map((finding) => [finding.code, finding.label]),
    [['source_action_missing', 'RunPhone has no "Run pipeline"; Run does']],
  );
  // Both boards new (a new project): the designer is drawing both, so it is a note.
  const fresh = sourceNotes({
    file: 'RunPhone.html',
    title: 'Run on iPhone',
    source: 'Run.html',
    before: null,
    after: phone,
    sourceBefore: null,
    sourceAfter: web,
  });
  assert.deepEqual(
    fresh.map((finding) => finding.code),
    ['differs_from_source'],
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
        'set it with data-props (props: mode, branch) or put it outside the instance, then run deploy design sync',
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

test('role words with a number are names; --fix never replaces an ID the author wrote', () => {
  const before = '<main data-layer="page"><p data-layer="t-1">Old</p></main>';
  const after =
    '<main data-layer="page"><p data-layer="t-1">Old</p><div data-layer="figure-1">a</div><div data-layer="item-2">b</div><div data-layer="row-3">c</div><div data-layer="budget-figure-2-value">d</div><div data-layer="year-figure-1">e</div><div data-layer="div-1">f</div><div data-layer="ds-card">g</div><span data-layer="212-kb">212 KB</span></main>';
  assert.deepEqual(meaninglessLayers(before, after), ['div-1', 'ds-card', '212-kb']);
  assert.equal(saysNothing('figure'), true, 'bare, a role says nothing');
  // The author's IDs stay whatever the check thinks of them; only elements with none are named.
  const named = assignLayerIds(after);
  for (const layer of ['figure-1', 'item-2', 'row-3', 'div-1', '212-kb', 'ds-card'])
    assert.ok(named.includes(`data-layer="${layer}"`), layer);
});

test('a new element is named for its role, with its parent and its number, never placeholder copy', () => {
  const html = assignLayerIds(
    '<body><main data-layer="budget"><div class="ds-figure"><span class="ds-value">The crop that grew</span></div><div class="ds-figure"><span class="ds-value">Day to be confirmed</span></div><ul class="timeline"><li>First line of text</li><li>Second line</li></ul></main></body>',
  );
  const ids = [...html.matchAll(/data-layer="([^"]*)"/g)].map((match) => match[1]);
  assert.ok(ids.includes('budget-figure-2-value'), ids.join());
  assert.ok(ids.includes('budget-timeline-item-1'), ids.join());
  for (const id of ids) assert.ok(!/to-be|confirmed|the-crop|first-line/.test(id), id);
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

test('a string the product code says is not specimen text', async () => {
  const repo = repository();
  try {
    repo.write('server/jobs.ts', "export const refused = 'Unsupported file type';\n");
    repo.write(
      'design/boards/DesignSystemRows.html',
      board('', '<main><p>Unsupported file type</p><p>reports/junit.xml 86 KB</p></main>'),
    );
    repo.write('design/boards/Run.html', board('', '<main><h1>Run</h1></main>'));
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
    repo.run(['checkout', '-qb', 'kept']);
    repo.write(
      'design/boards/Run.html',
      board(
        '',
        '<main><h1>Run</h1><p>Unsupported file type</p><p>reports/junit.xml 86 KB</p></main>',
      ),
    );
    repo.run(['commit', '-qam', 'Kept']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.notes.filter((note) => note.code === 'specimen_text').map((note) => note.detail),
      ['"reports/junit.xml 86 KB"'],
    );
  } finally {
    repo.cleanup();
  }
});

test('the design system maps web boards to phone boards, and a line kept in parts is kept', () => {
  const readme =
    '# DS\n\n## Phone screens\n\n- A link to a web detail goes to its phone board: Package → PackageVersionsPhone, Logs -> LogsPhone. Projects → a project.\n\n## Lists\n\nRun → Nothing\n';
  assert.deepEqual(
    phoneMappings(readme, [
      'Package.html',
      'PackageVersionsPhone.html',
      'Logs.html',
      'LogsPhone.html',
      'Run.html',
      'Nothing.html',
    ]),
    { 'Package.html': ['PackageVersionsPhone.html'], 'Logs.html': ['LogsPhone.html'] },
  );
  const web = board(
    '',
    '<main><p>4f2e9a1 · #31 merged by you · ran on SER</p><a href="Package.html">react-flight-router</a></main>',
  );
  const phone = board(
    '',
    '<header class="dl-ph-top"><span>4f2e9a1</span></header><main><p>#31 merged by you</p><p>ran on SER</p><a href="PackageVersionsPhone.html">react-flight-router</a></main>',
  );
  // The bar is chrome, so the hash is not on the phone's content; the rest of the line is.
  assert.deepEqual(
    contentDifferences(phone.replace('<span>4f2e9a1</span>', ''), web, {
      'Package.html': ['PackageVersionsPhone.html'],
    }).linksOnlySource,
    [],
  );
  const kept = contentDifferences(phone.replace('header class="dl-ph-top"', 'div'), web, {});
  assert.deepEqual(kept.onlySource, []);
});

test('an instance asks about its inner layers on its root; sync keeps the questions and the check reads them', () => {
  const library = {
    components: [
      {
        id: 'design-editor',
        name: 'Design editor',
        props: [{ id: 'draft-size', default: '1440' }],
        html: '<div class="ed"><span data-layer="draft-size">{{draft-size}}</span><span data-layer="draft-scheme">Light</span></div>',
      },
    ],
  } as any;
  const written =
    '<main><div data-layer="editor" data-component="design-editor" data-props=\'{"draft-size":"1440 × 900"}\' data-questions=\'{"draft-size":"Is the size the frame or the window?"}\'><span data-layer="draft-size">old</span><span data-layer="draft-scheme" data-question="Which scheme?">Light</span></div></main>';
  const synced = syncInstances(written, library);
  assert.match(synced, /<span data-layer="draft-size">1440 × 900<\/span>/);
  assert.deepEqual(instanceQuestions(/<div[^>]*data-component[^>]*>/.exec(synced)![0]), {
    'draft-size': 'Is the size the frame or the window?',
    'draft-scheme': 'Which scheme?',
  });
  assert.doesNotMatch(
    synced,
    /<span[^>]*data-question=/,
    'an inner data-question moves to the root',
  );
  const found = questionFindings({ file: 'A.html', title: 'A', before: null, after: synced });
  assert.deepEqual(
    found.notes.map((note) => [note.layer, note.label]),
    [
      ['draft-size', 'A asks: Is the size the frame or the window?'],
      ['draft-scheme', 'A asks: Which scheme?'],
    ],
  );
  // A question about which size the label means is not answered by the label showing one.
  assert.deepEqual(found.problems, []);
});

test('a sample value is quoted in whole words, with an ellipsis where the text goes on', () => {
  const [note] = questionFindings({
    file: 'A.html',
    title: 'A',
    before: null,
    after: board(
      '',
      '<p data-layer="meet" data-question="When is it held?">The meeting is held on the first Tuesday of the month, at 7:00 in the laundry room, with tea for everyone who comes along</p>',
    ),
  }).notes;
  assert.equal(note.code, 'question_sample_value');
  assert.match(note.label, /"…(?:\S+ )*\S*Tuesday[^"]*…"$/);
  assert.doesNotMatch(note.label, /"…?[a-z]{1,2} /, 'no word cut in half at the start');
});

test('a sample value is noted only when it is of the kind the question asks for', () => {
  const flagged = (question: string, text: string) =>
    questionFindings({
      file: 'A.html',
      title: 'A',
      before: null,
      after: board('', `<p data-layer="x" data-question="${question}">${text}</p>`),
    })
      .notes.filter((note) => note.code === 'question_sample_value')
      .map((note) => note.detail);
  assert.deepEqual(flagged('Is the size the frame or the window?', 'Web 1440'), []);
  assert.deepEqual(flagged('What does this line mean?', 'Made at Web 1440 · Light'), []);
  assert.deepEqual(flagged('How long are kept files kept?', 'Made at Web 1440'), []);
  assert.deepEqual(flagged('How long are kept files kept?', 'Deleted after 30 days'), [
    'its question is "How long are kept files kept?"',
  ]);
  assert.deepEqual(flagged('When are they deleted?', 'Deleted on Dec 3'), [
    'its question is "When are they deleted?"',
  ]);
  assert.deepEqual(flagged('How many versions are kept?', 'Keeps 5 versions'), [
    'its question is "How many versions are kept?"',
  ]);
  assert.deepEqual(flagged('How much can it hold?', 'Up to 500 MB'), [
    'its question is "How much can it hold?"',
  ]);
  assert.deepEqual(flagged('How many versions are kept?', 'Up to 500 MB'), []);
});

test('a board drawn in fewer schemes than its source or siblings, or a page pinned to one, is a problem', async () => {
  assert.deepEqual(
    schemeDroppedProblem({
      file: 'DesignNew.html',
      title: 'Design New',
      schemes: ['light'],
      siblings: [
        { file: 'DesignCanvas.html', schemes: ['light', 'dark'] },
        { file: 'DesignBoard.html', schemes: ['light', 'dark'] },
      ],
    })?.detail,
    'its siblings (DesignCanvas, DesignBoard) draw light and dark; dark is not drawn',
  );
  // A single-scheme source sets the bar; a board as wide as its siblings is fine.
  assert.equal(
    schemeDroppedProblem({
      file: 'A.html',
      title: 'A',
      schemes: ['light'],
      from: { file: 'Slide.html', schemes: ['light'] },
    }),
    null,
  );
  assert.equal(
    schemeDroppedProblem({
      file: 'A.html',
      title: 'A',
      schemes: ['light', 'dark'],
      siblings: [{ file: 'B.html', schemes: ['light', 'dark'] }],
    }),
    null,
  );

  const pinned = schemePinnedProblems({
    file: 'A.html',
    title: 'A',
    before: null,
    after: board(
      '',
      '<div data-layer="editor" class="dz-ed" data-component="design-editor" data-theme="light"><div data-layer="preview" data-theme="light">Board</div></div>',
    ).replace('<body>', '<body data-theme="light">'),
  });
  assert.deepEqual(
    pinned.map((problem) => [problem.code, problem.label]),
    [
      ['scheme_pinned_page', 'A pins <body> to light'],
      ['scheme_pinned_page', 'A pins the design-editor instance (editor) to light'],
    ],
  );
  assert.equal(
    pinned[0]!.fix,
    'draw it in every scheme its siblings draw; to keep a preview light, pin the inner preview, not the page',
  );

  // In a check: a new Design board with schemes=light beside siblings that draw both.
  const repo = repository();
  try {
    repo.write('design/boards/DesignCanvas.html', board('', '<main>Canvas</main>'));
    repo.write('design/boards/DesignBoard.html', board('', '<main>Board</main>'));
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        boards: {
          'DesignCanvas.html': { x: 0, y: 0, w: 1440, h: 900 },
          'DesignBoard.html': { x: 1600, y: 0, w: 1440, h: 900 },
        },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'comment']);
    repo.write(
      'design/boards/DesignComment.html',
      board('', '<main>Comment</main>').replace(
        'width=1440,height=900',
        'width=1440,height=900,schemes=light',
      ),
    );
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        // This project opts out of dark; its Design boards still draw both, and so must a new one.
        schemes: ['light'],
        boards: {
          'DesignCanvas.html': { x: 0, y: 0, w: 1440, h: 900 },
          'DesignBoard.html': { x: 1600, y: 0, w: 1440, h: 900 },
          'DesignComment.html': { x: 3200, y: 0, w: 1440, h: 900 },
        },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Comment']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.deepEqual(
      result.problems.map((problem) => [problem.code, problem.file]),
      [['scheme_dropped', 'DesignComment.html']],
    );
  } finally {
    repo.cleanup();
  }
});

test("a project's own design system is found and read; deploy.local's is never assumed", () => {
  assert.equal(designSystemFolder({ designSystem: 'ds/larder' }, ['larder', 'old']), 'ds/larder');
  assert.equal(designSystemFolder({}, ['larder']), 'ds/larder');
  assert.equal(designSystemFolder(null, ['deploy-local']), 'ds/deploy-local');
  assert.equal(designSystemFolder(null, []), null);
  assert.deepEqual(designSystemPaths('ds/larder').library, [
    'ds/larder/components/library.json',
    'ds/larder/library.json',
  ]);
  const tokens = tokensFromCss(`
    :root { --surface: #ffffff; --ink: #1d1b16; --text-body: 16px; --text-title: 1.5rem;
      --text-phone-body: 17px; --space-2: 8px; --space-4: 16px; --radius: 8px; }
    @media (prefers-color-scheme: dark) { :root { --surface: #1b1a17; --ink: #f4f1ea; } }
    [data-theme="dark"] { --ink: #f5f2eb; }
  `);
  assert.deepEqual(tokens.colors, [
    { name: 'surface', light: '#ffffff', dark: '#1b1a17' },
    { name: 'ink', light: '#1d1b16', dark: '#f5f2eb' },
  ]);
  assert.deepEqual(tokens.type, [16, 24]);
  assert.deepEqual(tokens.phoneType, [17]);
  assert.deepEqual(tokens.space, [8, 16]);
});

test('a new project is judged by its own tokens, and a board without dark is missing_scheme', async () => {
  const repo = repository();
  try {
    repo.write(
      'design/ds/larder/tokens.css',
      ':root{--shelf:#f4efe6;--ink:#1d1b16;--text-body:16px;--space-4:16px}\n@media (prefers-color-scheme: dark){:root{--shelf:#22201b;--ink:#f4f1ea}}\n',
    );
    repo.write('design/canvas.json', JSON.stringify({ designSystem: 'ds/larder', boards: {} }));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Init']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'pantry']);
    repo.write(
      'design/boards/Pantry.html',
      board(
        '.row{background:#f4efe6}',
        '<main data-layer="pantry"><p data-layer="title">Pantry</p></main>',
      ).replace('width=1440,height=900', 'width=1440,height=900,schemes=light'),
    );
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        designSystem: 'ds/larder',
        boards: { 'Pantry.html': { x: 0, y: 0, w: 1440, h: 900 } },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Pantry']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const { drawer } = drawing();
    // The CLI carries deploy.local's system; a Larder check must not read it.
    const result = await checkDesign(
      { commit, base: main, systemFile: () => ':root{--surface:#f4efe6}' },
      git(repo.root),
      drawer,
    );
    assert.deepEqual(
      result.problems.map((problem) => [problem.code, problem.fix]),
      [
        ['not_a_token', 'use var(--shelf), which is #f4efe6, so it works in dark too'],
        [
          'missing_scheme',
          'take schemes= out of its head (or list light dark) and draw it with tokens, so dark reads too',
        ],
      ],
    );
  } finally {
    repo.cleanup();
  }
});

test("the starter's tokens read as a CSS-only system, with either quote, and its examples link their system", async () => {
  const css = readFileSync(
    join(import.meta.dirname, '../../../bin/design-starter/tokens.css'),
    'utf8',
  );
  for (const text of [css, css.replaceAll('"', "'")]) {
    const tokens = tokensFromCss(text);
    assert.ok(
      tokens.type.includes(15) && !tokens.type.includes(17),
      'web sizes without the phone ones',
    );
    assert.ok(tokens.phoneType?.includes(17));
    assert.ok(tokens.space.includes(16));
    const ink = tokens.colors.find((token) => token.name === 'ink');
    assert.ok(ink?.light && ink.dark && ink.light !== ink.dark, 'ink has a dark value');
  }
  const page = await buildBoardPage(
    '<head><link rel="stylesheet" href="../ds/larder/tokens.css" /><link href="../ds/larder/components.css" rel="stylesheet"></head>',
    {
      library: async () => null,
      css: async (path) => Buffer.from(`/* ${path} */`),
      capture: async () => null,
    },
  );
  assert.equal(
    page,
    '<head><style>/* ds/larder/tokens.css */</style><style>/* ds/larder/components.css */</style></head>',
  );
});

test('an iPhone bar and an icon button carry the actions their web source has', () => {
  const web = board(
    '',
    '<main><h1>Add item</h1><div class="dl-stepper"><button aria-label="Fewer">−</button><button aria-label="More">+</button></div>' +
      '<button class="dl-btn quiet">Cancel</button><button class="dl-btn primary">Add</button></main>',
  );
  const phone = board(
    '',
    '<header class="ds-phone-navbar"><button>Cancel</button><h1>Add item</h1><button>Add</button></header>' +
      '<main><span class="ds-stepper"><button aria-label="Fewer"><svg></svg></button><button aria-label="More"><svg></svg></button></span></main>',
  );
  assert.deepEqual(droppedActions(phone, web), []);
});

// ── Kinds of artifact beyond web and phone ──────────────────────────────────────────────────────

/** A board for a platform, with the design system's kind stylesheet for its type scale. */
const kindBoard = (
  head: string,
  body = '<main data-layer="page"><p data-layer="line">Words</p></main>',
) =>
  `<!doctype html><html><head><meta name="design-board" content="${head}"><link rel="stylesheet" href="../ds/k/tokens.css"><link rel="stylesheet" href="../ds/k/kind.css"></head><body>${body}</body></html>`;

/** A project of one kind, with main holding only its design system, and a new board on a branch. */
async function kindCheck(options: {
  head: string;
  file?: string;
  canvas?: Record<string, unknown>;
  placed?: Record<string, number>;
  inspect?: (input: { width: number; scheme: string; media?: string }) => Partial<Inspection>;
  png?: (scheme: string) => Buffer;
  /** More the drawing gives back for a shot (printed sheets, a logo's marks, its grounds). */
  extra?: (input: { scheme: string; media?: string }) => Partial<CheckShot>;
}) {
  const repo = repository();
  try {
    const file = options.file ?? 'Board.html';
    repo.write('design/ds/k/tokens.css', ':root{--space-4:16px;--text-body:16px}');
    repo.write(
      'design/ds/k/kind.css',
      ':root{--text-slide-body:32px;--text-slide-title:72px;--text-print-body:8pt;--text-print-name:11pt;--text-doc-body:17px}@media print{:root{--text-doc-body:11pt}}',
    );
    repo.write(
      'design/canvas.json',
      JSON.stringify({ designSystem: 'ds/k', ...options.canvas, boards: {} }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'kind']);
    repo.write(`design/boards/${file}`, kindBoard(options.head));
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        designSystem: 'ds/k',
        ...options.canvas,
        boards: { [file]: { x: 0, y: 0, w: 1440, h: 900, ...options.placed } },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Board']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const shots: {
      width: number;
      height: number;
      scheme: string;
      scale?: number;
      media?: string;
      fullPage?: boolean;
    }[] = [];
    const pairs: {
      width: number;
      scheme: string;
      before: Buffer | null;
      layout?: unknown;
      afterPages?: Buffer[];
      afterMarks?: unknown;
    }[] = [];
    const drawer: CheckDrawing = {
      shoot: async (input) => {
        shots.push({
          width: input.width,
          height: input.height,
          scheme: input.scheme,
          scale: input.scale,
          media: input.media,
          fullPage: input.fullPage,
        });
        return {
          png: options.png?.(input.scheme) ?? Buffer.from('png'),
          measured: input.measure ? { scrolls: false, cut: null } : null,
          inspected: input.inspect
            ? inspection({
                height: input.height,
                ...options.inspect?.({
                  width: input.width,
                  scheme: input.scheme,
                  media: input.media,
                }),
              })
            : null,
          ...options.extra?.({ scheme: input.scheme, media: input.media }),
        };
      },
      pair: async ({ before, width, scheme, layout, afterPages, afterMarks }) => {
        pairs.push({ width, scheme, before, layout, afterPages, afterMarks });
        return Buffer.from('pair');
      },
    };
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    return { result, shots, pairs };
  } finally {
    repo.cleanup();
  }
}

test('a slide is drawn once at 1920 by 1080 in light, alone as a new board, with no app-only notes', async () => {
  const { result, shots, pairs } = await kindCheck({
    head: 'platform=slide',
    inspect: () => ({
      texts: [text('title', { size: 72 }), text('body', { size: 32 }), text('odd', { size: 40 })],
      // App notes that a slide does not owe.
      aligned: [{ a: 'title', b: 'body', dx: 2 }],
      boxes: [{ layer: 'card', inside: 'panel' }],
      primaries: ['a', 'b'],
    }),
  });
  assert.deepEqual(
    shots.map((shot) => [shot.width, shot.height, shot.scheme]),
    [[1920, 1080, 'light']],
  );
  assert.deepEqual(
    result.pictures.map((picture) => picture.name),
    ['Board-1920-light.png'],
  );
  assert.equal(pairs[0].before, null, 'a new board has no Before half');
  assert.deepEqual(result.widths, [1920]);
  assert.deepEqual(result.schemes, ['light']);
  assert.deepEqual(result.problems, [], 'a light-only slide is not missing dark');
  // Held to --text-slide-*: 40 px is off it, and the web's scale is not asked.
  assert.deepEqual(
    result.notes.map((note) => [note.code, note.short]),
    [['type_off_scale', '40 px type']],
  );
  assert.match(result.notes[0].fix ?? '', /slide type scale: 32px, 72px/);
});

test('a project that asks for light and dark still gets a printed card in light only', async () => {
  const { result, shots, pairs } = await kindCheck({
    head: 'platform=print,size=85x55mm,bleed=3mm,safe=4mm',
    canvas: { schemes: ['light', 'dark'] },
    inspect: () => ({
      texts: [text('name', { left: 40, top: 40, width: 80, height: 20, size: 14.6667 })],
    }),
  });
  assert.deepEqual(result.schemes, ['light']);
  assert.deepEqual(result.problems, []);
  // 91 x 61 mm with its bleed, in CSS px, drawn at 8 px per millimetre.
  assert.equal(shots[0].width, 344);
  assert.equal(shots[0].height, 231);
  assert.ok(Math.abs((shots[0].scale ?? 0) * (96 / 25.4) - 8) < 1e-9);
  assert.deepEqual(
    result.pictures.map((picture) => picture.name),
    ['Board-728-light.png'],
  );
  assert.deepEqual(pairs[0].layout, {
    kind: 'print',
    pxPerMm: 8,
    trim: { w: 85, h: 55 },
    bleed: 3,
    safe: 4,
  });
  // 11pt is on --text-print-*, 14.67 px is 11pt; no note.
  assert.deepEqual(result.notes, []);
});

test('a card with a front and a back gets a proof of both faces after the back; a lone face does not', async () => {
  const repo = repository();
  try {
    repo.write('design/ds/k/tokens.css', ':root{--space-4:16px}');
    repo.write('design/canvas.json', JSON.stringify({ designSystem: 'ds/k', boards: {} }));
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Main']);
    const main = repo.run(['rev-parse', 'HEAD']);
    repo.run(['checkout', '-qb', 'card']);
    const card = 'platform=print,size=85x55mm,bleed=3mm,safe=4mm';
    const boards: Record<string, string> = {
      'CardFront.html': card,
      'CardBack.html': card,
      'FlyerFront.html': 'platform=print,size=148x210mm,bleed=3mm,safe=5mm',
    };
    for (const [file, head] of Object.entries(boards))
      repo.write(`design/boards/${file}`, kindBoard(head));
    repo.write(
      'design/canvas.json',
      JSON.stringify({
        designSystem: 'ds/k',
        boards: {
          'CardFront.html': { x: 0, y: 0, w: 344, h: 231 },
          'CardBack.html': { x: 400, y: 0, w: 344, h: 231 },
          'FlyerFront.html': { x: 0, y: 300, w: 582, h: 816 },
        },
      }),
    );
    repo.run(['add', '.']);
    repo.run(['commit', '-qm', 'Card']);
    const commit = repo.run(['rev-parse', 'HEAD']);
    const pairs: { before: string | null; after: string; labels?: unknown; layout?: unknown }[] =
      [];
    const drawer: CheckDrawing = {
      shoot: async (input) => ({
        png: Buffer.from(input.file),
        measured: null,
        inspected: input.inspect ? inspection({ height: input.height }) : null,
      }),
      pair: async ({ before, after, labels, layout }) => {
        pairs.push({ before: before?.toString() ?? null, after: after.toString(), labels, layout });
        return Buffer.from('pair');
      },
    };
    const result = await checkDesign({ commit, base: main }, git(repo.root), drawer);
    assert.ok(result.pictures.some((picture) => picture.name === 'Card-proof-light.png'));
    const proof = pairs.find((pair) => pair.labels);
    assert.deepEqual(proof && [proof.before, proof.after, proof.labels], [
      'CardFront.html',
      'CardBack.html',
      { before: 'Front', after: 'Back' },
    ]);
    assert.equal((proof?.layout as { kind?: string })?.kind, 'print');
    assert.equal(pairs.filter((pair) => pair.labels).length, 1, 'the flyer has no back: no proof');
    const names = result.pictures.map((picture) => picture.name);
    assert.equal(
      names.indexOf('Card-proof-light.png'),
      Math.max(names.indexOf('CardBack-728-light.png'), names.indexOf('CardFront-728-light.png')) +
        1,
      'after both faces',
    );
  } finally {
    repo.cleanup();
  }
});

test('text inside the safe margin of a printed piece is a problem; a bleeding picture is not', async () => {
  const { result } = await kindCheck({
    head: 'platform=print',
    inspect: () => ({
      texts: [
        text('inside', { left: 40, top: 40, width: 100, height: 14 }),
        text('too-close', { left: 14, top: 100, width: 100, height: 14 }),
        // Flush with the safe line (3 + 4 mm = 26.5 px): its font's height stands 1 px above it.
        text('flush', { left: 40, top: 25, width: 100, height: 18, size: 14.67 }),
      ],
      figures: [
        { layer: 'wash', left: 0, top: 0, width: 150, height: 100 },
        { layer: 'logo', left: 20, top: 100, width: 40, height: 40 },
      ],
    }),
  });
  assert.deepEqual(
    result.problems.map((problem) => [problem.code, problem.layer]),
    [['outside_safe_area', 'too-close']],
  );
  assert.match(result.problems[0].detail, /too-close, logo/);
});

test('a document is drawn at 700 and 390 as tall as it reads, then as printed pages; height is measured', async () => {
  const { result, shots, pairs } = await kindCheck({
    head: 'platform=doc,page=letter',
    placed: { w: 700, h: 900 },
    inspect: ({ width }) => ({
      height: width === 700 ? 2400 : 3100,
      texts: [text('line', { size: 17 })],
      headings:
        width === 816
          ? [{ layer: 'h', text: 'Stranded', left: 0, top: 1000, width: 400, height: 40 }]
          : [],
    }),
  });
  assert.deepEqual(
    shots.map((shot) => [shot.width, shot.scheme, shot.media ?? 'screen', shot.fullPage]),
    [
      [700, 'light', 'screen', true],
      [700, 'dark', 'screen', true],
      [390, 'light', 'screen', true],
      [390, 'dark', 'screen', true],
      // The probe that reads the @page margin, then the pages themselves.
      [816, 'light', 'print', true],
      [816, 'light', 'print', true],
    ],
  );
  assert.deepEqual(
    result.pictures.map((picture) => picture.name),
    [
      'Board-700-light.png',
      'Board-700-dark.png',
      'Board-390-light.png',
      'Board-390-dark.png',
      'Board-816-light.png',
    ],
  );
  assert.deepEqual(pairs.at(-1)?.layout, { kind: 'pages', pageWidth: 816, pageHeight: 1056 });
  // The height is what the 700 render needs, not the frame the canvas gave it.
  assert.deepEqual(result.heights, { 'Board.html': 2400 });
  assert.deepEqual(
    result.problems.map((problem) => [problem.code, problem.label]),
    [['height_differs', 'Board is 2400 px tall as drawn, not 900']],
  );
  // 17 px (screen) and 11pt (print) are both on --text-doc-*.
  assert.deepEqual(
    result.notes.map((note) => note.code),
    ['page_break_inside'],
  );
});

test('a logo is one sheet on each ground, and a mark that vanishes at 16 px is noted', async () => {
  const png =
    (mark: [number, number, number], ground: [number, number, number]) => (scheme: string) => {
      void scheme;
      return pngOf(256, 256, (x, y) => {
        const inside = x > 96 && x < 160 && y > 96 && y < 160;
        return inside ? mark : ground;
      });
    };
  const faint = await kindCheck({
    head: 'platform=logo',
    png: png([240, 240, 240], [255, 255, 255]),
  });
  assert.deepEqual(
    faint.result.pictures.map((p) => p.name),
    ['Board-1024-light.png', 'Board-1024-dark.png'],
  );
  assert.deepEqual(
    faint.shots.map((shot) => [shot.width, shot.height]),
    [
      [1024, 1024],
      [1024, 1024],
    ],
  );
  assert.deepEqual(faint.pairs[0].layout, { kind: 'sheet', sizes: [512, 128, 64, 32, 24, 16] });
  assert.deepEqual(
    faint.result.notes.map((note) => note.code),
    ['logo_small_unreadable'],
  );
  const bold = await kindCheck({ head: 'platform=logo', png: png([20, 20, 30], [255, 255, 255]) });
  assert.deepEqual(bold.result.notes, []);
  assert.deepEqual(bold.result.problems, []);
});

/** A mark's picture: `period` px of ink then ground, in vertical bars, on white, 128 px square. */
function barsPng(size: number, ink: number, period: number) {
  const edge = size / 16;
  return pngOf(size, size, (x, y) => {
    const along = x - edge;
    return along >= 0 && x < size - edge && y >= edge && y < size - edge && along % period < ink
      ? [20, 20, 30]
      : [255, 255, 255];
  });
}

const marksOf = (ink: number, period: number): LogoMarks => ({
  svg: '<svg/>',
  ground: 'rgb(255, 255, 255)',
  ink: 'rgb(20, 20, 30)',
  sizes: [128, 16].map((size) => ({
    size,
    png: barsPng(size, (ink * size) / 128, (period * size) / 128),
  })),
  icons: [],
});

test('a logo mark read at 16 px: a thin or crowded mark is a note naming the size, a bold one is not', async () => {
  const run = (ink: number, period: number) =>
    kindCheck({
      head: 'platform=logo',
      png: () => barsPng(256, 100, 200),
      extra: () => ({ marks: marksOf(ink, period) }),
    });
  // Bars 8 px wide in a 128 px drawing: one pixel at 16, thinner than 1.5.
  const thin = await run(8, 24);
  assert.deepEqual(
    thin.result.notes.map((note) => note.code),
    ['logo_small_unreadable'],
  );
  assert.match(thin.result.notes[0].label, /16 px/);
  assert.match(thin.result.notes[0].detail, /thinner than 1.5 px at 16 px/);
  // Bars 40 px wide, 40 px apart: three pixels at 16.
  const bold = await run(40, 80);
  assert.deepEqual(bold.result.notes, []);
  // Bars wide enough, but gaps of 8 px (one pixel at 16): they close up.
  const crowded = await run(40, 48);
  assert.deepEqual(
    crowded.result.notes.map((note) => note.code),
    ['logo_small_unreadable'],
  );
  assert.match(crowded.result.notes[0].detail, /gaps between its shapes/);
  // The picture is given the marks drawn from the mark itself.
  assert.ok(bold.pairs.every((pair) => pair.afterMarks));
});

test('a tile labelled for one ground that changes with the scheme is a note', async () => {
  const flips = await kindCheck({
    head: 'platform=logo',
    extra: ({ scheme }) => ({
      grounds: [
        {
          layer: 'tile-reversed',
          label: 'reversed',
          ground: scheme === 'dark' ? 'rgb(250, 250, 250)' : 'rgb(24, 24, 27)',
        },
        { layer: 'tile-brand', label: 'brand', ground: 'rgb(47, 91, 183)' },
      ],
    }),
  });
  const note = flips.result.notes.find((entry) => entry.code === 'logo_ground_follows_scheme');
  assert.ok(note);
  assert.match(note.detail, /tile-reversed/);
  assert.doesNotMatch(note.detail, /tile-brand/);
  const fixed = await kindCheck({
    head: 'platform=logo',
    extra: () => ({
      grounds: [{ layer: 'tile-reversed', label: 'reversed', ground: 'rgb(24, 24, 27)' }],
    }),
  });
  assert.equal(
    fixed.result.notes.some((entry) => entry.code === 'logo_ground_follows_scheme'),
    false,
  );
});

test('a logo part past its artboard or cut by its tile is a problem', async () => {
  const cut = await kindCheck({
    head: 'platform=logo',
    inspect: () => ({
      texts: [
        { layer: 'word', text: 'Harbor', left: 900, top: 400, width: 200, height: 40, size: 40 },
      ] as Inspection['texts'],
      figures: [
        {
          layer: 'tile-mark',
          left: 100,
          top: 100,
          width: 300,
          height: 300,
          cut: 40,
          frame: 'tile',
        },
      ] as Inspection['figures'],
    }),
  });
  const problem = cut.result.problems.find((entry) => entry.code === 'logo_cut_off');
  assert.ok(problem);
  assert.match(problem.detail, /word, tile-mark/);
  assert.match(problem.detail, /76 px/);
  const inside = await kindCheck({
    head: 'platform=logo',
    inspect: () => ({
      texts: [
        { layer: 'word', text: 'Harbor', left: 100, top: 400, width: 200, height: 40, size: 40 },
      ] as Inspection['texts'],
      figures: [
        { layer: 'tile-mark', left: 100, top: 100, width: 200, height: 200 },
      ] as Inspection['figures'],
    }),
  });
  assert.equal(
    inside.result.problems.some((entry) => entry.code === 'logo_cut_off'),
    false,
  );
});

test('a document printed to real sheets: the pictures are the sheets and a stranded heading is a note', async () => {
  const sheets = [Buffer.from('p1'), Buffer.from('p2')];
  const real = await kindCheck({
    head: 'platform=doc',
    inspect: ({ width }) => ({
      headings:
        width === 794
          ? [
              {
                layer: 'cancel',
                text: 'If a lesson is cancelled',
                left: 0,
                top: 900,
                width: 600,
                height: 36,
              },
            ]
          : [],
    }),
    extra: ({ media }) =>
      media === 'print' ? { pages: sheets, stranded: [{ page: 1, heading: 0 }] } : {},
  });
  const printed = real.pairs.at(-1)!;
  assert.deepEqual(printed.afterPages, sheets);
  const note = real.result.notes.find((entry) => entry.code === 'page_break_inside');
  assert.ok(note);
  assert.match(note.detail, /If a lesson is cancelled" on page 1/);
  const clean = await kindCheck({
    head: 'platform=doc',
    extra: ({ media }) => (media === 'print' ? { pages: sheets, stranded: [] } : {}),
  });
  assert.equal(
    clean.result.notes.some((entry) => entry.code === 'page_break_inside'),
    false,
  );
});

test('a slide taller than its frame is a problem; a mac window and a game screen draw once', async () => {
  const tall = await kindCheck({ head: 'platform=slide', inspect: () => ({ height: 1300 }) });
  assert.deepEqual(
    tall.result.problems.map((problem) => problem.code),
    ['taller_than_frame'],
  );
  const mac = await kindCheck({ head: 'platform=mac', canvas: { schemes: ['light', 'dark'] } });
  assert.deepEqual(
    mac.shots.map((shot) => [shot.width, shot.height, shot.scheme]),
    [
      [1280, 800, 'light'],
      [1280, 800, 'dark'],
    ],
  );
  const game = await kindCheck({ head: 'platform=game,device=phone' });
  assert.deepEqual(
    game.shots.map((shot) => [shot.width, shot.height]),
    [
      [390, 844],
      [390, 844],
    ],
  );
});

/** A PNG (8-bit RGB) of the pixels a function gives, as a browser would write one. */
function pngOf(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rows.set(pixel(x, y), y * (width * 3 + 1) + 1 + x * 3);
  const chunk = (kind: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(kind, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('a last printed page of a few lines is a note; a fuller one, or the running foot alone, is not', () => {
  // A sheet 100 x 200 with 20 px margins: the text area runs from 20 to 180. Ink is grey text
  // rows down to `to`, and a page number in the bottom margin.
  const sheet = (to: number) =>
    pngOf(100, 200, (x, y) =>
      (y >= 20 && y < to && y % 4 === 0 && x > 10 && x < 90) || (y === 190 && x > 45 && x < 55)
        ? [60, 60, 60]
        : [255, 255, 255],
    );
  const full = sheet(180);
  const margin = { top: 20, bottom: 20 };
  const note = (last: Buffer, pages = [full, last]) =>
    shortLastPageNote({ file: 'Guide.html', title: 'Guide', pages, margin, pageHeight: 200 });
  const short = note(sheet(36));
  assert.equal(short?.code, 'last_page_short');
  assert.match(short?.detail ?? '', /^page 2 of 2 is used for 8% of its text area$/);
  assert.equal(note(sheet(120)), null, 'a page half full is a page');
  assert.equal(note(sheet(20)), null, 'only the running foot: nothing to say');
  assert.equal(note(sheet(36), [sheet(36)]), null, 'one page is the whole document');
  assert.equal(
    shortLastPageNote({
      file: 'G',
      title: 'G',
      pages: [full, sheet(36)],
      margin: undefined,
      pageHeight: 200,
    }),
    null,
    'no margins read: no guess',
  );
});

test('type scales come from each platform own tokens, in pt where they say pt', () => {
  const css =
    ':root{--text-body:16px;--text-phone-body:17px;--text-mac-body:13px;--text-slide-body:32px;--text-print-body:8pt;--text-doc-body:17px}@media print{:root{--text-doc-body:11pt}}';
  const tokens = tokensFromCss(css);
  assert.deepEqual(tokens.type, [16]);
  assert.deepEqual(tokens.phoneType, [17]);
  assert.deepEqual(tokens.platformType?.mac, [13]);
  assert.deepEqual(tokens.platformType?.slide, [32]);
  assert.deepEqual(
    tokens.platformType?.print?.map((size) => Math.round(size * 100) / 100),
    [10.67],
  );
  assert.deepEqual(
    tokens.platformType?.doc?.map((size) => Math.round(size * 10) / 10),
    [14.7, 17],
  );
  assert.deepEqual(typeScaleFor(tokens, 'web'), [16]);
  assert.deepEqual(typeScaleFor(tokens, 'game'), [17], 'a game falls back to the phone scale');
  assert.deepEqual(typeScaleFor({ ...tokens, platformType: {} }, 'slide'), [], 'no scale, no note');
  assert.deepEqual(typeScaleFor(tokens, 'logo'), []);
});

test('every platform says how it is drawn: sizes, schemes and guides', () => {
  const none = parseBoardMeta(null);
  assert.deepEqual(
    drawSteps('web', none).map((step) => step.width),
    [1440, 700],
  );
  assert.deepEqual(
    drawSteps('phone', none).map((step) => [step.width, step.height]),
    [[390, 844]],
  );
  assert.deepEqual(
    drawSteps('mac', none).map((step) => [step.width, step.height]),
    [[1280, 800]],
  );
  assert.deepEqual(
    drawSteps('slide', none).map((step) => [step.width, step.height]),
    [[1920, 1080]],
  );
  assert.deepEqual(
    drawSteps('doc', none).map((step) => [step.width, step.mode]),
    [
      [700, 'screen'],
      [390, 'screen'],
      [794, 'pages'],
    ],
  );
  assert.equal(drawnAt('print', none), '85×55 mm trim, 3 mm bleed, 4 mm safe, at 8 px/mm');
  assert.deepEqual(platformSchemes('slide', ['light', 'dark']), ['light', 'dark']);
  assert.deepEqual(platformSchemes('print', ['light', 'dark']), ['light']);
  assert.deepEqual(platformSchemes('doc', null), ['light', 'dark']);
  assert.equal(platformInfo('logo').appChecks, false);
  assert.deepEqual(
    printGeometry(
      parseBoardMeta('<meta name="design-board" content="size=100x70mm,bleed=2mm,safe=5mm">'),
    ).trim,
    { w: 100, h: 70 },
  );
  assert.equal(
    drawSteps(
      'game',
      parseBoardMeta('<meta name="design-board" content="width=800,height=480">'),
    )[0].width,
    800,
  );
});

// ── What the check says about style, the sides, scales, heights and iPhone games ────────────────

test('inline style with a design value is a note naming the board and layer; data and library markup are not', () => {
  const page = (body: string, head = '') =>
    `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
  const after = page(
    '<div data-layer="card" style="margin-top: 4mm; color: #123456">a</div>' +
      '<div data-layer="bar" style="--w: 62%">b</div>' +
      '<div data-layer="hidden" style="display: none">c</div>' +
      '<div data-component="row" data-layer="inst"><span data-layer="inner" style="padding: 9px">d</span></div>',
  );
  const [note, ...rest] = inlineStyleNotes({
    file: 'Card.html',
    title: 'Card',
    before: null,
    after,
  });
  assert.equal(rest.length, 0);
  assert.equal(note.code, 'inline_style');
  assert.equal(note.layer, 'card', 'one layer: named');
  assert.match(note.detail, /2 inline values on card/);
  assert.match(note.fix ?? '', /kind's css .* as a class/);
  // What main's board already had is not new.
  assert.deepEqual(
    inlineStyleNotes({ file: 'Card.html', title: 'Card', before: after, after }),
    [],
  );
});

test('a style block for html and body, or a design-system class, is a note; the starter idiom is not', () => {
  const page = (css: string) =>
    `<html><head><style>${css}</style></head><body><div data-layer="a">x</div></body></html>`;
  const idiom = page('html, body { margin: 0; background: var(--bg); }');
  assert.deepEqual(
    inlineStyleNotes({ file: 'A.html', title: 'A', before: null, after: idiom }),
    [],
  );
  const body = page('html, body { margin: 0; background: #fff; font-size: 14px }');
  assert.match(
    inlineStyleNotes({ file: 'A.html', title: 'A', before: null, after: body })[0].detail,
    /a <style> block sets html, body/,
  );
  const redefined = page('.ds-game-tile { border-radius: 4px }');
  assert.match(
    inlineStyleNotes({ file: 'A.html', title: 'A', before: null, after: redefined })[0].detail,
    /\.ds-game-tile/,
  );
  const known = page('.tile { gap: 2px } .postcard { gap: 2px }');
  assert.equal(
    inlineStyleNotes({
      file: 'A.html',
      title: 'A',
      before: null,
      after: known,
      systemClasses: new Set(['tile']),
    }).length,
    1,
  );
  assert.deepEqual(
    inlineStyleNotes({ file: 'A.html', title: 'A', before: null, after: known }),
    [],
    'a class the board makes itself is its own',
  );
});

const sideHit = (extra: Record<string, unknown> = {}) => ({
  layer: 'room-4',
  text: '4',
  side: 'right' as const,
  by: 'frame' as const,
  frame: 'rooms-screen',
  amount: 46,
  plain: false,
  ...extra,
});

test("content cut at the side is one problem for each edge; main's cuts, print bleed and a web page edge are not", () => {
  const after = inspection({
    clippedSide: [
      sideHit(),
      sideHit({ layer: 'room-8' }),
      sideHit({ layer: 'glow', by: 'page', frame: null, plain: true }),
    ],
  });
  const found = cutOffSideProblems({
    file: 'Rooms.html',
    title: 'Rooms',
    width: 390,
    after,
    before: null,
    platform: 'game',
  });
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.short]),
    [
      ['cut_off_side', 'cut off at the right'],
      ['cut_off_side', 'cut off at the right'],
    ],
  );
  assert.match(found[0].label, /2 layers cut off at rooms-screen's right edge/);
  assert.match(found[0].detail, /room-4, room-8/);
  assert.deepEqual(
    cutOffSideProblems({
      file: 'Rooms.html',
      title: 'Rooms',
      width: 390,
      after,
      before: after,
      platform: 'game',
    }),
    [],
  );
  // A print piece's plain shapes run into the bleed on purpose; its text does not.
  const print = cutOffSideProblems({
    file: 'Card.html',
    title: 'Card',
    width: 400,
    after: inspection({
      clippedSide: [sideHit({ layer: 'wash', by: 'page', frame: null, plain: true })],
    }),
    before: null,
    platform: 'print',
  });
  assert.deepEqual(print, []);
  // The page's edge is judged only where the page has a fixed width.
  const web = cutOffSideProblems({
    file: 'W.html',
    title: 'W',
    width: 1440,
    after: inspection({ clippedSide: [sideHit({ by: 'page', frame: null })] }),
    before: null,
    platform: 'web',
  });
  assert.deepEqual(web, []);
});

test('each platform is held to its own type scale and spacing scale, kit by kit', () => {
  const css =
    ':root{--text-body:16px;--space-1:4px;--space-2:8px;--text-phone-body:17px;--text-game-body:17px;--text-game-title:28px;--text-mac-body:13px;--text-slide-body:32px;--text-print-body:8pt;--text-doc-body:17px;--space-slide-1:40px;--space-slide-2:80px}';
  const scale = tokensFromCss(css);
  assert.deepEqual(typeScaleFor(scale, 'game'), [17, 28], 'game has its own, not the phone');
  assert.deepEqual(typeScaleFor(scale, 'phone'), [17]);
  assert.deepEqual(typeScaleFor(scale, 'mac'), [13]);
  assert.deepEqual(typeScaleFor(scale, 'slide'), [32]);
  assert.deepEqual(typeScaleFor(scale, 'doc'), [17]);
  assert.equal(typeScaleFor(scale, 'print').length, 1);
  assert.deepEqual(typeScaleFor(scale, 'logo'), []);
  // A 22 px label is on the phone scale of a design system and off a game's.
  const withPhone = tokensFromCss(`${css}:root{--text-phone-title:22px}`);
  assert.ok(typeScaleFor(withPhone, 'phone').includes(22));
  assert.ok(!typeScaleFor(withPhone, 'game').includes(22));
  // The scales survive a scale.json beside the kit stylesheets.
  const json = JSON.stringify({
    color: { scale: [{ name: 'ink', value: '#111111' }] },
    type: { groups: [{ name: 'App', styles: [{ fontSize: '16px' }] }] },
  });
  const merged = readTokens(json, css);
  assert.deepEqual(typeScaleFor(merged, 'game'), [17, 28]);
  assert.deepEqual(typeScaleFor(merged, 'mac'), [13]);
  // Spacing: the base scale in px for screens; none for slides and print without a scale of their own.
  assert.deepEqual(spaceScaleFor(scale, 'game'), [4, 8]);
  assert.deepEqual(spaceScaleFor(scale, 'logo'), []);
  assert.deepEqual(spaceScaleFor(scale, 'print'), []);
  assert.deepEqual(
    spaceScaleFor(scale, 'slide'),
    [40, 80],
    "a slide's own scale, when its kit has one",
  );
  assert.deepEqual(scale.space, [4, 8], 'the base scale leaves the kits scales out');
});

test('spacing off the scale is a note on screens, and none on a slide or print piece without a scale', () => {
  const scale = tokensFromCss(':root{--space-1:4px;--space-2:8px}');
  const sample = '<div data-layer="a" style="padding: 13px 8px; margin-top: 30mm">x</div>';
  const run = (platform: string) =>
    spacingNotes({
      file: 'A.html',
      title: 'A',
      before: null,
      after: sample,
      tokens: scale,
      platform,
    });
  assert.deepEqual(
    run('game').map((note) => note.short),
    ['13 px spacing'],
  );
  assert.deepEqual(
    run('mac').map((note) => note.short),
    ['13 px spacing'],
  );
  assert.deepEqual(run('slide'), []);
  assert.deepEqual(run('print'), []);
});

test('--fix never sets a height under what the content needs', () => {
  // A window drawn at 100% of a 100 px page: the short window gives 100 back; the content needs 281.
  assert.equal(
    fixedHeight({ platform: 'mac', fixedFrame: true, metaHeight: 300, natural: 100, needed: 281 }),
    300,
    'a frame is the size its head says',
  );
  assert.equal(
    fixedHeight({ platform: 'mac', fixedFrame: true, metaHeight: 120, natural: 100, needed: 281 }),
    281,
    'but never shorter than its content',
  );
  assert.equal(
    fixedHeight({ platform: 'mac', fixedFrame: true, metaHeight: null, natural: 100, needed: 281 }),
    281,
  );
  assert.equal(
    fixedHeight({
      platform: 'web',
      fixedFrame: false,
      metaHeight: 900,
      natural: 1240,
      needed: 1240,
    }),
    1240,
    'a page is as tall as it reads',
  );
  assert.equal(
    fixedHeight({
      platform: 'web',
      fixedFrame: false,
      metaHeight: 900,
      natural: 100,
      needed: 640.4,
    }),
    641,
  );
});

test('a mac window whose short drawing gives 100 px is fixed to its head height, never the 100', async () => {
  const { result } = await kindCheck({
    head: 'platform=mac,width=640,height=300',
    placed: { w: 640, h: 320 },
    inspect: ({ width }) => ({ needed: width === 640 ? 281 : undefined, height: 100 }),
  });
  // The short window gives 100 back, the head says 300, the content needs 281: 300 wins.
  assert.deepEqual(result.heights, { 'Board.html': 300 });
});

test('a game on a phone keeps clear of the status bar and home indicator unless it is immersive; a status bar is noted when missing', async () => {
  const inside = {
    texts: [
      text('title', { left: 40, top: 70, width: 100, height: 28 }),
      text('clock', { left: 44, top: 20, width: 40, height: 20 }),
      text('badge', { left: 40, top: 30, width: 60, height: 16 }),
      text('footer', { left: 40, top: 825, width: 100, height: 16 }),
      text('below', { left: 40, top: 900, width: 100, height: 16 }),
    ],
    statusBars: [{ layer: 'statusbar', left: 0, top: 0, width: 390, height: 54 }],
  };
  const problems = screenSafeAreaProblems({
    file: 'Play.html',
    title: 'Play',
    inspection: inspection(inside),
    platform: 'game',
    width: 390,
    height: 844,
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].code, 'outside_safe_area');
  // The clock and the badge sit in the status bar and "below" is scrolled out of the screen, so only
  // the footer, in the home indicator's room, is found.
  assert.match(problems[0].detail, /footer/);
  assert.doesNotMatch(problems[0].detail, /clock|below|title/);
  assert.deepEqual(
    screenSafeAreaProblems({
      file: 'Play.html',
      title: 'Play',
      inspection: inspection(inside),
      platform: 'game',
      width: 390,
      height: 844,
      immersive: true,
    }),
    [],
  );
  assert.equal(phoneScreen('phone', 390, 844), null, 'an app phone board is not held to it');
  assert.equal(phoneScreen('game', 1280, 720), null, 'a game on a bigger screen has no safe areas');
  assert.deepEqual(phoneScreen('game', 844, 390), { landscape: true });
  const side = screenSafeAreaProblems({
    file: 'Play.html',
    title: 'Play',
    inspection: inspection({ texts: [text('hud', { left: 20, top: 100 })] }),
    platform: 'game',
    width: 844,
    height: 390,
  });
  assert.match(side[0].label, /54 px at the sides/);
  const noBar = statusBarNote({
    file: 'Play.html',
    title: 'Play',
    inspection: inspection(),
    platform: 'game',
    width: 390,
    height: 844,
  });
  assert.equal(noBar?.code, 'no_status_bar');
  assert.equal(
    statusBarNote({
      file: 'Play.html',
      title: 'Play',
      inspection: inspection(inside),
      platform: 'game',
      width: 390,
      height: 844,
    }),
    null,
  );
  assert.equal(
    statusBarNote({
      file: 'Play.html',
      title: 'Play',
      inspection: inspection(),
      platform: 'game',
      width: 390,
      height: 844,
      immersive: true,
    }),
    null,
  );
});

test('the check draws a phone game with its safe areas and status bar, and immersive=true opts out', async () => {
  const bar = { layer: 'statusbar', left: 0, top: 0, width: 390, height: 54 };
  const drawn = await kindCheck({
    head: 'platform=game,device=phone',
    inspect: () => ({
      texts: [text('hud', { left: 30, top: 10, width: 60, height: 16 })],
      statusBars: [],
    }),
  });
  assert.deepEqual(
    drawn.result.problems.map((problem) => problem.code),
    ['outside_safe_area'],
  );
  assert.ok(drawn.result.notes.some((note) => note.code === 'no_status_bar'));
  const immersive = await kindCheck({
    head: 'platform=game,device=phone,immersive=true',
    inspect: () => ({ texts: [text('hud', { left: 30, top: 10, width: 60, height: 16 })] }),
  });
  assert.deepEqual(immersive.result.problems, []);
  assert.ok(!immersive.result.notes.some((note) => note.code === 'no_status_bar'));
  const fine = await kindCheck({
    head: 'platform=game,device=phone',
    inspect: () => ({
      texts: [text('hud', { left: 30, top: 70, width: 60, height: 16 })],
      statusBars: [bar],
    }),
  });
  assert.deepEqual(fine.result.problems, []);
  assert.ok(!fine.result.notes.some((note) => note.code === 'no_status_bar'));
});

test('the starter page reset, in any spelling, is not an inline style; other page rules are', () => {
  const page = (css: string) =>
    `<html><head><style>${css}</style></head><body><div data-layer="a">x</div></body></html>`;
  const notes = (css: string) =>
    inlineStyleNotes({ file: 'A.html', title: 'A', before: null, after: page(css) }).length;
  assert.equal(notes('html,body{margin:0;background:var(--bg-sunken)}'), 0);
  assert.equal(
    notes(
      'html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); color-scheme: light dark }',
    ),
    0,
  );
  assert.equal(notes('body{margin:0;min-height:100vh;background:var(--bg) !important}'), 0);
  assert.equal(notes('body{margin:0;background:#fff}'), 1);
  assert.equal(notes('body{font-family:serif}'), 1);
});

test('new boards go right of the starting board in the order they are read, never back across the canvas', () => {
  // Round 4's game: the starting board at 0, then Levels, Lit and Play landed right to left at
  // negative x because the alphabet put them before Title.
  assert.equal(knownOrder('GameLevels.html', 'GameTitle.html'), null);
  assert.ok(knownOrder('CardFront.html', 'CardBack.html')! < 0);
  assert.equal(knownOrder('PostcardFront.html', 'CardBack.html'), null);
  const size = { w: 390, h: 844 };
  const canvas: any = { boards: { 'GameTitle.html': { x: 0, y: 0, ...size } } };
  // init's canvas lists only the starting board; the rest are placed as the check finds them.
  for (const file of ['GameLevels.html', 'GameLit.html', 'GamePlay.html']) {
    const spot = placeBoard({
      canvas,
      file,
      size,
      near: null,
      siblings: Object.keys(canvas.boards),
      order: ['GameTitle.html'],
    });
    canvas.boards[file] = { x: spot.x, y: spot.y, ...size };
  }
  const xs = ['GameTitle.html', 'GameLevels.html', 'GameLit.html', 'GamePlay.html'].map(
    (file) => canvas.boards[file].x,
  );
  assert.deepEqual(
    xs,
    [...xs].sort((a, b) => a - b),
  );
  assert.ok(xs.every((x) => x >= 0));
  assert.ok(Object.values(canvas.boards).every((placed: any) => placed.y === 0));

  // A card and a postcard of different sizes: each front before its back, all in one row, even
  // when a board is placed before the board it follows.
  const card = { w: 504, h: 296 };
  const post = { w: 1216, h: 816 };
  const print: any = { boards: { 'CardFront.html': { x: 0, y: 0, ...card } } };
  const sizes: Record<string, { w: number; h: number }> = {
    'CardBack.html': card,
    'PostcardFront.html': post,
    'PostcardBack.html': post,
  };
  for (const file of Object.keys(sizes).sort((a, b) => boardOrder(a, b))) {
    const spot = placeBoard({
      canvas: print,
      file,
      size: sizes[file],
      near: null,
      siblings: Object.keys(print.boards),
    });
    print.boards[file] = { x: spot.x, y: spot.y, ...sizes[file] };
  }
  const at = (file: string) => print.boards[file];
  assert.ok(Object.values(print.boards).every((placed: any) => placed.y === 0));
  assert.ok(at('CardFront.html').x < at('CardBack.html').x);
  assert.ok(at('CardBack.html').x < at('PostcardFront.html').x);
  assert.ok(at('PostcardFront.html').x < at('PostcardBack.html').x);
});

test('new boards go in a row with their kind, in name and number order, wrapping past six', () => {
  assert.ok(boardOrder('Slide2.html', 'Slide10.html') < 0);
  assert.ok(boardOrder('CardFront.html', 'CardBack.html') < 0);
  const canvas: any = {
    boards: {
      'Slide1.html': { x: 0, y: 0, w: 1920, h: 1080 },
      'Slide2.html': { x: 2080, y: 0, w: 1920, h: 1080 },
      'Slide4.html': { x: 6240, y: 0, w: 1920, h: 1080 },
    },
  };
  const size = { w: 1920, h: 1080 };
  const siblings = Object.keys(canvas.boards);
  // Slide3 goes after Slide2 when the place is free, which it is not here (Slide4 is 2080 on).
  const third = placeBoard({ canvas, file: 'Slide3.html', size, near: null, siblings });
  assert.deepEqual([third.x, third.y], [4160, 0]);
  const later = { boards: { ...canvas.boards, 'Slide3.html': { x: 4160, y: 0, ...size } } };
  const before = placeBoard({
    canvas: { boards: { 'Slide2.html': later.boards['Slide2.html'] } },
    file: 'Slide1.html',
    size,
    near: null,
    siblings: ['Slide2.html'],
  });
  assert.deepEqual([before.x, before.y], [0, 0]);
  const row = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((n) => [`Slide${n}.html`, { x: (n - 1) * 2080, y: 0, ...size }]),
  );
  const wrapped = placeBoard({
    canvas: { boards: row },
    file: 'Slide7.html',
    size,
    near: null,
    siblings: Object.keys(row),
  });
  assert.deepEqual([wrapped.x, wrapped.y], [0, 1240]);
});
