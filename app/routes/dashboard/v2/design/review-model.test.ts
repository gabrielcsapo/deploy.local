import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolutionProgress,
  conflictCount,
  initialDesignProject,
  reviewCounts,
  reviewCrop,
  counted,
  approvalRecord,
  buildLine,
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

test('drawing paths use their native dimensions, preserve stroke order and reject nonfinite points', async () => {
  const { reviewDrawingPath, validReviewDrawing } =
    await import('../../../../../shared/v2/design-review.ts');
  const drawing = {
    side: 'after' as const,
    nativeWidth: 1440,
    nativeHeight: 900,
    anchor: { x: 0.25, y: 0.5 },
    weight: 3,
    strokes: [
      [
        { x: 0.25, y: 0.5 },
        { x: 1, y: 0 },
      ],
    ],
  };
  assert.equal(validReviewDrawing(drawing), true);
  assert.equal(reviewDrawingPath(drawing, drawing.strokes[0]), 'M360 450 L1440 0');
  assert.equal(reviewDrawingPath(drawing, [{ x: 0, y: 0 }]), 'M0 0 l0 0');
  for (const x of [NaN, Infinity, -Infinity, -1, 1.1])
    assert.equal(validReviewDrawing({ ...drawing, strokes: [[{ x, y: 0 }]] }), false);
});

test('an approved review says who decided and what happens next, without inventing a builder', () => {
  const answer = { actionId: 'approve', at: '2026-11-09T14:14:00Z', on: 'web' };
  const item = { id: 'design:p:b:c', answer } as never;
  const you = { id: null, name: 'You', avatar: null };
  const designer = { id: 'a1', name: 'Designer', avatar: null };
  const at = '2026-11-09T14:14:30Z';
  const clock = Date.parse('2026-11-09T14:14:02Z');
  const pending = { at, state: 'pending' as const };
  assert.deepEqual(
    approvalRecord({ item, landing: pending }, clock, () => 'Just now'),
    {
      seconds: 28,
      text: 'Just now, on the web. It goes to main in 28 s.',
    },
  );
  assert.equal(
    approvalRecord(
      { item, landing: { at, state: 'landed', commit: '4f05991abcdef' } },
      clock,
      () => 'Today 2:14 PM',
    )?.text,
    'Today 2:14 PM, on the web. On main as 4f05991.',
  );
  assert.equal(
    approvalRecord({ item: { id: 'x' } as never }, clock, () => ''),
    null,
  );

  assert.equal(
    buildLine({ item, proposer: you, landing: pending }).text,
    'A task starts building this once it is on main.',
  );
  assert.equal(
    buildLine({ item, proposer: designer, landing: pending }).text,
    'Designer starts building once this is on main.',
  );
  const landed = { at, state: 'landed' as const, commit: 'c' };
  assert.deepEqual(
    buildLine({ item, proposer: you, landing: { ...landed, build: { at, taskId: 't1' } } }),
    { text: 'A task is building it.', taskId: 't1' },
  );
  assert.deepEqual(
    buildLine({ item, proposer: designer, landing: { ...landed, build: { at, taskId: 't2' } } }),
    { text: 'Designer is building it.', taskId: 't2' },
  );
  assert.equal(
    buildLine({
      item,
      proposer: you,
      landing: { ...landed, build: { at, failed: 'No computer takes tasks' } },
    }).text,
    'Nothing builds this yet: No computer takes tasks',
  );
  assert.equal(
    buildLine({ item, proposer: you, landing: landed }).text,
    'Nothing builds this yet.',
  );
});

test('Continue waits only for same-part choices, counts automatic merges, and Undo blocks again', () => {
  const both = {
    file: 'Overview.html',
    kind: 'kept-both' as const,
    mainChanged: 'release list',
    proposalChanged: 'header',
    detail: '',
    choice: null,
  };
  const same = { ...both, file: 'Settings.html', kind: 'same-part' as const };
  assert.deepEqual(resolutionProgress([both, same]), {
    total: 2,
    resolved: 1,
    canContinue: false,
    label: '1 of 2 resolved',
  });
  for (const choice of ['main', 'proposal'] as const)
    assert.equal(resolutionProgress([both, { ...same, choice }]).canContinue, true);
  assert.equal(resolutionProgress([both, same]).canContinue, false);
  assert.equal(resolutionProgress([]).canContinue, true);
});

test('review links target the canvas and preserve encoded proposal identity', async () => {
  const { reviewHref } = await import('./review-model');
  assert.equal(
    reviewHref('design:p:design~test:abc'),
    '/dashboard/design?review=design%3Ap%3Adesign~test%3Aabc',
  );
  assert.equal(conflictCount(['A.html', 'note:gutter']), '1 screen and 1 note conflict with main');
  assert.equal(
    reviewCounts({ screens: 2, changed: 1, new: 1, removed: 0 }),
    '2 screens · 1 changed · 1 new · 0 removed',
  );
});
