/** The design in a project's design/ folder, as the Design page, the server and the apps read it. */

export type Board = { x: number; y: number; w: number; h: number; title?: string };
export type Note = {
  x: number;
  y: number;
  w?: number;
  text?: string;
  kind?: string;
  fill?: string;
};
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
    const above = titles.filter((section) => section.y <= board.y);
    const rowY = Math.max(...above.map((section) => section.y));
    const row = above.filter((section) => section.y === rowY);
    const home =
      row.filter((section) => section.x <= board.x).sort((a, b) => b.x - a.x)[0] ?? row[0];
    if (home) home.boards.push(file);
    else loose.push(file);
  }
  const placed = titles.filter((section) => section.boards.length);
  if (loose.length)
    placed.unshift({ id: 'section-loose', title: 'Boards', x: 0, y: 0, boards: loose });
  return placed;
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
