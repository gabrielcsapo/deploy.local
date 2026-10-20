/** Serializable geometry only; pointer state, DOM and hit targets never enter the document. */
export type MarkPoint = { x: number; y: number };
export type MarkTool = 'pen' | 'arrow' | 'rectangle' | 'text';
export type MarkColor = 'accent' | 'statusAttention' | 'statusFailed';
export type MarkShape = {
  tool: MarkTool;
  points: MarkPoint[];
  color: MarkColor;
  width: number;
  text?: string;
};
export type MarkHistory = { shapes: MarkShape[]; redo: MarkShape[][]; undo: MarkShape[][] };
export const emptyMarks = (): MarkHistory => ({ shapes: [], undo: [], redo: [] });
export function changeMarks(history: MarkHistory, shapes: MarkShape[]): MarkHistory {
  return { shapes: structuredClone(shapes), undo: [...history.undo, history.shapes], redo: [] };
}
export function undoMarks(h: MarkHistory): MarkHistory {
  return h.undo.length
    ? { shapes: h.undo.at(-1)!, undo: h.undo.slice(0, -1), redo: [...h.redo, h.shapes] }
    : h;
}
export function redoMarks(h: MarkHistory): MarkHistory {
  return h.redo.length
    ? { shapes: h.redo.at(-1)!, redo: h.redo.slice(0, -1), undo: [...h.undo, h.shapes] }
    : h;
}
export function serializeMarks(shapes: MarkShape[]) {
  return JSON.stringify(
    shapes.map(({ tool, points, color, width, text }) => ({
      tool,
      points: points.map(({ x, y }) => ({ x, y })),
      color,
      width,
      ...(text === undefined ? {} : { text }),
    })),
  );
}
export function flattenSize(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw new Error('Invalid image dimensions');
  return { width, height };
}
