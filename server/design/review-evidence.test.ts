import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { compareReviewPixels, pngPixels, reviewEvidence } from './review-evidence.ts';
// Minimal truecolor PNG scanlines; the decoder reads the IHDR and IDAT payloads.
function png(values: number[], filter = 0) {
  const head = Buffer.alloc(33);
  head.writeUInt32BE(0x89504e47);
  head.writeUInt32BE(2, 16);
  head.writeUInt32BE(1, 20);
  head[24] = 8;
  head[25] = 2;
  const row = Buffer.from(values);
  if (filter === 1) for (let i = row.length - 1; i >= 3; i--) row[i] -= row[i - 3];
  const compressed = deflateSync(Buffer.concat([Buffer.from([filter]), row]));
  const chunk = Buffer.alloc(compressed.length + 12);
  chunk.writeUInt32BE(compressed.length);
  chunk.write('IDAT', 4);
  compressed.copy(chunk, 8);
  // An IHDR chunk occupies bytes 8–32.
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12);
  return Buffer.concat([head, chunk]);
}
test('pixel evidence ignores compression and detects changes outside the exact areas', () => {
  const a = png([10, 20, 30, 40, 50, 60]);
  const same = png([10, 20, 30, 40, 50, 60], 1);
  assert.deepEqual(pngPixels(same).pixels, pngPixels(a).pixels);
  assert.deepEqual(compareReviewPixels(a, same, []), { same: true, outsideSame: true });
  const b = png([20, 20, 30, 40, 50, 60]);
  assert.deepEqual(compareReviewPixels(a, b, [{ x: 0, y: 0, w: 1, h: 1 }]), {
    same: false,
    outsideSame: true,
  });
  assert.deepEqual(compareReviewPixels(a, b, []), { same: false, outsideSame: false });
});
test('link targets look the same; CSS-only pixels are explicit; missing renders never assert parity', () => {
  const screen = {
    file: 'A.html',
    title: 'Screen',
    status: 'changed' as const,
    changedSinceReview: true,
  };
  const before =
    '<header data-layer="head" class="dl-head"><a data-layer="back" href="A.html">Back</a></header>';
  const after = before.replace('href="A.html"', 'href="B.html"');
  const render = {
    png: png([10, 20, 30, 40, 50, 60]),
    boxes: { head: { x: 0, y: 0, w: 1, h: 1 } },
  };
  const evidence = reviewEvidence(screen, before, after, { before: render, after: render });
  assert.equal(evidence.status, 'looksSame');
  assert.equal(evidence.regions[0].title, 'Header row');
  assert.equal(reviewEvidence(screen, before, after).nothingElse, false);
  const changed = { ...render, png: png([10, 20, 30, 80, 50, 60]) };
  assert.equal(
    reviewEvidence(screen, before, before, { before: render, after: changed }).status,
    'pixelsOnly',
  );
  assert.equal(
    reviewEvidence(screen, before, after, { before: render, after: changed }).nothingElse,
    false,
  );
});

test('removed glyphs and added lone SVGs have unnamed icon evidence', () => {
  const screen = { file: 'A', title: 'A', status: 'changed' as const };
  const old =
    '<header class="dl-head" data-layer="head"><span data-layer="glyph" class="dl-glyph"><svg></svg></span><b data-layer="label">Project</b></header>';
  const next =
    '<header class="dl-head" data-layer="head"><b data-layer="label">Projects</b></header>';
  assert.equal(reviewEvidence(screen, old, next).regions[0].removedIcon, true);
  assert.equal(
    reviewEvidence(screen, next, old.replace('class="dl-glyph"', '')).regions[0].addedIcon,
    true,
  );
});
