// What the check says about a sprite sheet (platform=art): every sprite on the pixel grid and a
// whole number of tiles, every colour from the palette, and each sprite still readable at the
// size it is played at, on each ground it is played on, with a shape of its own. Plain arithmetic
// on what the page gave back (readSprites in check-drawing) and the sprites' own pictures.
import { contrast, type Rgb } from '../../shared/v2/design-inspect.ts';
import type { Finding } from './board-quality.ts';
import { decodePng } from './kind-checks.ts';

/** One sprite as the page read it. */
export type ArtSprite = {
  /** Its layer name (data-layer), else its label. */
  name: string;
  /** The set it belongs to (a character, an item): frames of one set share a shape on purpose. */
  set: string;
  /** A tile is the ground itself: it is not read against the grounds. */
  tile: boolean;
  /** Its size in art pixels (the viewBox). */
  width: number;
  height: number;
  /** Its size as drawn on the sheet, in CSS px. */
  drawn: { width: number; height: number };
  /** Every colour its shapes are painted with, as the browser computed it. */
  colours: string[];
  /** What is off the pixel grid: a curve, a stroke, a shape at a fraction of a pixel. */
  offGrid: string[];
  /** Whether a shape is see-through (opacity under 1), which mixes colours the palette lacks. */
  translucent: boolean;
  /** The sprite alone, every colour resolved, at one CSS px a pixel. */
  svg: string;
};

/** A sprite sheet as the page read it, and each sprite drawn at play size on each ground. */
export type ArtSheet = {
  tile: number;
  play: number;
  /** Every --pal-* and --stage-* in the stylesheets, resolved. */
  palette: { name: string; colour: string }[];
  /** The grounds the art is played on (.art-ground), with the colour each is painted. */
  grounds: { label: string; colour: string }[];
  sprites: (ArtSprite & {
    /** The sprite at play size on each ground, 1:1. */
    renders: { ground: string; colour: string; png: Buffer }[];
  })[];
};

const rgbOf = (value: string): Rgb | null => {
  const parts = /rgba?\(([^)]+)\)/
    .exec(value)?.[1]
    .split(/[,\s/]+/)
    .filter(Boolean)
    .map(Number);
  if (!parts || parts.length < 3) return null;
  return [parts[0], parts[1], parts[2]];
};
const hex = (rgb: Rgb) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
const far = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const listed = (items: string[], limit = 4) =>
  items.length > limit
    ? `${items.slice(0, limit).join('; ')} and ${items.length - limit} more`
    : items.join('; ');

/**
 * Sprites that are not pixel art on the sheet's grid: a size that is not a whole number of
 * tiles, a shape that is not whole pixels (a curve, a stroke, a fraction, a transform), a sheet
 * zoom or a play size that is not a whole multiple of the pixels, so they blur. One problem.
 */
export function artGridProblems(input: {
  file: string;
  title: string;
  art: Pick<ArtSheet, 'tile' | 'play'> & { sprites: ArtSprite[] };
}): Finding[] {
  const { tile, play } = input.art;
  const issues: string[] = [];
  const zoom = play / tile;
  if (Math.abs(zoom - Math.round(zoom)) > 0.01)
    issues.push(
      `play=${play} draws the ${tile} px tile ${Math.round(zoom * 100) / 100} times over, so its pixels blur in play`,
    );
  for (const sprite of input.art.sprites) {
    if (!sprite.width || !sprite.height) {
      issues.push(`${sprite.name} has no viewBox, so it has no pixels to count`);
      continue;
    }
    if (sprite.width % tile || sprite.height % tile)
      issues.push(
        `${sprite.name} is ${sprite.width}×${sprite.height}, not a whole number of ${tile} px tiles`,
      );
    if (sprite.offGrid.length) issues.push(`${sprite.name} has ${sprite.offGrid.join(', ')}`);
    const across = sprite.drawn.width / sprite.width;
    const down = sprite.drawn.height / sprite.height;
    if (
      Math.abs(across - Math.round(across)) > 0.01 ||
      Math.abs(down - Math.round(down)) > 0.01 ||
      Math.abs(across - down) > 0.01
    )
      issues.push(
        `${sprite.name} is drawn ${Math.round(sprite.drawn.width)}×${Math.round(sprite.drawn.height)} on the sheet, not a whole multiple of its ${sprite.width}×${sprite.height} pixels`,
      );
  }
  if (!issues.length) return [];
  return [
    {
      code: 'art_off_grid',
      file: input.file,
      board: input.title,
      scheme: 'light',
      label: `${input.title} has art off its ${tile} px pixel grid`,
      detail: listed(issues),
      short: 'off the pixel grid',
      fix: `draw each sprite from whole pixels (rects, and paths of h and v runs on whole numbers), a whole number of ${tile} px tiles, with its width and height its viewBox times a whole zoom`,
    },
  ];
}

