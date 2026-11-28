import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSprite, spriteLookPage, spriteNames } from './design-sprite-look.mjs';

const board = `<!doctype html><html><head>
<meta name="design-board" content="platform=art,width=1280,height=960,tile=16,play=64">
<link rel="stylesheet" href="../look.css"><style>.wall{background:#e4f1e6}</style></head><body>
<div class="art-ground wall" data-layer="wall" style="height:200px"></div>
<section class="art-set"><svg class="art-sprite" data-layer="Hero" viewBox="0 0 16 16" width="128" height="128"><rect width="16" height="16" fill="var(--pal-ink)" /></svg></section>
<svg viewBox="0 0 100 50"><svg class="art-sprite tile" data-layer="Brick" viewBox="0 0 8 8" width="64" height="64"><rect width="8" height="8" /></svg></svg>
</body></html>`;

test('a sprite is found by its layer, inside a scene too, and its names are listed', () => {
  assert.match(findSprite(board, 'Hero'), /data-layer="Hero"/);
  assert.match(findSprite(board, 'brick'), /data-layer="Brick"/);
  assert.equal(findSprite(board, 'Nope'), null);
  assert.deepEqual(spriteNames(board), ['Hero', 'Brick']);
});

test("the look page shows the sprite close up, at play size on the sheet's own ground, and a tile 3×3", () => {
  const made = spriteLookPage({ board, name: 'Hero' });
  assert.equal(made.scale, 4);
  assert.equal(made.tiled, false);
  assert.match(made.html, /<link rel="stylesheet" href="..\/look.css">/);
  assert.match(made.html, /class="art-ground wall"/);
  assert.match(made.html, /In play: 64 px a tile \(4×\) on wall/);
  assert.match(
    made.html,
    /width="128" height="128" style="display:block;width:128px/,
    'close up at 8×',
  );
  assert.match(made.html, /width="64" height="64"/, 'at play size');
  const brick = spriteLookPage({ board, name: 'Brick' });
  assert.equal(brick.tiled, true);
  assert.equal((brick.html.match(/data-layer="Brick"/g) ?? []).length, 1 + 9 + 9);
  assert.equal(spriteLookPage({ board, name: 'Nope' }), null);
  const bare = spriteLookPage({
    board: board.replace(/art-ground /, ''),
    css: ':root{--stage-night:#1c1620}',
    name: 'Hero',
  });
  assert.match(bare.html, /background: var\(--stage-night\)/);
  assert.equal(bare.guessed, false);
});
