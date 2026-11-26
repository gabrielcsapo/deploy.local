// Where boards sit on the canvas: on top of another board, on a note or a section title, and the
// free place nearest a board for a new one. Notes carry no height, so theirs is estimated from
// their words the way the canvas wraps them; a section title is a band as wide as it may run.
import type { CheckProblem } from '../../shared/v2/design-overflow.ts';

export type Rect = { x: number; y: number; w: number; h: number };
type Placed = { x?: number; y?: number; w?: number; h?: number };
type Note = {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  maxW?: number;
  text?: string;
  kind?: string;
  size?: string;
};
type Finding = CheckProblem & { code: string };

export const rectOf = (placed: Placed | undefined): Rect | null => {
  if (!placed) return null;
  const rect = {
    x: Number(placed.x),
    y: Number(placed.y),
    w: Number(placed.w),
    h: Number(placed.h),
  };
  return Object.values(rect).every(Number.isFinite) && rect.w > 0 && rect.h > 0 ? rect : null;
};

export const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** A note's rectangle: what it says, else its words wrapped at its width; a title is a band. */
export function noteRect(note: Note): Rect | null {
  const x = Number(note.x);
  const y = Number(note.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || note.kind === 'mark') return null;
  const text = String(note.text ?? '');
  if (/^title/.test(note.kind ?? '')) {
    const size = note.size === 'xxl' ? 64 : 44;
    const w = Math.min(Number(note.maxW) || 4000, Math.max(200, text.length * size * 0.5));
    return { x, y, w, h: Number(note.h) || Math.round(size * 1.4) };
  }
  const w = Number(note.w) || 420;
  if (Number(note.h)) return { x, y, w, h: Number(note.h) };
  // Tight, so a board placed beside a note is not pushed away: about 7 px a character at 15 px
  // type, 20 px a line, 12 px of padding above and below.
  const perLine = Math.max(1, Math.floor((w - 24) / 7));
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { x, y, w, h: 24 + lines * 20 };
}

type Canvas = { boards?: Record<string, Placed>; notes?: Record<string, Note> };

/** Everything that takes room on a canvas, but the boards named. */
function occupied(canvas: Canvas | null | undefined, except: string[] = []) {
  const rects: Rect[] = [];
  for (const [file, placed] of Object.entries(canvas?.boards ?? {})) {
    if (except.includes(file)) continue;
    const rect = rectOf(placed);
    if (rect) rects.push(rect);
  }
  for (const note of Object.values(canvas?.notes ?? {})) {
    const rect = noteRect(note);
    if (rect) rects.push(rect);
  }
  return rects;
}

/** The gap boards in a row usually keep: the median gap between neighbours at the same y. */
export function rowGap(canvas: Canvas | null | undefined, y: number, fallback = 160) {
  const row = Object.values(canvas?.boards ?? {})
    .map(rectOf)
    .filter((rect): rect is Rect => Boolean(rect) && Math.abs(rect!.y - y) < 1)
    .sort((a, b) => a.x - b.x);
  const gaps = row
    .slice(1)
    .map((rect, at) => rect.x - (row[at].x + row[at].w))
    .filter((gap) => gap > 0 && gap < 2000)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : fallback;
}

/**
 * The free place nearest a board for one of a size, clear of every board and note by half the
 * row's usual gap. It looks beside the board's right edge, its left edge and below it, sliding
 * past whatever is in the way, and takes whichever is nearest (right, then left, then below on a
 * tie). With no board to be near, or nothing free within reach, it goes under everything.
 */
export function freeSpot(
  canvas: Canvas | null | undefined,
  size: { w: number; h: number },
  near: Rect | null,
  except: string[] = [],
  reach = 6000,
): { x: number; y: number; side: 'right' | 'left' | 'below' | 'bottom' } {
  const taken = occupied(canvas, except);
  const gap = near ? rowGap(canvas, near.y) : 160;
  const blockers = (x: number, y: number) => {
    const padded = { x: x - gap / 2, y: y - gap / 2, w: size.w + gap, h: size.h + gap };
    return taken.filter((other) => intersects(padded, other));
  };
  if (near) {
    const sides = [
      {
        side: 'right' as const,
        start: { x: near.x + near.w + gap, y: near.y },
        next: (spot: { x: number; y: number }, hit: Rect[]) => ({
          ...spot,
          x: Math.max(...hit.map((other) => other.x + other.w)) + gap,
        }),
      },
      {
        side: 'left' as const,
        start: { x: near.x - gap - size.w, y: near.y },
        next: (spot: { x: number; y: number }, hit: Rect[]) => ({
          ...spot,
          x: Math.min(...hit.map((other) => other.x)) - gap - size.w,
        }),
      },
      {
        side: 'below' as const,
        start: { x: near.x, y: near.y + near.h + gap },
        next: (spot: { x: number; y: number }, hit: Rect[]) => ({
          ...spot,
          y: Math.max(...hit.map((other) => other.y + other.h)) + gap,
        }),
      },
    ];
    const found = sides
      .map(({ side, start, next }) => {
        let { x, y } = start;
        for (let step = 0; step < 50; step++) {
          const travelled = Math.abs(x - start.x) + Math.abs(y - start.y);
          if (travelled > reach) return null;
          const hit = blockers(x, y);
          if (!hit.length) return { x, y, side, travelled };
          ({ x, y } = next({ x, y }, hit));
        }
        return null;
      })
      .filter((spot): spot is NonNullable<typeof spot> => Boolean(spot));
    // Nearest first; the order above breaks a tie.
    const best = found.sort((a, b) => a.travelled - b.travelled)[0];
    if (best) return { x: best.x, y: best.y, side: best.side };
  }
  // An empty canvas starts at its corner.
  if (!taken.length) return { x: 0, y: 0, side: 'bottom' };
  const bottom = Math.max(0, ...taken.map((other) => other.y + other.h));
  return { x: near?.x ?? 0, y: bottom + gap, side: 'bottom' };
}

