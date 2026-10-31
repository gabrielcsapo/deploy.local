/** The canvas a project's design/canvas.json describes, and what the Design page derives from it. */

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
export type Design = {
  ref: string;
  commit: string;
  canvas: Canvas | null;
  branches: { name: string; commit: string; updatedAt: string }[];
  openComments: number;
};
export type Section = { id: string; title: string; x: number; y: number; boards: string[] };
export type Tokens = {
  colors: { name: string; light: string; dark?: string; usage?: string }[];
  textStyles: { name: string; size: number; lineHeight: number; weight: number }[];
};

export const boardName = (file: string) => file.replace(/\.html$/, '');
export const isPhone = (board: Board) => board.w <= 500;

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

/** The smallest box around some boards, in canvas coordinates. */
export function bounds(canvas: Canvas, files: string[]) {
  const boards = files.map((file) => canvas.boards[file]).filter(Boolean);
  if (!boards.length) return { x: 0, y: 0, w: 1440, h: 900 };
  const x = Math.min(...boards.map((board) => board.x));
  const y = Math.min(...boards.map((board) => board.y));
  const right = Math.max(...boards.map((board) => board.x + board.w));
  const bottom = Math.max(...boards.map((board) => board.y + board.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Zoom and pan that fit a box into a viewport with some room around it. */
export function fit(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
) {
  const pad = 48;
  const z = Math.min(
    1,
    Math.max(0.02, Math.min((width - pad * 2) / box.w, (height - pad * 2) / box.h)),
  );
  return { z, x: (width - box.w * z) / 2 - box.x * z, y: (height - box.h * z) / 2 - box.y * z };
}

/** Read design/ds/deploy-local/tokens.json into the colours and text styles the panels match against. */
export function readTokens(json: any): Tokens {
  const colors = (json?.color?.tokens ?? []).flatMap((token: any) =>
    typeof token?.name === 'string'
      ? [
          {
            name: token.name,
            light: String(token.value?.light ?? token.value ?? ''),
            dark: token.value?.dark ? String(token.value.dark) : undefined,
            usage: token.usage,
          },
        ]
      : [],
  );
  const textStyles = (json?.type?.groups ?? []).flatMap((group: any) =>
    (group?.styles ?? []).flatMap((style: any) =>
      typeof style?.name === 'string'
        ? [
            {
              name: style.name,
              size: parseFloat(style.fontSize),
              lineHeight: parseFloat(style.lineHeight),
              weight: Number(style.fontWeight ?? style.weight ?? 400),
            },
          ]
        : [],
    ),
  );
  return { colors, textStyles };
}

/** An rgb()/rgba() or hex colour as six lowercase hex digits, or null when transparent or unknown. */
export function hex(color: string) {
  const short = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (short)
    return [...short[1]]
      .map((c) => c + c)
      .join('')
      .toLowerCase();
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (long) return long[2] && long[2].toLowerCase() !== 'ff' ? null : long[1].toLowerCase();
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(color.trim());
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) < 1)) return null;
  return rgb
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('');
}

export function colorToken(color: string, tokens: Tokens) {
  const value = hex(color);
  if (!value) return null;
  return tokens.colors.find((token) => hex(token.light) === value)?.name ?? null;
}

export function textStyle(size: number, lineHeight: number, weight: number, tokens: Tokens) {
  return (
    tokens.textStyles.find(
      (style) =>
        Math.abs(style.size - size) < 0.5 &&
        (Number.isNaN(style.lineHeight) || Math.abs(style.lineHeight - lineHeight) < 0.5) &&
        Math.abs(style.weight - weight) < 50,
    )?.name ?? null
  );
}

/** A layer's name in the panels: its own text when it is short text, otherwise its ID in words. */
export function layerLabel(id: string, text: string) {
  const own = text.replace(/\s+/g, ' ').trim();
  if (own && own.length <= 40) return own;
  const words = id.replace(/-\d+$/, '').replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
