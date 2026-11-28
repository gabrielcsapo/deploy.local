import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import {
  artGridProblems,
  artPaletteProblems,
  artReadNote,
  artSilhouetteNote,
  type ArtSheet,
} from './art-checks.ts';

/** A PNG (8-bit RGB) of the pixels a function gives, as a browser would write one. */
function pngOf(size: number, pixel: (x: number, y: number) => [number, number, number]) {
  const rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) rows.set(pixel(x, y), y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (kind: string, data: Buffer) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(kind, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sprite = (
  name: string,
  extra: Partial<ArtSheet['sprites'][number]> = {},
): ArtSheet['sprites'][number] => ({
  name,
  set: name,
  tile: false,
  width: 16,
  height: 16,
  drawn: { width: 128, height: 128 },
  colours: ['rgb(29, 27, 38)'],
  offGrid: [],
  translucent: false,
  svg: '<svg></svg>',
  renders: [],
  ...extra,
});
const board = { file: 'Sprites.html', title: 'Sprites' };
const night = 'rgb(31, 35, 64)';
const day = 'rgb(207, 231, 242)';
const rgb = (value: string) => value.match(/\d+/g)!.map(Number) as [number, number, number];

test('a sprite of whole pixels and whole tiles at a whole zoom is on the grid; anything else is one problem', () => {
  assert.deepEqual(
    artGridProblems({ ...board, art: { tile: 16, play: 48, sprites: [sprite('hero')] } }),
    [],
  );
  const [problem] = artGridProblems({
    ...board,
    art: {
      tile: 16,
      play: 40,
      sprites: [
        sprite('odd', { width: 15, drawn: { width: 120, height: 128 }, offGrid: ['a curve'] }),
        sprite('wide', { width: 32, drawn: { width: 200, height: 100 } }),
        sprite('flat', { width: 0, height: 0 }),
      ],
    },
  });
  assert.equal(problem.code, 'art_off_grid');
  assert.match(problem.detail, /play=40 draws the 16 px tile 2\.5 times over/);
  assert.match(problem.detail, /odd is 15×16, not a whole number of 16 px tiles/);
  assert.match(problem.detail, /odd has a curve/);
  assert.match(problem.detail, /wide is drawn 200×100 on the sheet/);
  assert.match(problem.detail, /and 1 more/);
});

test('a colour off the palette or a see-through shape is a problem; no palette, nothing to compare', () => {
  const palette = [
    { name: 'pal-ink', colour: 'rgb(29, 27, 38)' },
    { name: 'stage-day', colour: day },
  ];
  assert.deepEqual(
    artPaletteProblems({
      ...board,
      art: { palette, sprites: [sprite('hero', { colours: ['rgb(30, 27, 38)', day] })] },
    }),
    [],
  );
  const [problem] = artPaletteProblems({
    ...board,
    art: {
      palette,
      sprites: [
        sprite('hero', { colours: ['rgb(255, 0, 255)'] }),
        sprite('slime', { colours: ['rgb(255, 0, 255)'], translucent: true }),
      ],
    },
  });
  assert.equal(problem.code, 'art_off_palette');
  assert.match(problem.detail, /#ff00ff in hero, slime/);
  assert.match(problem.detail, /see-through shapes in slime/);
  assert.deepEqual(
    artPaletteProblems({
      ...board,
      art: { palette: [], sprites: [sprite('hero', { colours: ['rgb(255, 0, 255)'] })] },
    }),
    [],
  );
});

test('a sprite reads at play size by its pixels or by its outline; a dark one melts into a night ground', () => {
  // A 48 px render: a 30 px square with a 3 px outline, on the ground it was drawn on.
  const square = (
    ground: string,
    outline: [number, number, number],
    fill: [number, number, number],
  ) =>
    pngOf(48, (x, y) => {
      const inside = x >= 9 && x < 39 && y >= 9 && y < 39;
      const rim = inside && (x < 12 || x >= 36 || y < 12 || y >= 36);
      return rim ? outline : inside ? fill : rgb(ground);
    });
  const ink: [number, number, number] = [29, 27, 38];
  const read = (renders: ArtSheet['sprites'][number]['renders'], extra = {}) =>
    artReadNote({
      ...board,
      art: { tile: 16, play: 48, sprites: [sprite('hero', { renders, ...extra })] },
    });
  // Ink outline and a white fill on day: reads. On night the outline goes, the fill holds it.
  assert.equal(
    read([{ ground: 'Day', colour: day, png: square(day, ink, [247, 245, 238]) }]),
    null,
  );
  assert.equal(
    read([{ ground: 'Night', colour: night, png: square(night, ink, [247, 245, 238]) }]),
    null,
  );
  // A green fill that matches a dusk ground keeps its shape by its ink outline.
  const dusk = 'rgb(119, 116, 143)';
  assert.equal(
    read([{ ground: 'Dusk', colour: dusk, png: square(dusk, ink, [110, 120, 140]) }]),
    null,
  );
  // Ink and shade on night: both melt.
  const note = read([{ ground: 'Night', colour: night, png: square(night, ink, [40, 44, 70]) }]);
  assert.equal(note?.code, 'art_unreadable_at_play');
  assert.match(note.detail, /hero on Night: 0% of it and 0% of its outline stand apart/);
  // A speck: 6 px across at play size.
  const speck = pngOf(48, (x, y) => (x >= 20 && x < 26 && y >= 20 && y < 26 ? ink : rgb(day)));
  assert.match(read([{ ground: 'Day', colour: day, png: speck }])?.detail ?? '', /6 px across/);
  // Tiles are the ground: never read.
  assert.equal(
    read([{ ground: 'Night', colour: night, png: square(night, ink, [40, 44, 70]) }], {
      tile: true,
    }),
    null,
  );
});

test('sprites of different sets with one silhouette are a note, once per two sets; frames of one set are not', () => {
  const body = (wide: number) =>
    pngOf(48, (x, y) =>
      x >= 24 - wide && x < 24 + wide && y >= 6 && y < 42 ? [29, 27, 38] : rgb(day),
    );
  const render = (png: Buffer) => [{ ground: 'Day', colour: day, png }];
  const note = artSilhouetteNote({
    ...board,
    art: {
      sprites: [
        sprite('hero-idle', { set: 'hero', renders: render(body(10)) }),
        sprite('hero-step', { set: 'hero', renders: render(body(10)) }),
        sprite('shadow-idle', { set: 'shadow', renders: render(body(10)) }),
        sprite('slime', { set: 'slime', renders: render(body(20)) }),
      ],
    },
  });
  assert.equal(note?.code, 'art_same_silhouette');
  assert.equal(note.detail, 'hero-idle and shadow-idle (100% the same shape)');
  assert.equal(
    artSilhouetteNote({
      ...board,
      art: {
        sprites: [
          sprite('hero-idle', { set: 'hero', renders: render(body(10)) }),
          sprite('hero-step', { set: 'hero', renders: render(body(10)) }),
        ],
      },
    }),
    null,
  );
});

test('palette= in the head caps how many colours the sprites use', () => {
  const sprites = [
    sprite('hero', { colours: ['rgb(1, 1, 1)', 'rgb(2, 2, 2)'] }),
    sprite('slime', { colours: ['rgb(3, 3, 3)', 'rgb(1, 1, 1)'] }),
  ];
  assert.deepEqual(artPaletteProblems({ ...board, art: { palette: [], sprites }, most: 3 }), []);
  const [problem] = artPaletteProblems({ ...board, art: { palette: [], sprites }, most: 2 });
  assert.equal(problem.code, 'art_off_palette');
  assert.match(problem.label, /3 colours, more than its palette=2/);
});
