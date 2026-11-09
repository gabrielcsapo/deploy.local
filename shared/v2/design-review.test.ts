import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupReviewChanges,
  reviewPhrases,
  reviewWords,
  reviewNotePosition,
  validReviewAnchor,
  type ReviewEvidence,
} from './design-review.ts';
const screen = (file: string, extra: Partial<ReviewEvidence> = {}): ReviewEvidence => ({
  file,
  title: file,
  status: 'changed',
  seen: false,
  nothingElse: true,
  regions: [
    { layer: 'head', title: 'Header row', added: ['Projects › alpha'], removed: ['Project'] },
  ],
  ...extra,
});
test('repeated regions mask names and layer suffixes, counting different replacements', () => {
  const rows = groupReviewChanges(
    [
      screen('a'),
      screen('b', {
        seen: true,
        regions: [
          {
            layer: 'head-2',
            title: 'Header row',
            added: ['Projects › beta'],
            removed: ['Repository'],
          },
        ],
      }),
    ],
    ['alpha', 'beta'],
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].screens, ['a', 'b']);
  assert.equal(rows[0].variations, 1);
  assert.equal(rows[0].seen, false);
});
test('unverified pixels, extra regions, new/removed screens and rounds cannot hide in a group', () => {
  const rows = groupReviewChanges([
    screen('a'),
    screen('b', { nothingElse: false }),
    screen('c', { status: 'new' }),
    screen('d', { status: 'removed' }),
    screen('e', { changedSinceReview: false }),
    screen('f', {
      regions: [
        ...screen('x').regions,
        { layer: 'footer', title: 'Footer', added: ['Done'], removed: [] },
      ],
    }),
  ]);
  assert.equal(rows.length, 6);
});
test('looksSame, pixelsOnly and proposer words stay distinct', () => {
  const rows = groupReviewChanges([
    screen('a', { status: 'looksSame', changeWords: 'Where Back goes' }),
    screen('b', { status: 'pixelsOnly' }),
  ]);
  assert.equal(rows[0].title, 'Where Back goes');
  assert.equal(rows[0].status, 'looksSame');
  assert.equal(rows[1].status, 'pixelsOnly');
});
test('notes follow their element and fall back when it disappears', () => {
  const pin = { x: 40, y: 60, layer: 'title', offset: { x: 0.5, y: 0.25 } };
  assert.deepEqual(reviewNotePosition(pin, { title: { x: 100, y: 200, w: 80, h: 40 } }), {
    x: 140,
    y: 210,
  });
  assert.deepEqual(reviewNotePosition(pin, {}), { x: 40, y: 60 });
  assert.equal(validReviewAnchor(pin, 812, 900), true);
  assert.equal(validReviewAnchor({ ...pin, offset: { x: Infinity, y: 0 } }, 812, 900), false);
  assert.equal(validReviewAnchor({ area: { x: 810, y: 0, w: 10, h: 10 } }, 812, 900), false);
});

test('the representative removed words come from the majority, with minority screens counted', () => {
  const rows = groupReviewChanges([
    screen('a', {
      regions: [
        { layer: 'head', title: 'Header row', added: ['Projects'], removed: ['Repository'] },
      ],
    }),
    ...['b', 'c', 'd'].map((file) =>
      screen(file, {
        regions: [
          { layer: 'head', title: 'Header row', added: ['Projects'], removed: ['Project'] },
        ],
      }),
    ),
  ]);
  assert.deepEqual(rows[0].removed, ['Project']);
  assert.equal(rows[0].variations, 1);
  assert.equal(
    groupReviewChanges([screen('new', { status: 'new', title: 'A project on iPhone' })])[0].title,
    'A project on iPhone',
  );
});

test('computed descriptions bound phrase count and length without cutting words', () => {
  assert.equal(
    reviewPhrases(['Projects', 'Stages and care', ...Array(12).fill('More')]),
    'Projects, Stages and care and 12 more',
  );
  assert.equal(
    reviewPhrases(['This is a long phrase with complete words beyond forty characters']),
    'This is a long phrase with complete',
  );
  assert.equal(reviewPhrases(['x'.repeat(60)]), '…');
  const row = groupReviewChanges([screen('a')])[0];
  row.removedIcon = true;
  assert.match(reviewWords(row), /Removed Project and an icon\./);
  row.changeWords =
    'The proposer’s words stay exactly as written, even when longer than forty characters.';
  assert.equal(reviewWords(row), row.changeWords);
});