/**
 * Colours a sprite is painted with that the palette (every --pal-* and --stage-* in the kind's
 * stylesheet) does not have, and see-through shapes, which mix colours it lacks. One problem.
 */
export function artPaletteProblems(input: {
  file: string;
  title: string;
  art: Pick<ArtSheet, 'palette'> & { sprites: ArtSprite[] };
  /** The most colours the brief allows, as palette= in the head says. */
  most?: number | null;
}): Finding[] {
  const palette = input.art.palette.map((entry) => rgbOf(entry.colour)).filter(Boolean) as Rgb[];
  const used = new Set(
    input.art.sprites.flatMap((sprite) =>
      sprite.colours
        .map((colour) => rgbOf(colour))
        .filter(Boolean)
        .map((rgb) => hex(rgb as Rgb)),
    ),
  );
  const over: Finding[] =
    input.most && used.size > input.most
      ? [
          {
            code: 'art_off_palette',
            file: input.file,
            board: input.title,
            scheme: 'light',
            label: `${input.title} paints with ${used.size} colours, more than its palette=${input.most}`,
            detail: [...used].slice(0, 24).join(', '),
            short: 'too many colours',
            fix: `bring the sprites down to ${input.most} colours, or raise palette= if the brief allows more`,
          },
        ]
      : [];
  if (!palette.length) return over;
  const strays = new Map<string, string[]>();
  const seeThrough: string[] = [];
  for (const sprite of input.art.sprites) {
    if (sprite.translucent) seeThrough.push(sprite.name);
    for (const colour of sprite.colours) {
      const rgb = rgbOf(colour);
      if (!rgb || palette.some((entry) => far(entry, rgb) <= 3)) continue;
      const key = hex(rgb);
      strays.set(key, [...(strays.get(key) ?? []), sprite.name]);
    }
  }
  if (!strays.size && !seeThrough.length) return over;
  const parts = [
    ...[...strays].map(
      ([colour, sprites]) => `${colour} in ${[...new Set(sprites)].slice(0, 3).join(', ')}`,
    ),
    ...(seeThrough.length
      ? [`see-through shapes in ${seeThrough.slice(0, 3).join(', ')} mix colours it lacks`]
      : []),
  ];
  return [
    {
      code: 'art_off_palette',
      file: input.file,
      board: input.title,
      scheme: 'light',
      label: `${input.title} paints with ${strays.size ? `${strays.size} colour${strays.size === 1 ? '' : 's'} not in its palette` : 'see-through shapes'}`,
      detail: listed(parts),
      short: 'off the palette',
      fix: 'paint every shape with a --pal-* colour at full opacity; a colour the art needs goes into the palette first, as a --pal-*',
    },
    ...over,
  ];
}

/** A sprite's picture as a mask: the pixels that differ from the ground it was drawn on. */
function spriteMask(png: Buffer, ground: Rgb) {
  const { width, height, rgba } = decodePng(png);
  const mask = new Uint8Array(width * height);
  let area = 0;
  let apart = 0;
  let box = { left: width, top: height, right: -1, bottom: -1 };
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const px: Rgb = [rgba[at * 4], rgba[at * 4 + 1], rgba[at * 4 + 2]];
      if (far(px, ground) <= 8) continue;
      mask[at] = 1;
      area++;
      // What the eye sees as the shape: pixels at 1.5:1 or more against the ground.
      if (contrast(px, ground) >= 1.5) apart++;
      box = {
        left: Math.min(box.left, x),
        top: Math.min(box.top, y),
        right: Math.max(box.right, x),
        bottom: Math.max(box.bottom, y),
      };
    }
  const across = box.right < 0 ? 0 : Math.max(box.right - box.left + 1, box.bottom - box.top + 1);
  // Its silhouette's edge: the pixels with ground (or the picture's edge) beside them.
  let edge = 0;
  let edgeApart = 0;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      if (!mask[at]) continue;
      if (inside(x - 1, y) && inside(x + 1, y) && inside(x, y - 1) && inside(x, y + 1)) continue;
      edge++;
      const px: Rgb = [rgba[at * 4], rgba[at * 4 + 1], rgba[at * 4 + 2]];
      if (contrast(px, ground) >= 1.5) edgeApart++;
    }
  return { width, height, mask, area, apart, across, edge, edgeApart };
}

