#!/usr/bin/env node
// The web app's dl-* styles come from the design system (design/ds/deploy-local). This check,
// run by `pnpm lint`, fails when:
//   - app/components/ui/v2/dl-components.css is out of date with the source;
//   - a design-system token and the app token it maps to resolve differently, light or dark;
//   - one of the app's own sheets sets a property the design system sets on the same selector,
//     unless scripts/dl-style-drift.json lists it as an exception with its reason.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from './build-dl-styles.mjs';
import {
  APP_SHEETS,
  GENERATED,
  TOKEN_MAP,
  TYPE_MAP,
  declarations,
  normalizeSelector,
  read,
  rules,
} from './dl-styles.mjs';

const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag > 0 ? resolve(process.argv[rootFlag + 1]) : resolve(import.meta.dirname, '..');
const record = JSON.parse(readFileSync(join(root, 'scripts/dl-style-drift.json'), 'utf8'));
const problems = [];

// 1. The generated sheets match the source.
for (const [path, contents] of Object.entries(await build(root))) {
  let current = '';
  try {
    current = readFileSync(join(root, path), 'utf8');
  } catch {
    // Missing is stale.
  }
  if (current !== contents)
    problems.push(`${path} is out of date: run node scripts/build-dl-styles.mjs`);
}

// 2. Every mapped token means the same in both themes.
function tokens(path, light, dark) {
  const css = read(root, path).replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, '');
  const values = { light: {}, dark: {} };
  for (const rule of rules(css)) {
    if (!rule.selectors) continue;
    const selector = rule.selectors.join(',');
    const target = light(selector) ? 'light' : dark(selector) ? 'dark' : null;
    if (!target) continue;
    for (const [name, value] of declarations(rule.body)) values[target][name] = value;
  }
  values.dark = { ...values.light, ...values.dark };
  return values;
}
const resolveToken = (value, values, depth = 0) =>
  depth > 10
    ? value
    : value.replace(/var\((--[\w-]+)\)/g, (all, name) =>
        name in values ? resolveToken(values[name], values, depth + 1) : all,
      );
const normalize = (value) => value.replace(/\s+/g, '').replace(/'/g, '"').toLowerCase();
const board = tokens(
  'design/ds/deploy-local/tokens.css',
  (selector) => selector.includes(':root'),
  (selector) => /\[data-theme=["']dark["']\]/.test(selector),
);
const app = tokens(
  'app/design-tokens.css',
  (selector) => selector === ':root',
  (selector) => /\[data-ds-theme=["']dark["']\]/.test(selector),
);
for (const [name, appName] of Object.entries(TOKEN_MAP))
  for (const theme of ['light', 'dark']) {
    const want = board[theme][name];
    const have = app[theme][appName];
    if (want === undefined || have === undefined)
      problems.push(
        `${name} → ${appName}: missing in ${want === undefined ? 'the design system' : 'the app'} (${theme})`,
      );
    else if (
      normalize(resolveToken(want, board[theme])) !== normalize(resolveToken(have, app[theme]))
    )
      problems.push(`${name} → ${appName} differ in ${theme}: ${want} / ${have}`);
  }

for (const [size, token] of Object.entries(TYPE_MAP))
  if (normalize(app.light[token] ?? '') !== `${size}px`)
    problems.push(`${token} is ${app.light[token]}, but the generator maps ${size}px to it`);

// 3. The app's own sheets don't restate or change what the design system sets.
const context = (value) =>
  value
    .replace(/\s+/g, ' ')
    .replace(/\(\s*/g, '(')
    .replace(/\s*:\s*/g, ':')
    .replace(/\s*\)/g, ')');
const fromSource = new Set();
for (const rule of rules(read(root, GENERATED)))
  if (rule.selectors)
    for (const selector of rule.selectors)
      for (const [property] of declarations(rule.body))
        fromSource.add(`${context(rule.context)}|${normalizeSelector(selector)}|${property}`);
const allowed = new Set(
  record.exceptions.map(
    (entry) =>
      `${context(entry.context ?? '')}|${normalizeSelector(entry.selector)}|${entry.property}`,
  ),
);
const used = new Set();
for (const sheet of APP_SHEETS)
  for (const rule of rules(read(root, sheet)))
    if (rule.selectors)
      for (const selector of rule.selectors)
        for (const [property] of declarations(rule.body)) {
          const key = `${context(rule.context)}|${normalizeSelector(selector)}|${property}`;
          if (!fromSource.has(key)) continue;
          if (allowed.has(key)) used.add(key);
          else
            problems.push(
              `${sheet} sets ${property} on ${selector}${rule.context ? ` (${rule.context})` : ''}, which comes from the design system: change design/ds/deploy-local instead`,
            );
        }
for (const key of allowed)
  if (!used.has(key))
    problems.push(`scripts/dl-style-drift.json lists ${key}, which no longer applies`);

if (problems.length) {
  console.error('The dl-* styles are out of step with the design system:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(
  `dl-* styles come from the design system (${record.exceptions.length} explained exceptions).`,
);
