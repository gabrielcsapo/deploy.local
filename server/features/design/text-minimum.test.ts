import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textUnderMinimum } from './board-check.ts';

const texts = [
  { layer: 'title', text: 'Hours', size: 80 },
  { layer: 'footer', text: 'Library', size: 32 },
  { layer: null, text: 'No change', size: 22 },
  { layer: 'footer', text: 'Page 2', size: 22 },
];

test('min-text= flags each layer drawn under it, in px or pt', () => {
  assert.deepEqual(textUnderMinimum('28', texts), {
    minimum: 28,
    smallest: 22,
    layers: ['"No change"', 'footer'],
  });
  // 24pt is 32 px: nothing under it but the 22 px text.
  assert.deepEqual(textUnderMinimum('24pt', texts)?.layers, ['"No change"', 'footer']);
  assert.equal(textUnderMinimum('22', texts), null);
  assert.equal(textUnderMinimum('21.6', texts), null);
  assert.equal(textUnderMinimum(undefined, texts), null);
  assert.equal(textUnderMinimum('big', texts), null);
});