const moved = (branch: Placed | undefined, main: Placed | undefined) =>
  !main || JSON.stringify(main) !== JSON.stringify(branch);

/**
 * Boards placed on top of each other on the branch's canvas that were apart (or absent) on main,
 * with the free place to move to.
 */
export function overlapProblems(canvas: Canvas | null | undefined, main: Canvas | null = null) {
  const branch = canvas?.boards ?? {};
  const before = main?.boards ?? {};
  const entries = Object.entries(branch);
  const findings: Finding[] = [];
  for (let at = 0; at < entries.length; at++)
    for (let next = at + 1; next < entries.length; next++) {
      const [[a, placedA], [b, placedB]] = [entries[at], entries[next]];
      const [rectA, rectB] = [rectOf(placedA), rectOf(placedB)];
      if (!rectA || !rectB || !intersects(rectA, rectB)) continue;
      const [mainA, mainB] = [rectOf(before[a]), rectOf(before[b])];
      if (mainA && mainB && intersects(mainA, mainB)) continue;
      // The board that moved or is new is the one to move.
      const mover = moved(placedB, before[b]) ? b : a;
      const other = mover === a ? b : a;
      const rect = mover === a ? rectA : rectB;
      const spot = freeSpot(canvas, rect, rectOf(branch[other]), [mover]);
      findings.push({
        code: 'boards_overlap',
        file: mover,
        board: mover.replace(/\.html$/, ''),
        label: `${mover} sits on top of ${other} on the canvas`,
        detail: `x ${rect.x}, y ${rect.y}, ${rect.w} × ${rect.h}`,
        short: `on top of ${other}`,
        fix: `move it to x ${spot.x}, y ${spot.y} in canvas.json (free), or run deploy design check --fix`,
      });
    }
  return findings;
}

/** Boards the branch placed or moved onto a canvas note or section title. */
export function noteOverlapProblems(canvas: Canvas | null | undefined, main: Canvas | null = null) {
  const findings: Finding[] = [];
  const notes = Object.entries(canvas?.notes ?? {})
    .map(([id, note]) => ({ id, note, rect: noteRect(note) }))
    .filter((entry): entry is { id: string; note: Note; rect: Rect } => Boolean(entry.rect));
  for (const [file, placed] of Object.entries(canvas?.boards ?? {})) {
    const rect = rectOf(placed);
    if (!rect || !moved(placed, main?.boards?.[file])) continue;
    const hit = notes.find((entry) => intersects(rect, entry.rect));
    if (!hit) continue;
    const title = /^title/.test(hit.note.kind ?? '');
    const spot = freeSpot(canvas, rect, rect, [file]);
    const words = String(hit.note.text ?? '').split('\n')[0];
    findings.push({
      code: 'board_overlaps_note',
      file,
      board: file.replace(/\.html$/, ''),
      label: `${file} covers the ${title ? 'section title' : 'note'} "${words.length > 40 ? `${words.slice(0, 39)}…` : words}"`,
      detail: `x ${rect.x}, y ${rect.y}, ${rect.w} × ${rect.h}`,
      short: `covers ${title ? 'a section title' : 'a note'}`,
      fix: `move it to x ${spot.x}, y ${spot.y} in canvas.json (free), or run deploy design check --fix`,
    });
  }
  return findings;
}

/** Words that come first in a pair or a run of boards: Front before Back, Cover before Inside. */
const wordRank: Record<string, number> = {
  cover: 0,
  front: 0,
  intro: 0,
  light: 0,
  inside: 1,
  back: 2,
  dark: 2,
};

/**
 * Board file names in the order a person counts them: Slide2 before Slide10, Front before Back.
 * A name's words and numbers are compared part by part; the canvas's own order wins when it lists
 * both boards.
 */
