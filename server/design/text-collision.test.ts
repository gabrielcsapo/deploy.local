import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textCollisionProblems } from './board-quality.ts';

const inspection = (extra: object) => ({
  height: 800,
  texts: [],
  aligned: [],
  rows: {},
  boxes: [],
  primaries: [],
  ...extra,
});

test('text over text and a label past its button stop the check, unless main did it too', () => {
  const after = inspection({
    overlaps: [{ a: 'Page 3', b: 'Dogs on leads', layerA: 'footer', layerB: 'rule-dogs' }],
    spills: [{ layer: 'cancel', text: 'Cancel alarm', box: 'cancel', amount: 12 }],
  }) as any;
  const found = textCollisionProblems({
    file: 'A.html',
    title: 'A',
    width: 390,
    after,
    before: null,
  });
  assert.deepEqual(
    found.map((problem) => [problem.code, problem.label]),
    [
      ['text_overlaps', 'A draws footer over rule-dogs'],
      ['text_spills', 'A cancel runs past its border'],
    ],
  );
  assert.deepEqual(
    textCollisionProblems({ file: 'A.html', title: 'A', width: 390, after, before: after }),
    [],
  );
});
