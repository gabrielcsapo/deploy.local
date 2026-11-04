import assert from 'node:assert/strict';
import test from 'node:test';
import {
  initialDesignProject,
  nextUnseen,
  openPins,
  reviewCounts,
  reviewCrop,
  counted,
} from './review-model.ts';

test('review counts use singular only for one pin, change or screen', () => {
  for (const noun of ['pin', 'change', 'screen'] as const) {
    assert.equal(counted(0, noun), `0 ${noun}s`);
    assert.equal(counted(1, noun), `1 ${noun}`);
    assert.equal(counted(2, noun), `2 ${noun}s`);
  }
});

test('Design resumes only the named or last usable project and never an arbitrary first project', () => {
  const projects = [
    { id: 'empty', boards: 0 },
    { id: 'site', boards: 22 },
    { id: 'tally', boards: 5 },
  ];
  assert.equal(initialDesignProject(projects, null, 'site'), 'site');
  assert.equal(initialDesignProject(projects, 'tally', 'site'), 'tally');
  assert.equal(initialDesignProject(projects, 'empty', 'site'), null);
  assert.equal(initialDesignProject(projects, null, 'deleted'), null);
  assert.equal(initialDesignProject(projects, null, null), null);
});

test('Next unseen follows page order, wraps once and finishes without gating approval', () => {
  const boards = [
    { file: 'Beta.html', seen: false },
    { file: 'New.html', seen: true },
    { file: 'Alpha.html', seen: false },
  ];
  assert.equal(nextUnseen(boards), 'Beta.html');
  assert.equal(nextUnseen(boards, 'Beta.html'), 'Alpha.html');
  assert.equal(nextUnseen(boards, 'Alpha.html'), 'Beta.html');
  assert.equal(nextUnseen(boards.map((board) => ({ ...board, seen: true }))), null);
  assert.equal(nextUnseen([]), null);
});

test('crop includes the complete largest region and 48px context, clamped to the native board', () => {
  assert.deepEqual(
    reviewCrop(1440, 1380, [
      { x: 300, y: 100, w: 460, h: 300 },
      { x: 1000, y: 900, w: 100, h: 40 },
    ]),
    { x: 252, y: 52, w: 556, h: 396 },
  );
  assert.deepEqual(reviewCrop(390, 844, [{ x: 0, y: 0, w: 390, h: 844 }]), {
    x: 0,
    y: 0,
    w: 390,
    h: 844,
  });
  assert.deepEqual(reviewCrop(1440, 900, []), { x: 0, y: 0, w: 720, h: 520 });
});

test('counts and decisions include all unresolved pins, including pins on other screens', () => {
  assert.equal(
    reviewCounts({ screens: 22, changed: 9, new: 12, removed: 1 }),
    '22 screens · 9 changed · 12 new · 1 removed',
  );
  const pin = {
    id: '1',
    number: 1,
    board: 'Alpha.html',
    noteId: null,
    width: 1440,
    revision: 'a',
    x: 2,
    y: 3,
    text: 'Keep it visible',
    author: 'owner',
    resolved: false,
    reply: null,
    createdAt: '',
  };
  const pins = [
    pin,
    { ...pin, id: '2', number: 2, resolved: true },
    { ...pin, id: '3', number: 3, board: 'Beta.html' },
  ];
  assert.deepEqual(
    openPins({ pins }).map((pin) => pin.id),
    ['1', '3'],
  );
});

test('a changed crop expands to whole neighbouring text and inputs instead of slicing them', () => {
  assert.deepEqual(
    reviewCrop(
      1440,
      900,
      [{ x: 300, y: 100, w: 200, h: 100 }],
      [
        { x: 300, y: 235, w: 300, h: 44 },
        { x: 310, y: 500, w: 100, h: 30 },
      ],
    ),
    { x: 252, y: 52, w: 348, h: 227 },
  );
});
