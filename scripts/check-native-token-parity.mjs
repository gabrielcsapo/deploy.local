import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const spec = JSON.parse(read('app/design-tokens.json'));
const parity = JSON.parse(read('docs/evidence/native-polish/token-parity.json'));
const native = read(parity.nativeSource);
for (const name of parity.matchedNativeTokens) {
  const token = parity.aliases[name] || name;
  const match = native.match(
    new RegExp(
      `static func ${name}\\(_ scheme: ColorScheme\\) -> Color \\{ color\\(scheme == \\.dark \\? 0x([a-f0-9]{6}) : 0x([a-f0-9]{6})\\) \\}`,
    ),
  );
  if (
    !match ||
    match[1] !== spec.color.dark[token].slice(1).toLowerCase() ||
    match[2] !== spec.color.light[token].slice(1).toLowerCase()
  ) {
    throw new Error(`Native token ${name} differs from ${parity.source}: ${token}`);
  }
}
console.log(
  `Native palette parity: ${parity.matchedNativeTokens.length} tokens in both appearances.`,
);

const iconSizes = {
  compact: 'iconActionCompact',
  standard: 'iconActionDefault',
  touch: 'iconActionTouch',
  compactGlyph: 'iconGlyphCompact',
  standardGlyph: 'iconGlyphDefault',
  touchGlyph: 'iconGlyphTouch',
  gap: 'actionClusterGap',
};
const actionTokens = native.split('enum IconAction {')[1]?.split('}')[0] ?? '';
for (const [name, token] of Object.entries(iconSizes)) {
  const match = actionTokens.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`));
  if (!match || Number(match[1]) !== spec.size[token])
    throw new Error(`Native icon action ${name} differs from size.${token}`);
}
console.log('Native icon action parity: targets, glyphs and cluster spacing.');

const controlTokens = {
  compact: spec.size.compactControl,
  standard: spec.size.desktopControl,
  touch: spec.size.touchControl,
  radius: spec.form.radius,
};
const controls = native.split('enum Control {')[1]?.split('}')[0] ?? '';
for (const [name, value] of Object.entries(controlTokens)) {
  const match = controls.match(new RegExp(`static let ${name}: CGFloat = (\\d+)`));
  if (!match || Number(match[1]) !== value)
    throw new Error(`Native control ${name} differs from the shared control scale (${value})`);
}
const nativeControls = read(
  'native/Apple/Packages/DeployKit/Sources/DeployUI/WorkspaceControls.swift',
);
if (
  !/static var buttonHeight:[\s\S]*?Control.standard/.test(nativeControls) ||
  !/static var controlTargetHeight:[\s\S]*?Control.touch/.test(nativeControls)
)
  throw new Error('Native controls must separate painted height from touch target');
console.log('Native control parity: 36 pt iOS drawing, 44 pt iOS target, shared radius.');

const overlayOpacity = native.match(/static let overlayOpacity = ([\d.]+)/);
if (!overlayOpacity || Number(overlayOpacity[1]) !== spec.opacity.overlay)
  throw new Error('Native media backdrop differs from opacity.overlay');
console.log('Native media backdrop opacity parity.');
