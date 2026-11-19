// Changes to a canvas from the Design page's tools: sticky notes, pen marks, where Play starts,
// and new boards. deploy.local commits them to a design branch; `deploy design dev` writes them
// into the folder. Both apply them here, so the page behaves the same on either.
import { randomUUID } from 'node:crypto';
import { fail } from '../kernel/errors.ts';
import { markColors } from '../../shared/v2/design.ts';

/** A new, empty board styled by the design system, from the frame tool. */
export function blankBoard(title: string, w: number, h: number) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="design-board" content="width=${w},height=${h}">
<title>${title}</title>
<link rel="stylesheet" href="../ds/deploy-local/tokens.css">
<link rel="stylesheet" href="../ds/deploy-local/components/bundle.css">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap">
<style>
body{margin:0;min-height:100vh;background:var(--paper);font-family:"Hanken Grotesk",system-ui,sans-serif}
</style>
</head>
<body>
</body>
</html>
`;
}

/**
 * Applies one canvas edit to `canvas` in place. Returns the files to write besides canvas.json
 * (a new board's page) and the ID of what was made or changed.
 */
export function applyCanvasEdit(canvas: any, body: any, dir: string) {
  const op = body?.op;
  const notes = (canvas.notes ??= {}) as Record<string, any>;
  const at = (value: unknown) => {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) > 1e7) fail('A position is out of bounds');
    return Math.round(n);
  };
  const writes: { path: string; content: string }[] = [];
  let made: string;
  if (op === 'note') {
    const text = String(body.text ?? '').slice(0, 4000);
    if (body.id) {
      if (!notes[body.id]) fail(`No note named ${body.id}`, 404);
      notes[body.id] = {
        ...notes[body.id],
        text,
        ...(body.x !== undefined ? { x: at(body.x), y: at(body.y) } : {}),
      };
      made = body.id;
    } else {
      made = `note-${randomUUID().slice(0, 8)}`;
      notes[made] = { x: at(body.x), y: at(body.y), w: 240, h: 160, text };
    }
  } else if (op === 'mark') {
    // A pen mark on the canvas: drawn from its points, then changed a property at a time.
    const number = (value: unknown, low: number, high: number, name: string) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n < low || n > high) fail(`${name} must be ${low} to ${high}`);
      return Math.round(n * 10) / 10;
    };
    if (body.id) {
      const mark = notes[body.id];
      if (mark?.kind !== 'mark') fail(`No mark named ${body.id}`, 404);
      if (body.x !== undefined) mark.x = at(body.x);
      if (body.y !== undefined) mark.y = at(body.y);
      if (body.w !== undefined) mark.w = number(body.w, 1, 20000, 'W');
      if (body.h !== undefined) mark.h = number(body.h, 1, 20000, 'H');
      if (body.rotate !== undefined) mark.rotate = number(body.rotate, -360, 360, 'Rotation');
      if (body.width !== undefined) mark.width = number(body.width, 0.5, 40, 'Stroke width');
      if (body.opacity !== undefined) mark.opacity = number(body.opacity, 0, 1, 'Opacity');
      if (body.stroke !== undefined) {
        if (!markColors.includes(String(body.stroke))) fail('Pick a stroke colour token');
        mark.stroke = String(body.stroke);
      }
      if (body.arrow !== undefined) mark.arrow = Boolean(body.arrow);
      if (body.hidden !== undefined) mark.hidden = Boolean(body.hidden);
      made = body.id;
    } else {
      const points = body.points;
      if (!Array.isArray(points) || points.length < 2 || points.length > 2000)
        fail('A mark needs 2 to 2000 points');
      const xy = (points as unknown[]).map((point) => {
        if (!Array.isArray(point)) fail('A point is [x, y]');
        return [at((point as number[])[0]), at((point as number[])[1])];
      });
      const left = Math.min(...xy.map(([x]) => x));
      const top = Math.min(...xy.map(([, y]) => y));
      const pw = Math.max(1, Math.max(...xy.map(([x]) => x)) - left);
      const ph = Math.max(1, Math.max(...xy.map(([, y]) => y)) - top);
      const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x - left} ${y - top}`).join(' ');
      made = `mark-${randomUUID().slice(0, 8)}`;
      notes[made] = {
        kind: 'mark',
        x: left,
        y: top,
        w: pw,
        h: ph,
        pw,
        ph,
        path,
        stroke: markColors.includes(String(body.stroke)) ? String(body.stroke) : 'danger',
        width: body.width !== undefined ? number(body.width, 0.5, 40, 'Stroke width') : 2.5,
      };
    }
  } else if (op === 'start') {
    // Where Play starts on a page; null goes back to the page's first board.
    const page = String(body.page ?? '');
    if (!/^section-[a-z0-9-]{1,60}$/.test(page)) fail('Name a page');
    const starts = ((canvas as any).starts ??= {}) as Record<string, string>;
    if (body.board === null) delete starts[page];
    else {
      if (!canvas.boards[String(body.board)]) fail(`No board named ${body.board}`, 404);
      starts[page] = String(body.board);
    }
    made = page;
  } else if (op === 'remove-note') {
    if (!notes[body.id] || String(body.id).startsWith('section-')) fail('No such note', 404);
    delete notes[body.id];
    made = body.id;
  } else if (op === 'board') {
    const phone = body.kind === 'phone';
    const [w, h] = phone ? [390, 844] : [1440, 900];
    let n = 1;
    while (canvas.boards[`Board${n}.html`]) n++;
    made = `Board${n}.html`;
    canvas.boards[made] = { x: at(body.x), y: at(body.y), w, h, title: `Board ${n}` };
    if (Array.isArray((canvas as any).order)) (canvas as any).order.push(made);
    writes.push({
      path: `${dir}/boards/${made}`,
      content: blankBoard(`Board ${n}`, w, h),
    });
  } else fail('Unknown canvas edit');
  return { writes, made: made! };
}