/**
 * A sprite melts into a ground when under half its pixels stand apart from it and under 70% of
 * its outline does: an outline that shows keeps the shape whatever its fill does.
 */
const APART = 0.5;
const EDGE_APART = 0.7;
/** Smaller than this many CSS px across at play size, a sprite is a speck on a phone. */
const SPECK = 12;

/**
 * Sprites that do not read at play size on a ground they are played on: invisible, a speck, or
 * too few of their pixels standing apart from it (a dark outline on a night stage). A note, since
 * a game may light a sprite or never use it there; tiles are the ground and are not read.
 */
export function artReadNote(input: {
  file: string;
  title: string;
  art: Pick<ArtSheet, 'play' | 'tile' | 'sprites'>;
}): Finding | null {
  const weak: string[] = [];
  for (const sprite of input.art.sprites) {
    if (sprite.tile) continue;
    for (const render of sprite.renders) {
      const ground = rgbOf(render.colour);
      if (!ground) continue;
      let read;
      try {
        read = spriteMask(render.png, ground);
      } catch {
        continue;
      }
      if (!read.area) weak.push(`${sprite.name} on ${render.ground}: nothing shows`);
      else if (
        read.apart / read.area < APART &&
        read.edgeApart / Math.max(1, read.edge) < EDGE_APART
      )
        weak.push(
          `${sprite.name} on ${render.ground}: ${Math.round((read.apart / read.area) * 100)}% of it and ${Math.round((read.edgeApart / Math.max(1, read.edge)) * 100)}% of its outline stand apart (1.5:1)`,
        );
      else if (read.across < SPECK)
        weak.push(`${sprite.name} on ${render.ground}: ${read.across} px across at play size`);
    }
  }
  if (!weak.length) return null;
  return {
    code: 'art_unreadable_at_play',
    file: input.file,
    board: input.title,
    scheme: 'light',
    label: `${input.title} has sprites that do not read at play size`,
    detail: listed(weak),
    short: 'unreadable at play size',
    fix: `at ${input.art.play} px a tile, give each sprite an outline or rim that contrasts with every ground it meets (a light rim on a night ground), and keep it at least ${SPECK} px across`,
  };
}

/** Two silhouettes this alike read as the same thing at a glance. */
const ALIKE = 0.9;

/**
 * Sprites of different sets (a character and an enemy, two items) whose silhouettes at play size
 * are nearly the same shape: at a glance a player cannot tell them apart. Frames of one set share
 * a shape on purpose and are not compared. A note.
 */
export function artSilhouetteNote(input: {
  file: string;
  title: string;
  art: Pick<ArtSheet, 'sprites'>;
}): Finding | null {
  const shapes = input.art.sprites
    .filter((sprite) => !sprite.tile && sprite.renders.length)
    .flatMap((sprite) => {
      const render = sprite.renders[0];
      const ground = rgbOf(render.colour);
      if (!ground) return [];
      try {
        return [{ sprite, ...spriteMask(render.png, ground) }];
      } catch {
        return [];
      }
    });
  // One entry for each two sets, the closest of their sprites.
  const closest = new Map<string, { overlap: number; text: string }>();
  for (let a = 0; a < shapes.length; a++)
    for (let b = a + 1; b < shapes.length; b++) {
      const [one, two] = [shapes[a], shapes[b]];
      if (one.sprite.set && one.sprite.set === two.sprite.set) continue;
      if (one.width !== two.width || one.height !== two.height || !one.area || !two.area) continue;
      let both = 0;
      let either = 0;
      for (let at = 0; at < one.mask.length; at++) {
        if (one.mask[at] && two.mask[at]) both++;
        if (one.mask[at] || two.mask[at]) either++;
      }
      const overlap = both / Math.max(1, either);
      if (overlap < ALIKE) continue;
      const key = [one.sprite.set || one.sprite.name, two.sprite.set || two.sprite.name].join(
        '\u0000',
      );
      if ((closest.get(key)?.overlap ?? 0) >= overlap) continue;
      closest.set(key, {
        overlap,
        text: `${one.sprite.name} and ${two.sprite.name} (${Math.round(overlap * 100)}% the same shape)`,
      });
    }
  const pairs = [...closest.values()].map((entry) => entry.text);
  if (!pairs.length) return null;
  return {
    code: 'art_same_silhouette',
    file: input.file,
    board: input.title,
    scheme: 'light',
    label: `${input.title} has sprites with the same silhouette`,
    detail: listed(pairs),
    short: 'same silhouette',
    fix: 'give each thing a player must tell apart a shape of its own (height, width, a part that sticks out); colour alone is lost at a glance',
  };
}

