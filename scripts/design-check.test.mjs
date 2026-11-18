import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { syncInstances } from '../server/design/board-html.ts';
import {
  boardWords,
  brokenLinks,
  canvasProblems,
  changedBoardFiles,
  changedComponents,
  checkWidths,
  instanceOnly,
  lostLayers,
  overflowProblems,
  partRow,
} from './design-check.mjs';

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
    })[0].label,
    'P overflows at 700 px',
  );
  assert.deepEqual(overflowProblems('P.html', 'P', undefined), []);
});

const library = (label) => ({
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
const instance = (text, place = 'Home') =>
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

test('--drop-instances puts carried boards back as main has them and the check passes', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'design-check.mjs');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'design-check-parts-')));
  const run = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run(['init', '-q', '--initial-branch=main']);
    run(['config', 'user.name', 'Test']);
    run(['config', 'user.email', 'test@example.invalid']);
    const path = 'design/ds/deploy-local/components/library.json';
    mkdirSync(join(root, 'design/boards'), { recursive: true });
    mkdirSync(join(root, 'design/ds/deploy-local/components'), { recursive: true });
    const write = (file, text) => writeFileSync(join(root, file), text);
    const boards = ['Alpha.html', 'Beta.html', 'Gamma.html'];
    write(path, JSON.stringify(library('deploy.local')));
    for (const file of boards)
      write(`design/boards/${file}`, syncInstances(instance(file), library('deploy.local')));
    write(
      'design/canvas.json',
      JSON.stringify({
        boards: Object.fromEntries(boards.map((file) => [file, { x: 0, y: 0, w: 1440, h: 900 }])),
      }),
    );
    run(['add', '.']);
    run(['commit', '-qm', 'Main']);
    run(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const main = Object.fromEntries(
      boards.map((file) => [file, readFileSync(join(root, 'design/boards', file), 'utf8')]),
    );
    run(['checkout', '-qb', 'design/sidebar']);
    write(path, JSON.stringify(library('Projects')));
    // Two boards come along re-synced; Gamma is left to the landing.
    for (const file of ['Alpha.html', 'Beta.html'])
      write(`design/boards/${file}`, syncInstances(main[file], library('Projects')));
    run(['commit', '-qam', 'Sidebar shows projects']);
    const check = (...flags) => {
      const ran = spawnSync(process.execPath, [script, '--base', 'origin/main', ...flags], {
        cwd: root,
        encoding: 'utf8',
      });
      return { code: ran.status, result: JSON.parse(ran.stdout.trim().split('\n').at(-1)) };
    };
    const carried = check();
    assert.equal(carried.code, 1);
    assert.deepEqual(
      carried.result.boards.map((board) => [board.title, board.words]),
      [['Sidebar', '3 screens']],
      'the part is one row; the carried boards are not rows of their own',
    );
    assert.deepEqual(
      carried.result.problems.map((problem) => problem.label),
      ['Sidebar is carried on 2 screens'],
    );
    assert.equal(carried.result.drawn, 0, 'nothing of the branch’s own to draw');
    assert.equal(carried.result.dropped, undefined);

    const fixed = check('--drop-instances');
    assert.equal(fixed.code, 0, JSON.stringify(fixed.result));
    assert.equal(fixed.result.dropped, 2);
    assert.deepEqual(fixed.result.problems, []);
    assert.deepEqual(
      fixed.result.boards.map((board) => [board.title, board.words]),
      [['Sidebar', '3 screens']],
    );
    for (const file of boards)
      assert.equal(readFileSync(join(root, 'design/boards', file), 'utf8'), main[file]);
    // Only the library is left to change against main.
    assert.equal(run(['diff', '--name-only', 'origin/main']).trim(), path);
    assert.equal(check().code, 0, 'nothing to drop the second time');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
