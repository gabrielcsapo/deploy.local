import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boardWords,
  brokenLinks,
  canvasProblems,
  changedBoardFiles,
  checkWidths,
  lostLayers,
  overflowProblems,
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
