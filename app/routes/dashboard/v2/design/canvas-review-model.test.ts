import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesignReview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import type { Comment } from './Comments';
import {
  frameSource,
  reviewBranch,
  reviewCanvas,
  reviewFeedback,
  reviewFrames,
  reviewKey,
  reviewProject,
  seenFrame,
  stepFrame,
} from './canvas-review-model';

const screen = (file: string, fields: Partial<DesignReviewScreen> = {}): DesignReviewScreen => ({
  file,
  title: file,
  w: 1440,
  h: 900,
  widths: [1440, 700],
  page: null,
  pageId: null,
  index: null,
  count: null,
  notes: null,
  added: false,
  removed: false,
  status: 'changed',
  before: 'base',
  after: 'proposal',
  changes: [],
  lines: [],
  seen: false,
  changedSinceReview: true,
  conflict: false,
  ...fields,
});
const boards = [
  screen('Removed.html', { removed: true }),
  screen('New.html', { added: true }),
  screen('Changed.html'),
];
const review = {
  id: 'design:p:design~gutter:abc',
  after: 'proposal',
  createdAt: '2026-11-12T10:00:00Z',
  boards,
  groups: [{ id: 'one', title: 'One', boards: ['Changed.html', 'New.html'] }],
} as DesignReview;

test('review identity and branch survive entry links without the inbox being loaded', () => {
  assert.equal(reviewProject(review.id), 'p');
  assert.equal(reviewBranch(review.id), 'design/gutter');
  assert.equal(reviewProject('question:x'), null);
});

test('navigation follows canvas groups across pages and retains removed frames at the end', () => {
  const ordered = reviewFrames(review);
  assert.deepEqual(
    ordered.map((board) => board.file),
    ['Changed.html', 'New.html', 'Removed.html'],
  );
  assert.equal(stepFrame(ordered, 'Changed.html', -1), 'Changed.html');
  assert.equal(stepFrame(ordered, 'New.html', 1), 'Removed.html');
  assert.equal(stepFrame(ordered, 'Removed.html', 1), 'Removed.html');
  assert.equal(stepFrame(ordered, 'Removed.html', -1), 'New.html');
  assert.equal(stepFrame([], undefined, 1), null);
});

test('removed boards keep their original canvas position without mutating either canvas', () => {
  const frame = { x: 12000, y: 300, w: 1440, h: 900 };
  const before = { boards: { 'Removed.html': frame } };
  const after = {
    boards: { 'New.html': { ...frame, y: 1400 } },
    notes: { note: { x: 10, y: 20, text: 'Gutter' } },
  };
  const combined = reviewCanvas(after, before, boards)!;
  assert.equal(combined.boards['Removed.html'], frame);
  assert.equal(combined.notes, after.notes);
  assert.equal('Removed.html' in after.boards, false);
  assert.equal(frameSource(boards[0], 'after'), null);
  assert.equal(frameSource(boards[0], 'before'), 'base');
  assert.equal(frameSource(boards[1], 'before'), null);
  assert.equal(frameSource(boards[1], 'after'), 'proposal');
  assert.equal(frameSource(boards[2], 'before'), 'base');
});

test('Space and arrows respect text input, shortcuts, and key repeat', () => {
  const key = { key: ' ', repeat: false, metaKey: false, ctrlKey: false, altKey: false };
  assert.equal(reviewKey(key, false), 'approve');
  assert.equal(reviewKey({ ...key, key: 'ArrowLeft' }, false), 'previous');
  assert.equal(reviewKey({ ...key, key: 'ArrowRight' }, false), 'next');
  assert.equal(reviewKey(key, true), null);
  assert.equal(reviewKey({ ...key, repeat: true }, false), null);
  assert.equal(reviewKey({ ...key, metaKey: true }, false), null);
  assert.equal(reviewKey({ ...key, ctrlKey: true }, false), null);
  assert.equal(reviewKey({ ...key, altKey: true }, false), null);
});

test('saving a checkbox only marks that frame and cannot mark a newer revision seen', () => {
  const saved = seenFrame(review, 'Changed.html', 'proposal');
  assert.deepEqual(
    saved.boards.map((board) => board.seen),
    [false, false, true],
  );
  assert.deepEqual(
    review.boards.map((board) => board.seen),
    [false, false, false],
  );
  assert.equal(
    seenFrame({ ...review, after: 'new-proposal' }, 'Changed.html', 'proposal').boards,
    review.boards,
  );
});

test('feedback preserves layer comments and durable branch suggestions, excluding unrelated comments', () => {
  const comment = {
    id: 'comment',
    board: 'Changed.html',
    layer: 'title',
    text: 'Keep this bold',
    commit: 'proposal',
    resolved: false,
    createdAt: '2026-11-12T12:00:00Z',
  } as Comment;
  const feedback = reviewFeedback(
    review,
    [
      comment,
      { ...comment, commit: 'another-branch', text: 'Unrelated' },
      { ...comment, resolved: true, text: 'Resolved' },
    ],
    'design/gutter',
    'edited-commit',
  );
  assert.match(feedback, /Changed.html › title\nKeep this bold/);
  assert.match(feedback, /design\/gutter at edited-commit/);
  assert.match(feedback, /proposed design at proposal/);
  assert.doesNotMatch(feedback, /Unrelated|Resolved/);
  assert.equal(reviewFeedback(review, [], 'design/gutter', 'proposal'), '');
});
