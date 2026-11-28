// Pixel grids: sprites written as text, a character a pixel, that `deploy design pixels` (and
// `check --fix`) draws into the art board as svg.art-sprite. The grid is the source the next agent
// edits; the board is what is checked, looked at and exported.
//
// design/pixels/<Name>.txt:
//   # a comment
//   board: Sprites        the art board it goes on (default: the project's only art board)
//   tile                  it repeats: drawn with class tile, and checked for seams
//   zoom: 8               how big the sheet shows it (default 8)
//   K = ink               a character for --pal-ink in look.css (or a colour: K = #1c1620)
//   . = none              see-through (. and space are see-through unless given a colour)
//   ..KKKK..
//   .KOOOOK.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A grid file read: its name, where it goes, its colours by character and its rows. */
export function parsePixels(text, name) {
  const legend = new Map();
  const rows = [];
  const keys = {};
  let tile = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!rows.length) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const pair = /^(\S)\s+=\s+(\S+)$/.exec(line);
      if (pair) {
        legend.set(pair[1], pair[2]);
        continue;
      }
      if (/^tile$/i.test(line.trim())) {
        tile = true;
        continue;
      }
      const key = /^([a-z]+):\s*(.+)$/i.exec(line.trim());
      if (key) {
        keys[key[1].toLowerCase()] = key[2].trim();
        continue;
      }
    }
    if (!line.trim() && rows.length) break;
    rows.push(line);
  }
  const width = Math.max(0, ...rows.map((row) => row.length));
  const problems = [];
  if (!rows.length) problems.push(`${name} has no rows of pixels`);
  rows.forEach((row, at) => {
    if (row.length !== width)
      problems.push(`${name} row ${at + 1} is ${row.length} wide, not ${width}`);
    for (const char of row)
      if (char !== '.' && char !== ' ' && !legend.has(char))
        problems.push(
          `${name} row ${at + 1} uses "${char}", which no "${char} = <colour>" line names`,
        );
  });
  return {
    name,
    board: keys.board ? keys.board.replace(/\.html$/, '') : null,
    zoom: Math.max(1, Math.round(Number(keys.zoom) || 8)),
    tile,
    legend,
    rows: rows.map((row) => row.padEnd(width, '.')),
    width,
    height: rows.length,
    problems: [...new Set(problems)].slice(0, 4),
  };
}

/** A colour from the legend as SVG paint: a palette name is var(--pal-name). */
const paint = (value) =>
  /^(#|rgb|hsl|var\()/i.test(value)
    ? value
    : `var(--${value.startsWith('pal-') || value.startsWith('stage-') ? value : `pal-${value}`})`;

/** The sprite's rects: a run of one colour in a row is one rect. */
export function pixelRects(sprite) {
  const out = [];
  sprite.rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const char = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === char) end++;
      const colour = sprite.legend.get(char);
      if (colour && colour !== 'none' && colour !== 'transparent')
        out.push(
          `<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${paint(colour)}" />`,
        );
      x = end;
    }
  });
  return out.join('');
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const setAttr = (tag, name, value) =>
  attr(tag, name) === null
    ? tag.replace(/^<svg\b/, `<svg ${name}="${value}"`)
    : tag.replace(new RegExp(`(\\s${name}=)"[^"]*"`), `$1"${value}"`);

/**
 * The board with each sprite drawn from its grid: every svg whose data-layer or data-pixels names
 * it gets its pixels (copies keep their own size), and a sprite the board lacks gets a set of its
 * own at the end. Returns the html and the names drawn.
 */
export function drawPixels(html, sprites) {
  let out = html;
  const drawn = [];
  for (const sprite of sprites) {
    const inner = pixelRects(sprite);
    let found = false;
    out = out.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/g, (element) => {
      const tag = /^<svg\b[^>]*>/.exec(element)[0];
      if (attr(tag, 'data-layer') !== sprite.name && attr(tag, 'data-pixels') !== sprite.name)
        return element;
      found = true;
      let next = setAttr(tag, 'viewBox', `0 0 ${sprite.width} ${sprite.height}`);
      next = setAttr(next, 'shape-rendering', 'crispEdges');
      if (attr(tag, 'data-layer') === sprite.name) {
        const classes = new Set((attr(next, 'class') ?? '').split(/\s+/).filter(Boolean));
        classes.add('art-sprite');
        if (sprite.tile) classes.add('tile');
        next = setAttr(next, 'class', [...classes].join(' '));
      }
      if (attr(next, 'width') === null)
        next = setAttr(next, 'width', String(sprite.width * sprite.zoom));
      if (attr(next, 'height') === null)
        next = setAttr(next, 'height', String(sprite.height * sprite.zoom));
      return `${next}${inner}</svg>`;
    });
    if (!found) {
      const svg = `<svg class="art-sprite${sprite.tile ? ' tile' : ''}" data-layer="${sprite.name}" viewBox="0 0 ${sprite.width} ${sprite.height}" width="${sprite.width * sprite.zoom}" height="${sprite.height * sprite.zoom}" shape-rendering="crispEdges">${inner}</svg>`;
      const set = `    <section class="art-set" data-layer="${sprite.name}-set">\n      <h2>${sprite.name}</h2>\n      ${svg}\n    </section>\n`;
      out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${set}  </body>`) : `${out}\n${set}`;
    }
    drawn.push(sprite.name);
  }
  return { html: out, drawn };
}

/** The art boards of a project: boards whose head says platform=art. */
function artBoards(top) {
  const dir = join(top, 'design', 'boards');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(
    (file) =>
      file.endsWith('.html') &&
      /<meta[^>]+name="design-board"[^>]+platform=art/.test(readFileSync(join(dir, file), 'utf8')),
  );
}

/**
 * Every grid under design/pixels/ drawn into its board. Returns what it drew, by board, and the
 * grids it could not draw, with why; writes only boards that changed.
 */
export function syncPixels(top) {
  const folder = join(top, 'design', 'pixels');
  if (!existsSync(folder)) return { drawn: {}, problems: [] };
  const grids = readdirSync(folder)
    .filter((file) => file.endsWith('.txt'))
    .sort()
    .map((file) =>
      parsePixels(readFileSync(join(folder, file), 'utf8'), file.replace(/\.txt$/, '')),
    );
  const problems = grids.flatMap((grid) => grid.problems);
  const boards = artBoards(top);
  const byBoard = new Map();
  for (const grid of grids) {
    if (grid.problems.length) continue;
    const file = grid.board
      ? `${grid.board}.html`
      : boards.length === 1
        ? boards[0]
        : boards.includes('Sprites.html')
          ? 'Sprites.html'
          : null;
    if (!file || !existsSync(join(top, 'design', 'boards', file))) {
      problems.push(
        `${grid.name} has no board to go on: put "board: <Board>" in design/pixels/${grid.name}.txt`,
      );
      continue;
    }
    byBoard.set(file, [...(byBoard.get(file) ?? []), grid]);
  }
  const drawn = {};
  for (const [file, sprites] of byBoard) {
    const path = join(top, 'design', 'boards', file);
    const html = readFileSync(path, 'utf8');
    const next = drawPixels(html, sprites);
    if (next.html !== html) {
      writeFileSync(path, next.html);
      drawn[file] = next.drawn;
    }
  }
  return { drawn, problems };
}
