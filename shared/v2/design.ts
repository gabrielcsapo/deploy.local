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

/** One line a reviewer reads: "Welcome to deploy.local: font-size 30px, line-height 36px". */
export function describeChange(change: LayerChange, name: string) {
  if (change.change === 'added') return `${name} added`;
  if (change.change === 'removed') return `${name} removed`;
  return `${name}: ${change.details.slice(0, 3).join(', ')}${change.details.length > 3 ? '…' : ''}`;
}
