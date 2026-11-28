import assert from 'node:assert/strict';
import test from 'node:test';
import { settleFindings, tapProblems } from './board-quality.ts';

test('an open canvas stops on breakage and stated limits; taste is advice and system checks go', () => {
  const finding = (code: string, file = 'A.html') => ({ code, file });
  const problems = [
    finding('text_cut_off'),
    finding('low_contrast'),
    finding('low_contrast', 'B.html'),
    finding('second_primary'),
    finding('not_a_token'),
    finding('art_off_palette'),
    finding('art_off_palette', 'B.html'),
  ];
  const notes = [finding('inline_style'), finding('nearly_aligned')];
  const stated = (file: string | null, key: string) =>
    file === 'B.html' && (key === 'contrast' || key === 'palette');
  const open = settleFindings(problems, notes, { system: false, stated });
  assert.deepEqual(
    open.problems.map((p) => `${p.code}@${p.file}`),
    ['text_cut_off@A.html', 'low_contrast@B.html', 'art_off_palette@B.html'],
  );
  // One house style (one primary button, near-aligned edges) is a design system's to ask for;
  // a palette holds only where the head says so.
  assert.deepEqual(
    open.notes.map((p) => p.code),
    ['low_contrast', 'art_off_palette'],
  );
  const kept = settleFindings(problems, notes, { system: true, stated });
  assert.equal(kept.problems.length, 7);
});

test('tap= and reach= in the head hold every control to the brief', () => {
  const control = (layer: string, top: number, height: number) => ({
    layer,
    text: layer,
    left: 24,
    top,
    width: 342,
    height,
  });
  const controls = [control('next', 700, 64), control('replay', 500, 48)];
  const found = tapProblems({
    file: 'A.html',
    title: 'A',
    tap: '56',
    reach: 'third',
    height: 844,
    controls,
  });
  assert.deepEqual(
    found.map((p) => p.code),
    ['tap_too_small', 'out_of_reach'],
  );
  assert.match(found[0].detail, /replay is 342 × 48/);
  assert.match(found[1].detail, /below y 563/);
  assert.deepEqual(tapProblems({ file: 'A.html', title: 'A', height: 844, controls }), []);
});
