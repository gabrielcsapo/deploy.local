import type { MarkShape, MarkColor } from './image-markup';

export function drawMarks(
  ctx: CanvasRenderingContext2D,
  shapes: MarkShape[],
  colors: Record<MarkColor, string>,
  reference: number,
  labelSize: number,
  fontFamily: string,
) {
  const { width, height } = ctx.canvas;
  const scale = Math.min(width, height) / reference;
  for (const s of shapes) {
    const p = s.points.map((point) => ({ x: point.x * width, y: point.y * height }));
    if (!p.length) continue;
    const a = p[0],
      b = p.at(-1)!;
    ctx.strokeStyle = ctx.fillStyle = colors[s.color];
    ctx.lineWidth = s.width * scale;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    if (s.tool === 'rectangle')
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    else if (s.tool === 'text') {
      ctx.font = `${labelSize * scale}px ${fontFamily}`;
      ctx.textBaseline = 'top';
      ctx.fillText(s.text || '', a.x, a.y);
    } else {
      for (const point of p.slice(1)) ctx.lineTo(point.x, point.y);
      if (p.length === 1) ctx.lineTo(a.x + 0.01, a.y);
      if (s.tool === 'arrow') {
        const angle = Math.atan2(b.y - a.y, b.x - a.x),
          length = s.width * scale * 4;
        for (const offset of [-Math.PI / 6, Math.PI / 6]) {
          ctx.moveTo(b.x, b.y);
          ctx.lineTo(
            b.x - length * Math.cos(angle + offset),
            b.y - length * Math.sin(angle + offset),
          );
        }
      }
    }
    ctx.stroke();
  }
}
