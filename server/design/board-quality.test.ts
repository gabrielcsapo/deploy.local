import assert from 'node:assert/strict';
import test from 'node:test';
import { settleFindings } from './board-quality.ts';

test('an open canvas stops on breakage and stated limits; taste is advice and system checks go', () => {
  const finding = (code: string, file = 'A.html') => ({ code, file });
  const problems = [
    finding('text_cut_off'),
    finding('low_contrast'),
    finding('low_contrast', 'B.html'),
    finding('second_primary'),
    finding('not_a_token'),
  ];
  const notes = [finding('inline_style'), finding('nearly_aligned')];
  const stated = (file: string | null, key: string) => file === 'B.html' && key === 'contrast';
  const open = settleFindings(problems, notes, { system: false, stated });
  assert.deepEqual(
    open.problems.map((p) => `${p.code}@${p.file}`),
    ['text_cut_off@A.html', 'low_contrast@B.html'],
  );
  assert.deepEqual(
    open.notes.map((p) => p.code),
    ['low_contrast', 'second_primary', 'nearly_aligned'],
  );
  const kept = settleFindings(problems, notes, { system: true, stated });
  assert.equal(kept.problems.length, 5);
});
