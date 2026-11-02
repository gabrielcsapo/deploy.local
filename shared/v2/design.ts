/** The design in a project's design/ folder, as the Design page, the server and the apps read it. */

export type Board = { x: number; y: number; w: number; h: number; title?: string };
export type Note = {
  x: number;
  y: number;
  w?: number;
  h?: number;
  text?: string;
  kind?: string;
  fill?: string;
} & Partial<Omit<Mark, 'kind'>>;
/**
 * A mark drawn on the canvas with the pen, like Apple Pencil markup: it sits beside the boards,
 * as sticky notes do, so it never becomes part of a design. Its path is in its own units, pw by
 * ph, drawn at w by h.
 */
export type Mark = {
  kind: 'mark';
  path: string;
  pw: number;
  ph: number;
  /** A colour token: danger, ink, accent, active, success or warning. */
  stroke: string;
  width: number;
  arrow?: boolean;
  rotate?: number;
  opacity?: number;
  hidden?: boolean;
};
export const markColors = ['danger', 'ink', 'accent', 'active', 'success', 'warning'];
export const isMark = (note: Note): note is Note & Mark => note.kind === 'mark';
/** A mark's name in the panels. */
export const markName = (note: Note) => (note.arrow ? 'Annotation · arrow' : 'Annotation');
export type Canvas = {
  title?: string;
  boards: Record<string, Board>;
  order?: string[];
  notes?: Record<string, Note>;
};
export type Section = { id: string; title: string; x: number; y: number; boards: string[] };
export type LayerChange = {
  layer: string;
  change: 'added' | 'removed' | 'changed';
  details: string[];
};

export const boardName = (file: string) => file.replace(/\.html$/, '');

/**
 * Sections are the canvas's title notes (`section-*`). They sit in rows; a board belongs to the
 * last section whose row starts at or above it and whose column starts at or left of it.
 */