export function boardOrder(a: string, b: string, order: string[] = []) {
  const [at, bt] = [order.indexOf(a), order.indexOf(b)];
  if (at >= 0 && bt >= 0) return at - bt;
  const parts = (file: string) =>
    (file.replace(/\.html$/, '').match(/\d+|[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? []).map((part) =>
      /^\d+$/.test(part) ? Number(part) : part.toLowerCase(),
    );
  const [pa, pb] = [parts(a), parts(b)];
  for (let n = 0; n < Math.max(pa.length, pb.length); n++) {
    const [x, y] = [pa[n], pb[n]];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    const [rx, ry] = [wordRank[x], wordRank[y]];
    if (rx !== undefined && ry !== undefined && rx !== ry) return rx - ry;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** The gap boards on this canvas keep: the row at y if it has one, else the median over all rows. */
export function canvasGap(canvas: Canvas | null | undefined, y: number, fallback = 160) {
  const own = rowGap(canvas, y, -1);
  if (own > 0) return own;
  const gaps = [
    ...new Set(
      Object.values(canvas?.boards ?? {})
        .map(rectOf)
        .filter((rect): rect is Rect => Boolean(rect))
        .map((rect) => rect.y),
    ),
  ]
    .map((row) => rowGap(canvas, row, -1))
    .filter((gap) => gap > 0)
    .sort((a, b) => a - b);
  return gaps.length ? gaps[Math.floor(gaps.length / 2)] : fallback;
}

/** Whether a rectangle is clear of every board and note but those named, by half a gap. */
function isFree(canvas: Canvas | null | undefined, rect: Rect, gap: number, except: string[]) {
  const padded = { x: rect.x - gap / 2, y: rect.y - gap / 2, w: rect.w + gap, h: rect.h + gap };
  return !occupied(canvas, except).some((other) => intersects(padded, other));
}

/** Boards a row holds before the next board starts another row. */
export const rowLength = 6;

/**
 * Beside its siblings: boards of one kind in a row in name and number order, with the canvas's
 * gap, a new row below past six. It goes right of the sibling before it in that order, else left
 * of the one after; a place that is taken falls back to the free place nearest that sibling.
 * Null when it has no sibling placed.
 */
export function placeInRow(input: {
  canvas: Canvas | null | undefined;
  file: string;
  size: { w: number; h: number };
  siblings: string[];
  order?: string[];
}): { x: number; y: number; side: 'right' | 'left' | 'below' | 'bottom'; near: string } | null {
  const placed = input.siblings
    .filter((file) => file !== input.file && rectOf(input.canvas?.boards?.[file]))
    .sort((a, b) => boardOrder(a, b, input.order));
  if (!placed.length) return null;
  const before = placed.filter((file) => boardOrder(file, input.file, input.order) < 0);
  const anchor = before.at(-1) ?? placed[0];
  const rect = rectOf(input.canvas?.boards?.[anchor])!;
  const gap = canvasGap(input.canvas, rect.y);
  const except = [input.file];
  const { w, h } = input.size;
  if (before.length) {
    const row = placed
      .map((file) => rectOf(input.canvas?.boards?.[file])!)
      .filter((other) => Math.abs(other.y - rect.y) < 1);
    if (row.length >= rowLength) {
      const start = Math.min(...row.map((other) => other.x));
      const bottom = Math.max(...row.map((other) => other.y + other.h));
      const spot = { x: start, y: bottom + gap, w, h };
      if (isFree(input.canvas, spot, gap, except))
        return { x: spot.x, y: spot.y, side: 'below', near: anchor };
    } else {
      const spot = { x: rect.x + rect.w + gap, y: rect.y, w, h };
      if (isFree(input.canvas, spot, gap, except))
        return { x: spot.x, y: spot.y, side: 'right', near: anchor };
    }
  } else {
    const spot = { x: rect.x - gap - w, y: rect.y, w, h };
    if (isFree(input.canvas, spot, gap, except))
      return { x: spot.x, y: spot.y, side: 'left', near: anchor };
  }
  return { ...freeSpot(input.canvas, input.size, rect, except), near: anchor };
}

/**
 * Where --fix puts a board with no place or a bad one: the free place nearest the board it came
 * from (source=, copied_from=, or the one it was found to copy), else nearest where it is.
 */
export function placeBoard(input: {
  canvas: Canvas | null | undefined;
  file: string;
  size: { w: number; h: number };
  near: string | null;
  /** Boards of the same kind already placed: the new board goes in a row with them. */
  siblings?: string[];
  order?: string[];
}) {
  if (!input.near && input.siblings?.length) {
    const row = placeInRow({ ...input, siblings: input.siblings });
    if (row) return row;
  }
  const near = (input.near && rectOf(input.canvas?.boards?.[input.near])) || null;
  const current = rectOf(input.canvas?.boards?.[input.file]);
  return {
    ...freeSpot(input.canvas, input.size, near ?? current, [input.file]),
    near: near ? input.near : null,
  };
}