/**
 * Tiles that show where they join when repeated: an edge that jumps further from the opposite
 * edge than any two neighbouring rows or columns inside differ, a line drawn along both opposite
 * edges (tiled, it is twice as thick), or a line along one edge that the inside has nowhere. Read
 * from the tile's own pixels, one sample a pixel. A note.
 */
export function tileSeamNote(input: {
  file: string;
  title: string;
  art: Pick<ArtSheet, 'sprites'>;
}): Finding | null {
  const found: string[] = [];
  for (const sprite of input.art.sprites) {
    if (!sprite.tile || !sprite.renders.length || !sprite.width || !sprite.height) continue;
    let grid: Rgb[][];
    try {
      const { width, height, rgba } = decodePng(sprite.renders[0].png);
      const across = width / sprite.width;
      const down = height / sprite.height;
      grid = Array.from({ length: sprite.height }, (_, y) =>
        Array.from({ length: sprite.width }, (_, x) => {
          const at =
            (Math.min(height - 1, Math.floor((y + 0.5) * down)) * width +
              Math.min(width - 1, Math.floor((x + 0.5) * across))) *
            4;
          return [rgba[at], rgba[at + 1], rgba[at + 2]] as Rgb;
        }),
      );
    } catch {
      continue;
    }
    const seam = seamOf(grid, sprite.name);
    if (seam) found.push(seam);
    const turned = grid[0].map((_, x) => grid.map((row) => row[x]));
    const side = seamOf(turned, sprite.name, true);
    if (side) found.push(side);
  }
  if (!found.length) return null;
  return {
    code: 'art_tile_seam',
    file: input.file,
    board: input.title,
    scheme: 'light',
    label: `${input.title} has tiles that show their joins`,
    detail: listed(found),
    short: 'tile seam',
    fix: 'repeat the tile 3 × 3 (look --zoom 3) and draw across the join: carry each stone or line over the edge, and draw an edge line on one side only',
  };
}

/** Where a tile's rows (or, turned, its columns) show a join: its top and bottom edges. */
function seamOf(rows: Rgb[][], name: string, sideways = false) {
  const apart = (a: Rgb[], b: Rgb[]) =>
    a.reduce((sum, colour, at) => sum + far(colour, b[at]), 0) / a.length;
  const plain = (row: Rgb[]) => {
    const counts = new Map<string, number>();
    for (const colour of row) counts.set(hex(colour), (counts.get(hex(colour)) ?? 0) + 1);
    const [top, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
    return count / row.length >= 0.85 ? top : null;
  };
  const last = rows.length - 1;
  if (last < 2) return null;
  const inside = rows.slice(0, last).map((row, at) => apart(row, rows[at + 1]));
  const wrap = apart(rows[last], rows[0]);
  const [first, end] = sideways ? ['left', 'right'] : ['top', 'bottom'];
  if (wrap > 60 && wrap > Math.max(...inside) * 1.25)
    return `${name}'s ${end} edge does not run on into its ${first} edge`;
  const ends = [plain(rows[0]), plain(rows[last])];
  if (
    ends[0] &&
    ends[0] === ends[1] &&
    plain(rows[1]) !== ends[0] &&
    plain(rows[last - 1]) !== ends[0]
  )
    return `${name} draws a ${ends[0]} line along both its ${first} and ${end} edges, twice as thick where tiles meet`;
  // A line in a colour the tile's inside never uses: tiled, it rules a grid over the ground.
  for (const [at, colour] of ends.entries()) {
    if (!colour) continue;
    const used = rows
      .slice(1, last)
      .some((row) => row.slice(1, -1).some((pixel) => hex(pixel) === colour));
    if (!used)
      return `${name} has a line along its ${at ? end : first} edge that its inside never draws`;
  }
  return null;
}
