// Shared parsing for the dl-* stylesheets: the design system source (design/ds/deploy-local) and
// the web app's sheets in app/components/ui/v2. Used by build-dl-styles.mjs and check-dl-styles.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SOURCE_SHEETS = [
  'design/ds/deploy-local/components/bundle.css',
  'design/ds/deploy-local/components/waterfall.css',
];
export const GENERATED = 'app/components/ui/v2/dl-components.css';
/** The app's own sheets: rules the design system doesn't have (window chrome, controls' states). */
export const APP_SHEETS = [
  'app/components/ui/v2/components.css',
  'app/components/ui/v2/waterfall.css',
  'app/components/ui/v2/design-compare.css',
  'app/components/ui/v2/agent-avatar.css',
  'app/components/ui/v2/chip-select.css',
];

/**
 * The design system's tokens as the app names them. Light and dark resolve to the same values on
 * both sides (scripts/check-dl-styles.mjs checks this), so the app keeps its --ds-* names.
 */
export const TOKEN_MAP = {
  '--paper': '--ds-canvas',
  '--sidebar': '--ds-sidebar',
  '--surface': '--ds-surface',
  '--ink': '--ds-ink',
  '--ink-soft': '--ds-secondary',
  '--muted': '--ds-muted',
  '--line': '--ds-line',
  '--line-strong': '--ds-edge',
  '--selection': '--ds-selected',
  '--action': '--ds-action',
  '--on-action': '--ds-onAction',
  '--focus': '--ds-focus',
  '--accent': '--ds-accent',
  '--accent-soft': '--ds-accentSoft',
  '--success': '--ds-success',
  '--warning': '--ds-warning',
  '--danger': '--ds-danger',
  '--active': '--ds-active',
  '--shadow-sm': '--ds-shadow-sm',
  '--shadow-lg': '--ds-shadow-lg',
  '--shadow-xl': '--ds-shadow-xl',
  '--font-sans': '--ds-font',
  '--font-mono': '--ds-font-mono',
  '--space-1': '--ds-space-1',
  '--space-2': '--ds-space-2',
  '--space-3': '--ds-space-3',
  '--space-4': '--ds-space-4',
  '--space-6': '--ds-space-6',
  '--space-8': '--ds-space-8',
  '--space-12': '--ds-space-12',
  '--radius-control': '--ds-radius-control',
  '--radius-card': '--ds-radius-card',
  '--radius-dialog': '--ds-radius-dialog',
  '--radius-composer': '--ds-radius-composer',
  '--radius-full': '--ds-radius-full',
  '--size-sidebar': '--ds-size-sidebar',
  '--size-header': '--ds-size-header',
  '--size-row': '--ds-size-compactControl',
  '--size-touch': '--ds-size-touchControl',
  '--size-reading': '--ds-size-readingWidth',
  '--size-page': '--ds-size-page',
  '--size-panel': '--ds-size-panel',
  '--size-icon': '--ds-size-iconGlyphDefault',
};

/**
 * The design system writes pure black and white as literals (the media viewer stays dark in both
 * themes); the app reads them from tokens that are black and white in both themes.
 */
export const COLOR_MAP = {
  '#000': '--ds-shadow',
  '#000000': '--ds-shadow',
  '#fff': '--ds-highlight',
  '#ffffff': '--ds-highlight',
};

/** The design system writes type sizes in pixels; the app reads them from its type tokens. */
export const TYPE_MAP = {
  11: '--ds-type-caption',
  12: '--ds-type-meta',
  13: '--ds-type-ui',
  15: '--ds-type-body',
  16: '--ds-type-reply',
  17: '--ds-type-phoneBody',
  22: '--ds-type-title',
};

/**
 * The dl-* classes the web app implements, and the state classes they combine with (`.on`,
 * `.primary`). The app takes every rule of the design system whose selector uses only these.
 * Board-only classes (phone screens, review boards, care boards) are left out until the app
 * builds them, so they can't restyle markup the app styles elsewhere.
 */
const appClasses = JSON.parse(
  readFileSync(new URL('./dl-app-classes.json', import.meta.url), 'utf8'),
);
export const APP_CLASSES = new Set([...appClasses.classes, ...appClasses.modifiers]);

export const read = (root, path) =>
  readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as `{ context, selectors, body }`, with @media/@supports around it as `context`. */
export function rules(css, context = '') {
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
      result.push(...rules(body, context ? `${context} ${head}` : head));
    else if (head.startsWith('@keyframes')) result.push({ context, keyframes: head, body });
    else if (!head.startsWith('@')) result.push({ context, selectors: splitSelectors(head), body });
    position = end;
  }
  return result;
}

export function splitSelectors(list) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function declarations(body) {
  const result = [];
  for (const part of body.split(/;(?![^(]*\))/)) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const property = part.slice(0, colon).trim();
    const value = part.slice(colon + 1).trim();
    if (property && value) result.push([property, value]);
  }
  return result;
}

/** One spelling per selector: `.a>.b` and `.a > .b` are the same. */
export const normalizeSelector = (selector) =>
  selector
    .replace(/\s*([>+~])\s*/g, ' $1 ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/'/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Source selectors held back from the app for the owner to decide, with the reason in
 * scripts/dl-style-drift.json ("held").
 */
export const HELD = new Set(
  JSON.parse(readFileSync(new URL('./dl-style-drift.json', import.meta.url), 'utf8')).held.map(
    (entry) => normalizeSelector(entry.selector),
  ),
);

/** Whether a source selector belongs in the app: dl-* classes the app implements, and no others. */
export function appSelector(selector) {
  if (HELD.has(normalizeSelector(selector))) return false;
  const classes = [...selector.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]);
  return (
    classes.some((name) => name.startsWith('dl-')) && classes.every((name) => APP_CLASSES.has(name))
  );
}
