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
    const w = Math.min(Number(note.maxW) || 4000, Math.max(400, text.length * size * 0.55));
    return { x, y, w, h: Number(note.h) || size * 2 };
  }
  const w = Number(note.w) || 420;
  if (Number(note.h)) return { x, y, w, h: Number(note.h) };
  // About 8 px a character at 15 px type, 22 px a line, 16 px of padding around.
  const perLine = Math.max(1, Math.floor((w - 32) / 8));
  const lines = text
    .split('\n')
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { x, y, w, h: 32 + lines * 22 };
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
 * The free place nearest a board for one of a size: to its right in its row, then below it,
 * then further right, keeping the row's usual gap. Clear of every board and note.
 */
export function freeSpot(
  canvas: Canvas | null | undefined,
  size: { w: number; h: number },
  near: Rect | null,
  except: string[] = [],
): { x: number; y: number } {
  const taken = occupied(canvas, except);
  const gap = near ? rowGap(canvas, near.y) : 160;
  const free = (x: number, y: number) => {
    const rect = { x, y, w: size.w, h: size.h };
    const padded = { x: x - gap / 2, y: y - gap / 2, w: size.w + gap, h: size.h + gap };
    return !taken.some((other) => intersects(padded, other) || intersects(rect, other));
  };
  if (near) {
    // Right along the row, as far as twenty boards over.
    for (let step = 0, x = near.x + near.w + gap; step < 20; step++) {
      if (free(x, near.y)) return { x, y: near.y };
      const blocker = taken
        .filter((other) => intersects({ x, y: near.y, w: size.w, h: size.h }, other))
        .sort((a, b) => b.x + b.w - (a.x + a.w))[0];
      x = blocker ? blocker.x + blocker.w + gap : x + size.w + gap;
    }
    // Below it.
    for (let step = 1, y = near.y + near.h + gap; step < 20; step++, y += gap)
      if (free(near.x, y)) return { x: near.x, y };
  }
  // Under everything, at the left.
  const bottom = Math.max(0, ...taken.map((other) => other.y + other.h));
  return { x: near?.x ?? 0, y: bottom + gap };
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

/**
 * Where --fix puts a board with no place or a bad one: the free place nearest the board it came
 * from (source=, copied_from=, or the one it was found to copy), else nearest where it is.
 */
export function placeBoard(input: {
  canvas: Canvas | null | undefined;
  file: string;
  size: { w: number; h: number };
  near: string | null;
}) {
  const near = (input.near && rectOf(input.canvas?.boards?.[input.near])) || null;
  const current = rectOf(input.canvas?.boards?.[input.file]);
  return freeSpot(input.canvas, input.size, near ?? current, [input.file]);
}
