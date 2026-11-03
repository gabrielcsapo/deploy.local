import fs from 'node:fs';
import glyphs from '@dicebear/styles/glyphs.json' with { type: 'json' };
const number = (n) => Number(n.toFixed(6)).toString();
const point = (x, y) => `CGPoint(x: ${number(x)}, y: ${number(y)})`;

// SVG endpoint arcs become cubic curves; conversion happens at generation time.
function arc(x, y, rx, ry, rotation, large, sweep, endX, endY) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (x === endX && y === endY) return [];
  if (!rx || !ry) return [`p.addLine(to: ${point(endX, endY)})`];
  const phi = (rotation * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (x - endX) / 2,
    dy = (y - endY) / 2;
  const px = cos * dx + sin * dy,
    py = -sin * dx + cos * dy;
  const scale = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (scale > 1) {
    rx *= Math.sqrt(scale);
    ry *= Math.sqrt(scale);
  }
  const factor =
    (large === sweep ? -1 : 1) *
    Math.sqrt(
      Math.max(
        0,
        (rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px) /
          (rx * rx * py * py + ry * ry * px * px),
      ),
    );
  const cxp = (factor * rx * py) / ry,
    cyp = (factor * -ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x + endX) / 2;
  const cy = sin * cxp + cos * cyp + (y + endY) / 2;
  const start = Math.atan2((py - cyp) / ry, (px - cxp) / rx);
  let delta = Math.atan2((-py - cyp) / ry, (-px - cxp) / rx) - start;
  if (sweep && delta < 0) delta += Math.PI * 2;
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  const count = Math.ceil(Math.abs(delta) / (Math.PI / 2)),
    step = delta / count;
  const map = (u, v) => [cx + rx * cos * u - ry * sin * v, cy + rx * sin * u + ry * cos * v];
  const lines = [];
  for (let i = 0; i < count; i++) {
    const a = start + i * step,
      b = a + step,
      k = (4 / 3) * Math.tan(step / 4);
    const c1 = map(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a));
    const c2 = map(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b));
    const end = i === count - 1 ? [endX, endY] : map(Math.cos(b), Math.sin(b));
    lines.push(
      `p.addCurve(to: ${point(...end)}, control1: ${point(...c1)}, control2: ${point(...c2)})`,
    );
  }
  return lines;
}

function svgPath(data) {
  const tokens = data.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0,
    command,
    x = 0,
    y = 0,
    startX = 0,
    startY = 0,
    controlX = 0,
    controlY = 0,
    previousCommand;
  const lines = [],
    take = () => {
      const value = Number(tokens[i++]);
      if (!Number.isFinite(value)) throw new Error(`Invalid SVG path: ${data}`);
      return value;
    };
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) command = tokens[i++];
    const relative = command === command.toLowerCase();
    const target = (a, b) => [relative ? x + a : a, relative ? y + b : b];
    const currentCommand = command.toUpperCase();
    switch (currentCommand) {
      case 'M':
      case 'L': {
        const [nx, ny] = target(take(), take());
        lines.push(`p.${command.toUpperCase() === 'M' ? 'move' : 'addLine'}(to: ${point(nx, ny)})`);
        if (command.toUpperCase() === 'M') {
          startX = nx;
          startY = ny;
          command = relative ? 'l' : 'L';
        }
        x = nx;
        y = ny;
        break;
      }
      case 'H':
        x = relative ? x + take() : take();
        lines.push(`p.addLine(to: ${point(x, y)})`);
        break;
      case 'V':
        y = relative ? y + take() : take();
        lines.push(`p.addLine(to: ${point(x, y)})`);
        break;
      case 'A': {
        const rx = take(),
          ry = take(),
          rotation = take(),
          large = take(),
          sweep = take();
        const [nx, ny] = target(take(), take());
        lines.push(...arc(x, y, rx, ry, rotation, large, sweep, nx, ny));
        x = nx;
        y = ny;
        break;
      }
      case 'C':
      case 'S': {
        const c1 =
          currentCommand === 'C'
            ? target(take(), take())
            : ['C', 'S'].includes(previousCommand)
              ? [2 * x - controlX, 2 * y - controlY]
              : [x, y];
        const c2 = target(take(), take());
        const end = target(take(), take());
        lines.push(
          `p.addCurve(to: ${point(...end)}, control1: ${point(...c1)}, control2: ${point(...c2)})`,
        );
        [controlX, controlY] = c2;
        [x, y] = end;
        break;
      }
      case 'Z':
        lines.push('p.closeSubpath()');
        x = startX;
        y = startY;
        command = undefined;
        break;
      default:
        throw new Error(`Unsupported SVG command ${command}`);
    }
    previousCommand = currentCommand;
  }
  return lines;
}

const cases = Object.entries(glyphs.components.shape.variants).map(([name, variant]) => {
  const paths = variant.elements.map((element) => {
    if (element.name !== 'path') throw new Error('Unexpected Glyphs element');
    const a = element.attributes;
    return `do { var p = Path()\n${svgPath(a.d).join('\n')}\ncontext.stroke(p, with: .color(tint), style: StrokeStyle(lineWidth: ${a['stroke-width']}, lineCap: .butt, lineJoin: .miter, miterLimit: 10)) }`;
  });
  return `case "${name}":\n${paths.join('\n')}`;
});
const output = `// Generated by scripts/build-agent-glyphs.mjs. Do not edit.
// DiceBear Glyphs 10.6.0 by Matt Houser, CC BY 4.0.
// https://creativecommons.org/licenses/by/4.0/
import SwiftUI

enum AgentGlyphPaths {
    static func draw(_ glyph: String, in context: inout GraphicsContext, tint: Color) {
        context.translateBy(x: 9.07, y: 12.32)
        switch glyph {
${cases.join('\n')}
        default: break
        }
    }
}
`;
fs.writeFileSync(
  'native/Apple/Packages/DeployKit/Sources/DeployUI/AgentGlyphs.generated.swift',
  output,
);