export function sections(canvas: Canvas): Section[] {
  const titles = Object.entries(canvas.notes ?? {})
    .filter(([id, note]) => id.startsWith('section-') && note.text)
    .map(([id, note]) => ({
      id,
      title: note.text!.replace(/\s*\(for approval\)\s*$/i, '').trim(),
      x: note.x,
      y: note.y,
      boards: [] as string[],
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const order = canvas.order?.length ? canvas.order : Object.keys(canvas.boards);
  const loose: string[] = [];
  for (const file of order) {
    const board = canvas.boards[file];
    if (!board) continue;
    const home = homeOf(titles, board);
    if (home) home.boards.push(file);
    else loose.push(file);
  }
  const placed = titles.filter((section) => section.boards.length);
  if (loose.length)
    placed.unshift({ id: 'section-loose', title: 'Boards', x: 0, y: 0, boards: loose });
  return placed;
}

function homeOf<T extends { x: number; y: number }>(titles: T[], at: { x: number; y: number }) {
  const above = titles.filter((section) => section.y <= at.y);
  const rowY = Math.max(...above.map((section) => section.y));
  const row = above.filter((section) => section.y === rowY);
  return row.filter((section) => section.x <= at.x).sort((a, b) => b.x - a.x)[0] ?? row[0];
}

/** The page a spot on the canvas belongs to, by the rule boards follow; null outside every page. */
export function sectionAt(list: Section[], at: { x: number; y: number }) {
  return (
    homeOf(
      list.filter((section) => section.id !== 'section-loose'),
      at,
    ) ??
    list.find((section) => section.id === 'section-loose') ??
    null
  );
}

/** A layer's name in the panels: its own text when it is short text, otherwise its ID in words. */
export function layerLabel(id: string, text: string) {
  const own = text.replace(/\s+/g, ' ').trim();
  if (own && own.length <= 40) return own;
  const words = id.replace(/-\d+$/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A canvas note whose text a design branch changed, line by line: the lines that went from the
 * note and the lines that are new in it. Pen marks are counted, not compared; they have no text.
 */
export type NoteChange = {
  id: string;
  title: string;
  before: { text: string; gone: boolean }[] | null;
  after: { text: string; added: boolean }[] | null;
  /** New lines in the note, out of all its lines now. */
  changed: number;
  total: number;
};

export function noteChanges(before: Canvas | null, after: Canvas | null): NoteChange[] {
  const old = before?.notes ?? {};
  const now = after?.notes ?? {};
  const changes: NoteChange[] = [];
  for (const id of new Set([...Object.keys(old), ...Object.keys(now)])) {
    const [a, b] = [old[id], now[id]];
    if ((a && isMark(a)) || (b && isMark(b)) || (a?.text ?? null) === (b?.text ?? null)) continue;
    const was = a?.text?.split('\n') ?? null;
    const is = b?.text?.split('\n') ?? null;
    const added = is?.filter((line) => !was?.includes(line)).length ?? 0;
    changes.push({
      id,
      title: (is ?? was ?? [''])[0].replace(/\s*\(for approval\)\s*$/i, '').trim() || id,
      before: was?.map((text) => ({ text, gone: !is?.includes(text) })) ?? null,
      after: is?.map((text) => ({ text, added: !was?.includes(text) })) ?? null,
      changed: added,
      total: is?.length ?? 0,
    });
  }
  return changes;
}

/** Pen marks a design branch drew, moved or removed. */
export function markChanges(before: Canvas | null, after: Canvas | null) {
  const old = before?.notes ?? {};
  const now = after?.notes ?? {};
  return [...new Set([...Object.keys(old), ...Object.keys(now)])].filter(
    (id) =>
      ((old[id] && isMark(old[id])) || (now[id] && isMark(now[id]))) &&
      JSON.stringify(old[id] ?? null) !== JSON.stringify(now[id] ?? null),
  ).length;
}

/**
 * The canvas a design branch leaves on main when main moved since the branch started: main's
 * canvas with the branch's own edits on top, board by board and note by note, so approving one
 * branch never drops what another approval added.
 */
export function mergeCanvas(base: Canvas, main: Canvas, branch: Canvas): Canvas {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const merged = JSON.parse(JSON.stringify(main)) as Canvas & Record<string, unknown>;
  const was = base as Canvas & Record<string, unknown>;
  const now = branch as Canvas & Record<string, unknown>;
  for (const key of ['boards', 'notes'] as const) {
    const into = (merged[key] ??= {}) as Record<string, unknown>;
    const before = (was[key] ?? {}) as Record<string, unknown>;
    const after = (now[key] ?? {}) as Record<string, unknown>;
    for (const id of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (same(before[id], after[id])) continue;
      if (after[id] === undefined) delete into[id];
      else into[id] = after[id];
    }
  }
  if (!same(was.order, now.order)) {
    const removed = new Set((was.order ?? []).filter((file) => !(now.order ?? []).includes(file)));
    const kept = (merged.order ?? []).filter((file) => !removed.has(file));
    merged.order = [...kept, ...(now.order ?? []).filter((file) => !kept.includes(file))];
  }
  for (const key of Object.keys({ ...was, ...now }))
    if (!['boards', 'notes', 'order'].includes(key) && !same(was[key], now[key]))
      if (now[key] === undefined) delete merged[key];
      else merged[key] = now[key];
  return merged;
}

const counted = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * What a design review changes, in words: "The note “Drawing: how it works” changed on design/x."
 * or "2 boards and 1 note changed on design/x: Welcome, WelcomeNarrow."
 */
export function changeSummary(
  branch: string,
  change: { boards: string[]; notes: NoteChange[]; marks: number; others: number },
) {
  const { boards, notes, marks, others } = change;
  if (!boards.length && !marks && !others && notes.length === 1)
    return `The note “${notes[0].title}” ${notes[0].after ? (notes[0].before ? 'changed' : 'was added') : 'was removed'} on ${branch}.`;
  const parts = [
    boards.length ? counted(boards.length, 'board') : '',
    notes.length ? counted(notes.length, 'note') : '',
    marks ? counted(marks, 'mark') : '',
    others ? counted(others, 'other design file') : '',
  ].filter(Boolean);
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  const names = boards.length
    ? `: ${boards.slice(0, 4).join(', ')}${boards.length > 4 ? '…' : ''}`
    : '';
  return `${said ?? 'Nothing'} changed on ${branch}${names}.`;
}

/** One line a reviewer reads: "Welcome to deploy.local: font-size 30px, line-height 36px". */
export function describeChange(change: LayerChange, name: string) {
  if (change.change === 'added') return `${name} added`;
  if (change.change === 'removed') return `${name} removed`;
  return `${name}: ${change.details.slice(0, 3).join(', ')}${change.details.length > 3 ? '…' : ''}`;
}
