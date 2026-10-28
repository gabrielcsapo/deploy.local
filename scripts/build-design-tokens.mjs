import { readFileSync, writeFileSync } from 'node:fs';
import { format } from 'oxfmt';
const root = new URL('../', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('app/design-tokens.json', root), 'utf8'));
const aliases = { text: 'ink', tertiary: 'muted', accent: 'accent', actionHover: 'accent-hover' };
let css =
  '/* Generated from app/design-tokens.json by scripts/build-design-tokens.mjs. */\n:root {\n';
css += `  --ds-font: ${spec.fontFamily};\n  --ds-font-mono: ${spec.fontMono};\n`;
for (const group of ['space', 'type', 'size', 'form', 'radius'])
  for (const [name, value] of Object.entries(spec[group]))
    css += `  --ds-${group}-${name}: ${value}px;\n`;
for (const [group, values] of Object.entries(spec.motion))
  for (const [name, value] of Object.entries(values)) {
    const unit = group === 'duration' ? 'ms' : group === 'distance' ? 'px' : '';
    css += `  --ds-motion-${group}-${name}: ${value}${unit};\n`;
  }
css += '}\n';
for (const theme of ['light', 'dark']) {
  const values = Object.entries(spec.color[theme])
    .flatMap(([key, value]) => [
      `  --ds-${key}: ${value};`,
      ...(aliases[key] && aliases[key] !== key ? [`  --ds-${aliases[key]}: ${value};`] : []),
    ])
    .join('\n');
  const shadows = Object.entries(spec.shadow[theme])
    .map(([key, value]) => `  --ds-shadow-${key}: ${value};`)
    .join('\n');
  const metrics = Object.entries(spec.metricSignals)
    .map(
      ([key, signal]) => `  --metric-${key}: var(--ds-${aliases[signal.token] || signal.token});`,
    )
    .join('\n');
  if (theme === 'dark') css += '@media (prefers-color-scheme: dark) {\n';
  css += `:root {\n${values}\n${shadows}\n${metrics}\n  --metric-other: var(--metric-neutral);\n}\n`;
  if (theme === 'dark') css += '}\n';
  css += `[data-ds-theme="${theme}"] {\n  color-scheme: ${theme};\n${values}\n${shadows}\n${metrics}\n}\n`;
}
const result = await format(
  'app/design-tokens.css',
  css,
  JSON.parse(readFileSync(new URL('.oxfmtrc.json', root), 'utf8')),
);
if (result.errors.length) throw new Error('Could not format generated design tokens');
writeFileSync(new URL('app/design-tokens.css', root), result.code);

// Keep the existing native layout helpers; regenerate the shared token mirror between markers.
const swiftURL = new URL(
  'native/Apple/Packages/DeployKit/Sources/DeployUI/WorkspaceStyle.swift',
  root,
);
let swift = readFileSync(swiftURL, 'utf8');
const start = '    // BEGIN GENERATED TOKENS';
const end = '    // END GENERATED TOKENS';
let mirror = `${start}\n`;
for (const key of Object.keys(spec.color.light)) {
  const hex = (theme) => '0x' + spec.color[theme][key].slice(1).toLowerCase();
  mirror += `    static func ${key}(_ scheme: ColorScheme) -> Color { color(scheme == .dark ? ${hex('dark')} : ${hex('light')}) }\n`;
}
mirror += '    static func secondaryText(_ scheme: ColorScheme) -> Color { secondary(scheme) }\n';
mirror += '    static func userMessage(_ scheme: ColorScheme) -> Color { selected(scheme) }\n';
for (const group of ['space', 'type', 'size', 'form', 'radius']) {
  mirror += `    enum ${group === 'type' ? 'Typography' : group[0].toUpperCase() + group.slice(1)} {\n`;
  for (const [name, value] of Object.entries(spec[group])) {
    const identifier = name
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      .replace(/^(?=[0-9])/, 'step');
    mirror += `        static let \`${identifier}\`: CGFloat = ${value}\n`;
  }
  mirror += '    }\n';
}
mirror += end;
if (swift.includes(start)) {
  swift =
    swift.slice(0, swift.indexOf(start)) + mirror + swift.slice(swift.indexOf(end) + end.length);
} else {
  swift = swift.replace(/    static func canvas[\s\S]*?(?=\n    \/\/\/ Motion)/, mirror + '\n');
}
writeFileSync(
  swiftURL,
  swift.replace(
    'quiet surfaces, violet actions and semantic status.',
    'v2 surfaces, neutral actions and semantic status.',
  ),
);
