import { readFileSync, writeFileSync } from 'node:fs';
import { format } from 'oxfmt';
const root = new URL('../', import.meta.url);
const spec = JSON.parse(readFileSync(new URL('app/design-tokens.json', root), 'utf8'));
const aliases = { text: 'ink', tertiary: 'muted', accent: 'accent', actionHover: 'accent-hover' };
let css =
  '/* Generated from app/design-tokens.json by scripts/build-design-tokens.mjs. */\n:root {\n';
css += `  --ds-font: ${spec.fontFamily};\n  --ds-font-mono: ${spec.fontMono};\n`;
for (const group of ['space', 'type', 'size', 'form'])
  for (const [name, value] of Object.entries(spec[group]))
    css += `  --ds-${group}-${name}: ${value}px;\n`;
css += '}\n';
for (const theme of ['light', 'dark']) {
  const values = Object.entries(spec.color[theme])
    .map(([key, value]) => `  --ds-${aliases[key] || key}: ${value};`)
    .join('\n');
  const metrics = Object.entries(spec.metricSignals)
    .map(
      ([key, signal]) => `  --metric-${key}: var(--ds-${aliases[signal.token] || signal.token});`,
    )
    .join('\n');
  if (theme === 'dark') css += '@media (prefers-color-scheme: dark) {\n';
  css += `:root {\n${values}\n${metrics}\n  --metric-other: var(--metric-neutral);\n}\n`;
  if (theme === 'dark') css += '}\n';
}
const result = await format('app/design-tokens.css', css);
if (result.errors.length) throw new Error('Could not format generated design tokens');
writeFileSync(new URL('app/design-tokens.css', root), result.code);
