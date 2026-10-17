import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icons = JSON.parse(fs.readFileSync(path.join(root, 'app/workspace-icons.json'), 'utf8'));
const number = (n) => Number(n.toFixed(6)).toString();
const point = (x, y) => `CGPoint(x: ${number(x)}, y: ${number(y)})`;
const swiftName = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

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
    startY = 0;
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
    switch (command.toUpperCase()) {
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
      case 'Z':
        lines.push('p.closeSubpath()');
        x = startX;
        y = startY;
        command = undefined;
        break;
      default:
        throw new Error(`Unsupported SVG command ${command}`);
    }
  }
  return lines;
}

const cases = Object.entries(icons.glyphs).map(([name, shapes]) => {
  const layers = shapes.map((shape) => {
    let drawing;
    if (shape.tag === 'path') drawing = svgPath(shape.d);
    else if (shape.tag === 'circle')
      drawing = [
        `p.addEllipse(in: CGRect(x: ${number(+shape.cx - +shape.r)}, y: ${number(+shape.cy - +shape.r)}, width: ${number(+shape.r * 2)}, height: ${number(+shape.r * 2)}))`,
      ];
    else if (shape.tag === 'rect')
      drawing = [
        `p.addRoundedRect(in: CGRect(x: ${shape.x}, y: ${shape.y}, width: ${shape.width}, height: ${shape.height}), cornerSize: CGSize(width: ${shape.rx ?? 0}, height: ${shape.rx ?? 0}))`,
      ];
    else throw new Error(`Unsupported shape ${shape.tag}`);
    const commands = ['var p = Path()', ...drawing];
    if (shape.fill && shape.fill !== 'none')
      commands.push(
        `context.fill(p, with: ${shape.fill === 'currentColor' ? '.foreground' : '.color(WorkspaceStyle.rail(scheme))'})`,
      );
    if (shape.stroke !== 'none')
      commands.push(
        `context.stroke(p, with: .foreground, style: StrokeStyle(lineWidth: ${icons.strokeWidth}, lineCap: .round, lineJoin: .round))`,
      );
    return `            do {\n${commands.map((line) => `                ${line}`).join('\n')}\n            }`;
  });
  return `        case .${swiftName(name)}:\n${layers.join('\n')}`;
});
const source = `// Generated by scripts/build-workspace-icons.mjs from app/workspace-icons.json. Do not edit.\nimport SwiftUI\n\nenum WorkspaceGlyphName: String, CaseIterable {\n${Object.keys(
  icons.glyphs,
)
  .map((name) => `    case ${swiftName(name)} = "${name}"`)
  .join(
    '\n',
  )}\n}\n\nstruct WorkspaceGlyph: View {\n    let name: WorkspaceGlyphName\n    var size: CGFloat = 18\n    @Environment(\\.colorScheme) private var scheme\n    var body: some View {\n        Canvas { context, size in\n            context.scaleBy(x: size.width / ${icons.viewBox}, y: size.height / ${icons.viewBox})\n            draw(in: &context)\n        }.frame(width: size, height: size).accessibilityHidden(true)\n    }\n    private func draw(in context: inout GraphicsContext) {\n        switch name {\n${cases.join('\n')}\n        }\n    }\n}\n`;
const destination = path.join(
  root,
  'native/Apple/Packages/DeployKit/Sources/DeployUI/WorkspaceGlyph.generated.swift',
);
if (process.argv.includes('--check')) {
  if (fs.readFileSync(destination, 'utf8') !== source)
    throw new Error('Native workspace icons are stale. Run node scripts/build-workspace-icons.mjs');
} else fs.writeFileSync(destination, source);
console.log(
  `${Object.keys(icons.glyphs).length} workspace icons ${process.argv.includes('--check') ? 'verified' : 'generated'}`,
);
