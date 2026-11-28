import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { drawPixels, parsePixels, pixelRects, syncPixels } from './design-pixels.mjs';

const grid = `# a slime
tile
zoom: 4
K = ink
G = #3c9a4a
..KK
.KGK
KGGK
`;

test('a grid reads its legend, keys and rows, and a run of one colour is one rect', () => {
  const sprite = parsePixels(grid, 'Slime');
  assert.equal(sprite.width, 4);
  assert.equal(sprite.height, 3);
  assert.equal(sprite.tile, true);
  assert.equal(sprite.zoom, 4);
  assert.deepEqual(sprite.problems, []);
  const rects = pixelRects(sprite);
  assert.match(rects, /<rect x="2" y="0" width="2" height="1" fill="var\(--pal-ink\)" \/>/);
  assert.match(rects, /<rect x="1" y="2" width="2" height="1" fill="#3c9a4a" \/>/);
  assert.equal((rects.match(/<rect/g) ?? []).length, 7);
});

test('a ragged row or an unnamed character is a problem', () => {
  const sprite = parsePixels('K = ink\nKK\nKXK\n', 'Bad');
  assert.ok(sprite.problems.some((line) => /row 2 is 3 wide, not 3|row 1 is 2 wide/.test(line)));
  assert.ok(sprite.problems.some((line) => /uses "X"/.test(line)));
});

test('drawing replaces the sprite and its copies, and adds a set for a sprite the board lacks', () => {
  const html = `<body><section class="art-set"><h2>Slime</h2><svg class="art-sprite" data-layer="Slime" viewBox="0 0 2 2" width="64" height="64"><rect width="2" height="2" /></svg></section><svg data-pixels="Slime" width="16" height="12"></svg></body>`;
  const slime = parsePixels(grid, 'Slime');
  const coin = parsePixels('Y = gold\nYY\n', 'Coin');
  const { html: out, drawn } = drawPixels(html, [slime, coin]);
  assert.deepEqual(drawn, ['Slime', 'Coin']);
  assert.match(
    out,
    /class="art-sprite tile" data-layer="Slime" viewBox="0 0 4 3" width="64" height="64"/,
  );
  assert.match(
    out,
    /data-pixels="Slime" width="16" height="12"[^>]*viewBox="0 0 4 3"|viewBox="0 0 4 3"[^>]*data-pixels="Slime"/,
  );
  assert.equal((out.match(/fill="var\(--pal-ink\)"/g) ?? []).length, 10);
  assert.match(
    out,
    /<section class="art-set" data-layer="Coin-set">\s*<h2>Coin<\/h2>\s*<svg class="art-sprite" data-layer="Coin" viewBox="0 0 2 1" width="16" height="8"/,
  );
  assert.ok(out.indexOf('Coin-set') < out.indexOf('</body>'));
  assert.equal(drawPixels(out, [slime, coin]).html, out, 'drawing again changes nothing');
  const scene = `<svg viewBox="0 0 100 50"><rect width="100" height="50" /><svg data-pixels="Slime" x="10" y="10" width="16" height="12"></svg></svg>`;
  assert.match(
    drawPixels(scene, [slime]).html,
    /viewBox="0 0 4 3" data-pixels="Slime"[^>]*>(<rect[^>]*>){7}<\/svg><\/svg>$/,
  );
});

test('syncPixels draws every grid into the one art board and leaves others alone', () => {
  const top = mkdtempSync(join(tmpdir(), 'pixels-'));
  mkdirSync(join(top, 'design', 'boards'), { recursive: true });
  mkdirSync(join(top, 'design', 'pixels'));
  const art = `<html><head><meta name="design-board" content="platform=art,width=640,height=480,tile=4"></head><body></body></html>`;
  writeFileSync(join(top, 'design', 'boards', 'Sprites.html'), art);
  writeFileSync(join(top, 'design', 'boards', 'Home.html'), '<html><body></body></html>');
  writeFileSync(join(top, 'design', 'pixels', 'Slime.txt'), grid);
  const first = syncPixels(top);
  assert.deepEqual(first, { drawn: { 'Sprites.html': ['Slime'] }, problems: [] });
  assert.match(
    readFileSync(join(top, 'design', 'boards', 'Sprites.html'), 'utf8'),
    /data-layer="Slime"/,
  );
  assert.deepEqual(syncPixels(top), { drawn: {}, problems: [] });
  writeFileSync(join(top, 'design', 'pixels', 'Odd.txt'), 'board: Nowhere\nK = ink\nK\n');
  assert.match(syncPixels(top).problems[0], /Odd has no board to go on/);
});
