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
