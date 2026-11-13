#!/usr/bin/env node
// The boards (design/ds/deploy-local/components/bundle.css) and the web app
// (app/components/ui/v2/components.css and the sheets beside it) each define the dl-* classes. Neither is generated from the
// other: bundle.css came from the claude.ai canvas (scripts/design-import.mjs) and components.css
// was ported from it by hand onto the app's --ds-* tokens. This check resolves both sides' tokens
// (light and dark) and compares every declaration of every selector they share, and which dl-*
// classes exist on only one side. Today's differences are recorded in scripts/dl-style-drift.json;
// any new one fails `pnpm lint`. Settling a recorded conflict changes what a board or a page shows,
// so it is the owner's call: make the two sides agree, then run with --write to shrink the record.
//
//   node scripts/check-dl-styles.mjs           check
//   node scripts/check-dl-styles.mjs --write   rewrite the record from the current files
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const rootFlag = process.argv.indexOf('--root');
const root =
  rootFlag > 0 ? resolve(process.argv[rootFlag + 1]) : resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const recordFile = join(root, 'scripts/dl-style-drift.json');

const sides = {
  board: {
    css: [
      'design/ds/deploy-local/components/bundle.css',
      'design/ds/deploy-local/components/waterfall.css',
    ],
    tokens: 'design/ds/deploy-local/tokens.css',
    light: (selector) =>
      selector.includes(':root') || /\[data-theme=["']light["']\]/.test(selector),
    dark: (selector) => /\[data-theme=["']dark["']\]/.test(selector),
  },
  app: {
    // components.css imports waterfall.css; the other sheets are imported by their components.
    css: [
      'app/components/ui/v2/components.css',
      'app/components/ui/v2/waterfall.css',
      'app/components/ui/v2/design-compare.css',
      'app/components/ui/v2/agent-avatar.css',
      'app/components/ui/v2/chip-select.css',
    ],
    tokens: 'app/design-tokens.css',
    light: (selector) => selector === ':root',
    dark: (selector) => /\[data-ds-theme=["']dark["']\]/.test(selector),
  },
};

/** `{ selector, body }` for every rule, with the at-rules around it as `context`. */
function blocks(css, context = '') {
  const result = [];
  let position = 0;
  while (position < css.length) {
    const open = css.indexOf('{', position);
    if (open < 0) break;
    let depth = 1;
    let end = open + 1;
    while (depth && end < css.length) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
      end++;
    }
    const head = css
      .slice(position, open)
      .replace(/^[\s\S]*;/, '')
      .trim()
      .replace(/\s+/g, ' ');
    const body = css.slice(open + 1, end - 1);
    if (/^@(media|supports|container|layer)/.test(head))
      result.push(...blocks(body, `${context}${head} `));
    else if (!head.startsWith('@')) result.push({ context, selector: head, body });
    position = end;
  }
  return result;
}

function declarations(body) {
  const result = new Map();
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim();
    if (property) result.set(property, part.slice(colon + 1).trim());
  }
  return result;
}

function tokens(side, theme) {
  const values = {};
  for (const { context, selector, body } of blocks(read(side.tokens))) {
    if (context) continue;
    if (!(side.light(selector) || (theme === 'dark' && side.dark(selector)))) continue;
    if (theme === 'light' && side.dark(selector)) continue;
    for (const [name, value] of declarations(body)) if (name.startsWith('--')) values[name] = value;
  }
  if (theme === 'dark')
    for (const { context, selector, body } of blocks(read(side.tokens)))
      if (!context && side.dark(selector))
        for (const [name, value] of declarations(body))
          if (name.startsWith('--')) values[name] = value;
  return values;
}

function resolveValue(value, values, depth = 0) {
  if (depth > 12) return value;
  const next = value.replace(
    /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g,
    (all, name, fallback) => (name in values ? values[name] : (fallback?.trim() ?? all)),
  );
  return next === value ? value : resolveValue(next, values, depth + 1);
}

const normalize = (value) =>
  value
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .replace(/\s*([,()/])\s*/g, '$1')
    .replace(/(^|[^\d])0\./g, '$1.')
    .replace(/\s*!important/, ' !important')
    .trim()
    .toLowerCase();

/** `context + selector` → property → value, resolved in one theme. */
function rules(side, theme) {
  const values = tokens(side, theme);
  const result = new Map();
  for (const { context, selector, body } of blocks(side.css.map(read).join('\n'))) {
    for (const one of selector.split(/,(?![^(]*\))/).map((part) => part.trim())) {
      if (!one) continue;
      const key = `${context}${one}`;
      const map = result.get(key) ?? new Map();
      for (const [property, value] of declarations(body))
        if (!property.startsWith('--')) map.set(property, normalize(resolveValue(value, values)));
      result.set(key, map);
    }
  }
  return result;
}

const classes = (map) =>
  new Set([...map.keys()].flatMap((key) => [...key.matchAll(/\.(dl-[\w-]+)/g)].map((m) => m[1])));

const current = { conflicts: [], boardOnlyProperties: [], appOnlyProperties: [] };
for (const theme of ['light', 'dark']) {
  const board = rules(sides.board, theme);
  const app = rules(sides.app, theme);
  for (const [selector, boardValues] of board) {
    const appValues = app.get(selector);
    if (!appValues) continue;
    for (const [property, value] of boardValues) {
      if (!appValues.has(property)) {
        if (theme === 'light') current.boardOnlyProperties.push(`${selector} { ${property} }`);
      } else if (appValues.get(property) !== value)
        current.conflicts.push({
          theme,
          selector,
          property,
          board: value,
          app: appValues.get(property),
        });
    }
    if (theme === 'light')
      for (const property of appValues.keys())
        if (!boardValues.has(property))
          current.appOnlyProperties.push(`${selector} { ${property} }`);
  }
  if (theme === 'light') {
    const boardClasses = classes(board);
    const appClasses = classes(app);
    current.boardOnlyClasses = [...boardClasses].filter((name) => !appClasses.has(name)).sort();
    current.appOnlyClasses = [...appClasses].filter((name) => !boardClasses.has(name)).sort();
  }
}
// A conflict that is the same in both themes is listed once.
const seen = new Set();
current.conflicts = current.conflicts.filter((conflict) => {
  const key = `${conflict.selector}|${conflict.property}|${conflict.board}|${conflict.app}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

const order = [
  'conflicts',
  'boardOnlyProperties',
  'appOnlyProperties',
  'boardOnlyClasses',
  'appOnlyClasses',
];
const record = Object.fromEntries(order.map((key) => [key, current[key]]));
if (process.argv.includes('--write')) {
  writeFileSync(recordFile, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Recorded ${order.map((key) => `${record[key].length} ${key}`).join(', ')}.`);
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(recordFile, 'utf8'));
const asKeys = (list) => list.map((entry) => JSON.stringify(entry));
const problems = [];
for (const key of order) {
  const was = new Set(asKeys(recorded[key] ?? []));
  const now = new Set(asKeys(record[key]));
  for (const entry of now) if (!was.has(entry)) problems.push(`new ${key}: ${entry}`);
  for (const entry of was)
    if (!now.has(entry)) problems.push(`no longer in ${key} (run --write to record it): ${entry}`);
}
if (problems.length) {
  console.error('The dl-* styles of the boards and the web app have drifted:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    'Change design/ds/deploy-local/components/bundle.css and app/components/ui/v2/components.css together.',
  );
  process.exit(1);
}
console.log(`dl-* styles: ${record.conflicts.length} recorded conflicts, nothing new.`);
