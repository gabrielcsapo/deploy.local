import assert from 'node:assert/strict';
import test from 'node:test';
import type { DesignReview, DesignReviewScreen } from '../../../../../shared/v2/contracts';
import type { Comment } from './Comments';
import {
  frameSource,
  frameTicked,
  reviewBranch,
  reviewCanvas,
  reviewFeedback,
  reviewFrames,
  reviewKey,
  reviewProject,
  comparedWidth,
  frameTag,
  reviewProgress,
  reviewUnits,
  seenFrame,
  sinceLastReview,
  stepFrame,
  wipeStep,
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

test('a shared part is one unit, ticked with the screen it is looked at on', () => {
  const grouped = {
    ...review,
    boards: [
      screen('Welcome.html', { title: 'Welcome', seen: true }),
      screen('Narrow.html', { title: 'Welcome, narrow' }),
      screen('Install.html', { title: 'Install an app' }),
      screen('Beta.html', { title: 'Beta', instanceOnly: true }),
    ],
    groups: [
      {
        id: 'one',
        title: 'One',
        boards: ['Welcome.html', 'Narrow.html', 'Install.html', 'Beta.html'],
      },
    ],
    parts: [
      {
        component: 'sidebar',
        name: 'Sidebar',
        screens: 242,
        lookAt: { file: 'Welcome.html', title: 'Welcome' },
        seen: false,
      },
    ],
  } as DesignReview;
  const units = reviewUnits(grouped);
  // The screen shown only for a part is not a unit of its own.
  assert.deepEqual(
    units.map((unit) => [unit.title, unit.seen]),
    [
      ['Sidebar · 242 screens', false],
      ['Welcome', true],
      ['Welcome, narrow', false],
      ['Install an app', false],
    ],
  );
  // Welcome was seen in an earlier round, but the part on it was not: its box is not ticked.
  assert.equal(frameTicked(grouped, grouped.boards[0]), false);
  const ticked = seenFrame(grouped, 'Welcome.html', 'proposal');
  assert.equal(frameTicked(ticked, ticked.boards[0]), true);
  assert.deepEqual(
    reviewUnits(ticked).map((unit) => unit.seen),
    [true, true, false, false],
  );
  assert.equal(reviewUnits({ ...review, parts: undefined }).length, 3, 'older coordinators');
});

// The Round2 board: Welcome seen in round 1 and unchanged, Welcome narrow and Install an app changed.
const pin = (id: string, fields: Partial<DesignReview['pins'][number]>) =>
  ({
    id,
    number: 1,
    board: 'Narrow.html',
    noteId: null,
    width: 1440,
    revision: 'r1',
    x: 0,
    y: 0,
    text: '',
    author: 'owner',
    resolved: false,
    reply: null,
    createdAt: '2026-11-10T00:00:00.000Z',
    round: 1,
    ...fields,
  }) as DesignReview['pins'][number];
const second = {
  round: 2,
  createdAt: '2026-11-12T00:00:00.000Z',
  boards: [
    screen('Welcome.html', {
      title: 'Welcome',
      seen: true,
      seenInRound: 1,
      changedSinceReview: false,
    }),
    screen('Narrow.html', { title: 'Welcome, narrow', seen: true, seenInRound: 2 }),
    screen('Install.html', { title: 'Install an app' }),
  ],
  groups: [{ id: null, title: null, boards: ['Welcome.html', 'Narrow.html', 'Install.html'] }],
  notes: [],
  pins: [
    pin('a', {
      number: 1,
      text: 'Keep the gutter at 16 here too.',
      resolved: true,
      reply: 'Gutter is 16 at every width now.',
    }),
    pin('b', {
      number: 2,
      board: 'Install.html',
      text: 'The app card should say who made it.',
      reply: 'Kept the size; the maker does not fit at 700.',
    }),
    pin('c', { number: 3, round: 2, text: 'A note made this round.' }),
  ],
} as unknown as DesignReview;

test('a later round counts only what changed since the last review; round one is unchanged', () => {
  assert.deepEqual(reviewProgress(second), {
    round: 'round 2',
    count: '1 of 2 changed screens approved',
  });
  assert.deepEqual(reviewProgress({ ...second, round: 1 }), {
    round: null,
    count: '2 of 3 approved',
  });
  const one = { ...second, boards: second.boards.slice(0, 2) };
  assert.equal(reviewProgress(one).count, '1 of 1 changed screen approved');
  // A shared part as it was last round is not counted; one changed again is, once.
  const part = {
    component: 'sidebar',
    name: 'Sidebar',
    screens: 3,
    lookAt: { file: 'Welcome.html', title: 'Welcome' },
    seen: true,
  };
  assert.equal(
    reviewProgress({ ...second, parts: [{ ...part, changedSinceReview: false }] }).count,
    '1 of 2 changed screens approved',
  );
  assert.equal(
    reviewProgress({ ...second, parts: [{ ...part, seen: false, changedSinceReview: true }] })
      .count,
    '1 of 3 changed screens approved',
  );
});

test('a frame seen in an earlier round and unchanged since is tagged with that round', () => {
  const [welcome, narrow, install] = second.boards;
  assert.deepEqual(frameTag(second, welcome), { text: 'Seen in round 1', changed: false });
  // Ticked this round, or changed since: still Changed.
  assert.deepEqual(frameTag(second, narrow), { text: 'Changed', changed: true });
  assert.deepEqual(frameTag(second, install), { text: 'Changed', changed: true });
  assert.equal(frameTag({ ...second, round: 3 }, welcome).text, 'Seen in round 1');
  // Older coordinators do not say when: the previous round.
  assert.equal(
    frameTag({ ...second, round: 3 }, { ...welcome, seenInRound: undefined }).text,
    'Seen in round 2',
  );
  assert.equal(frameTag({ ...second, round: 1 }, welcome).text, 'Changed');
  assert.equal(frameTag(second, { ...welcome, seen: false }).text, 'Changed');
  assert.equal(frameTag(second, { ...welcome, added: true }).text, 'New');
});

test('since your last review lists last round’s notes with their screen, state and reply', () => {
  const since = sinceLastReview(second)!;
  assert.equal(since.summary, '2 screens changed. 1 of your 2 notes addressed.');
  assert.deepEqual(
    since.notes.map((note) => [note.number, note.text, note.screen, note.addressed, note.reply]),
    [
      [
        1,
        'Keep the gutter at 16 here too.',
        'Welcome, narrow',
        true,
        'Gutter is 16 at every width now.',
      ],
      [
        2,
        'The app card should say who made it.',
        'Install an app',
        false,
        'Kept the size; the maker does not fit at 700.',
      ],
    ],
  );
  assert.equal(sinceLastReview({ ...second, round: 1 }), null);
  assert.equal(
    sinceLastReview({ ...second, boards: second.boards.slice(0, 2), pins: [second.pins[1]] })!
      .summary,
    '1 screen changed. 0 of your 1 note addressed.',
  );
  assert.equal(sinceLastReview({ ...second, pins: [] })!.summary, '2 screens changed.');
  // Older coordinators give no round: pins made before this round's review are last round's.
  const old = second.pins.map(({ round: _, ...rest }) => rest) as DesignReview['pins'];
  old[2] = { ...old[2], createdAt: '2026-11-13T00:00:00.000Z' };
  assert.deepEqual(
    sinceLastReview({ ...second, pins: old })!.notes.map((note) => note.id),
    ['a', 'b'],
  );
});

test('the review width draws web frames only; the wipe divider steps and stops at the edges', () => {
  assert.equal(comparedWidth({ width: null }, 720), 720);
  assert.equal(comparedWidth({ width: 390 }, 1440), 390);
  assert.equal(comparedWidth({ width: 700 }, 390), 390);
  assert.equal(wipeStep(0.5, 'ArrowLeft'), 0.45);
  assert.equal(wipeStep(0.5, 'ArrowRight'), 0.55);
  assert.equal(wipeStep(0.02, 'ArrowLeft'), 0);
  assert.equal(wipeStep(0.5, 'End'), 1);
  assert.equal(wipeStep(0.5, 'Home'), 0);
  assert.equal(wipeStep(0.5, 'a'), null);
});
