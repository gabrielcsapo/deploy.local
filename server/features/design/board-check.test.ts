import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
  checkWidths,
  instanceOnly,
  lostLayers,
  overflowProblems,
  partRow,
  type CheckDrawing,
} from './board-check.ts';

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
    lostLayers(main, '<div data-layer="page"><h1 data-layer="title">New</h1></div>'),
    ['menu'],
  );
  assert.deepEqual(lostLayers(null, main), [], 'a new board loses nothing');
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
      file: 'Projects.html',
      label: 'Projects is cut off at 700 px',
      detail: '"Show archived" leaves the page',
      short: 'cut off at 700 px',
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
      file: 'part:sidebar',
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
        ['Projects', 'New Show archived · Menu removed', ['lost layer menu', 'cut off at 700 px']],
        ['Trade', 'New board', ['links to Harbor.html']],
      ],
    );
    assert.deepEqual(
      result.problems.map((problem) => `${problem.label} · ${problem.detail}`),
      [
        'Projects lost layer menu · main has it; keep its ID',
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
