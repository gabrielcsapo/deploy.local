import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardImagePath, inlineBoardImages, missingBoardImages } from './check-drawing.ts';

test('a board picture resolves under design/, and nothing outside it or on the web does', () => {
  assert.equal(boardImagePath('../art/cat.png'), 'art/cat.png');
  assert.equal(boardImagePath('captures/x.png'), 'boards/captures/x.png');
  assert.equal(boardImagePath('./a/b.svg?v=2'), 'boards/a/b.svg');
  assert.equal(boardImagePath('../../secret.png'), null);
  assert.equal(boardImagePath('https://x.test/a.png'), null);
  assert.equal(boardImagePath('data:image/png;base64,AA'), null);
});

test('pictures a board names are inlined when there, and listed when not', async () => {
  const files: Record<string, Buffer> = { 'art/cat.png': Buffer.from('png') };
  const html =
    '<img src="../art/cat.png" alt="Cat"><img src="../art/dog.png"><img src="https://x.test/a.png">';
  const page = await inlineBoardImages(html, async (path) => files[path] ?? null);
  assert.match(page, /src="data:image\/png;base64,cG5n"/);
  assert.match(page, /src="\.\.\/art\/dog\.png"/);
  assert.deepEqual(await missingBoardImages(html, async (path) => path in files), [
    '../art/dog.png',
  ]);
});
