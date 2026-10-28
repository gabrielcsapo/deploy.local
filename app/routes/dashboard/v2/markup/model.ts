import type { Markup } from '../../../../../shared/v2/contracts';
export const markupColors = ['#e5484d', '#f5c518', '#4c8dff'] as const;
export const emptyMarkup = (): Markup => ({ strokes: [], texts: [] });
export function arrowHead(points: [number, number][]) {
  const [x, y] = points.at(-1)!;
  const [startX, startY] = points[0];
  const angle = Math.atan2(y - startY, x - startX);
  return [
    [x - 22 * Math.cos(angle - Math.PI / 6), y - 22 * Math.sin(angle - Math.PI / 6)],
    [x, y],
    [x - 22 * Math.cos(angle + Math.PI / 6), y - 22 * Math.sin(angle + Math.PI / 6)],
  ] as [number, number][];
}
export function paintMarkup(context: CanvasRenderingContext2D, markup: Markup) {
  context.lineWidth = 5;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of markup.strokes) {
    context.strokeStyle = markupColors[stroke.color];
    for (const points of [
      stroke.tool === 'arrow' ? [stroke.points[0], stroke.points.at(-1)!] : stroke.points,
      ...(stroke.tool === 'arrow' ? [arrowHead(stroke.points)] : []),
    ]) {
      context.beginPath();
      points.forEach(([x, y], i) => (i ? context.lineTo(x, y) : context.moveTo(x, y)));
      context.stroke();
    }
  }
  context.font = '30px sans-serif';
  context.lineWidth = 8;
  for (const text of markup.texts) {
    context.strokeStyle = '#ffffff';
    context.fillStyle = markupColors[text.color];
    context.strokeText(text.text, text.x, text.y);
    context.fillText(text.text, text.x, text.y);
  }
}
