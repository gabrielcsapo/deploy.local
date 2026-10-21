/** Browserless cascade regression support, not a layout/rendering engine.
 * Uses parsers already installed with Vite and the typography plugin. Selectors,
 * specificity, viewport conditions and source order come from the real CSS.
 * Geometry, fonts, UA rendering and container layout still need browser review.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const postcss = createRequire(require.resolve('vite/package.json'))('postcss');
const selectorParser = createRequire(require.resolve('@tailwindcss/typography'))(
  'postcss-selector-parser',
);
const rootPath = resolve(import.meta.dirname, '..');
export const phoneFile = 'app/routes/dashboard/phone-workspace.css';
export const legacyFiles = [
  'app/styles.css',
  'app/design-system.css',
  'app/routes/dashboard/workspace.css',
  'app/native-workspace.css',
  'app/routes/dashboard/workspace-rail.css',
  'app/routes/dashboard/repository-management.css',
  'app/routes/dashboard/repository-workbench.css',
  'app/components/ui/ui.css',
];

const compare = (left, right) => {
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};
const add = (left, right) => left.map((value, index) => value + right[index]);
function specificity(selector) {
  return selector.nodes.reduce(
    (total, part) => {
      if (part.type === 'id') return add(total, [1, 0, 0]);
      if (['class', 'attribute'].includes(part.type)) return add(total, [0, 1, 0]);
      if (part.type === 'tag') return add(total, [0, 0, 1]);
      if (part.type !== 'pseudo' || part.value === ':where') return total;
      if ([':is', ':not', ':has'].includes(part.value)) {
        const maximum = part.nodes.map(specificity).sort(compare).at(-1) || [0, 0, 0];
        return add(total, maximum);
      }
      return add(total, part.value.startsWith('::') ? [0, 0, 1] : [0, 1, 0]);
    },
    [0, 0, 0],
  );
}
function descendants(element) {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}
function matchesPart(part, element) {
  if (part.type === 'universal') return true;
  if (part.type === 'class') return element.classes.has(part.value);
  if (part.type === 'tag') return element.tag === part.value;
  if (part.type === 'id') return element.attrs.id === part.value;
  if (part.type === 'attribute') {
    if (!(part.attribute in element.attrs)) return false;
    return (
      !part.operator || (part.operator === '=' && element.attrs[part.attribute] === part.value)
    );
  }
  if (part.type !== 'pseudo') return false;
  if ([':is', ':where'].includes(part.value))
    return part.nodes.some((item) => matches(item, element));
  if (part.value === ':not') return !part.nodes.some((item) => matches(item, element));
  if (part.value === ':has')
    return descendants(element).some((child) => part.nodes.some((item) => matches(item, child)));
  if (part.value === ':root') return !element.parent;
  if (part.value === ':first-child') return element.parent?.children[0] === element;
  if (part.value === ':last-child') return element.parent?.children.at(-1) === element;
  if (part.value === ':empty') return !element.children.length;
  if (part.value === ':disabled') return 'disabled' in element.attrs;
  if (part.value === ':popover-open') return Boolean(element.attrs['data-open']);
  return false; // No hover, focus, active or pseudo-element in these layout fixtures.
}
function matches(selector, element) {
  const groups = [[]];
  const combinators = [];
  for (const part of selector.nodes) {
    if (part.type === 'combinator') {
      combinators.push(part.value.trim());
      groups.push([]);
    } else if (part.type !== 'comment') groups.at(-1).push(part);
  }
  function at(index, candidate) {
    if (!candidate || !groups[index].every((part) => matchesPart(part, candidate))) return false;
    if (!index) return true;
    const combinator = combinators[index - 1];
    if (combinator === '>') return at(index - 1, candidate.parent);
    if (combinator === '') {
      for (let parent = candidate.parent; parent; parent = parent.parent)
        if (at(index - 1, parent)) return true;
    }
    return false;
  }
  return at(groups.length - 1, element);
}
function condition(query, width) {
  return query.split(',').some((branch) => {
    if (/prefers-reduced-motion|forced-colors/.test(branch)) return false;
    if (/prefers-color-scheme/.test(branch)) return branch.includes('dark');
    if (/pointer/.test(branch)) return branch.includes('coarse') ? width < 640 : width >= 640;
    let found = false;
    for (const match of branch.matchAll(
      /(?:min|max)-width\s*:\s*(\d+)px|width\s*([<>]=?)\s*(\d+)px/g,
    )) {
      found = true;
      if (match[1]) {
        if (match[0].startsWith('min') ? width < Number(match[1]) : width > Number(match[1]))
          return false;
      } else {
        const limit = Number(match[3]);
        if (
          !(match[2] === '<'
            ? width < limit
            : match[2] === '<='
              ? width <= limit
              : match[2] === '>'
                ? width > limit
                : width >= limit)
        )
          return false;
      }
    }
    return found || !branch.includes('(');
  });
}
const cache = new Map();
function parse(file) {
  if (cache.has(file)) return cache.get(file);
  const rules = [];
  postcss.parse(readFileSync(resolve(rootPath, file), 'utf8')).walkRules((rule) => {
    const parents = [];
    for (let parent = rule.parent; parent; parent = parent.parent)
      if (parent.type === 'atrule') parents.push(parent);
    if (parents.some((parent) => parent.name.includes('keyframes'))) return;
    const selectors = selectorParser().astSync(rule.selector).nodes;
    rules.push({
      file,
      line: rule.source.start.line,
      selector: rule.selector,
      selectors: selectors.map((selector) => ({ selector, specificity: specificity(selector) })),
      conditions: parents.filter((parent) => ['media', 'container'].includes(parent.name)),
      layered: parents.some((parent) => parent.name === 'layer'),
      declarations: rule.nodes.filter((item) => item.type === 'decl'),
    });
  });
  cache.set(file, rules);
  return rules;
}
export function cascade(element, width, files) {
  const winners = new Map();
  let order = 0;
  for (const file of files)
    for (const rule of parse(file)) {
      // Container conditions use the fixture's work-pane width, equal to the viewport
      // after the single-column shell contract. This does not simulate containment.
      if (!rule.conditions.every((item) => condition(item.params, width))) continue;
      const matching = rule.selectors.filter((item) => matches(item.selector, element));
      if (!matching.length) continue;
      const specific = matching
        .map((item) => item.specificity)
        .sort(compare)
        .at(-1);
      for (const declaration of rule.declarations) {
        const weight = [
          Number(Boolean(declaration.important)),
          Number(!rule.layered),
          ...specific,
          order++,
        ];
        const previous = winners.get(declaration.prop);
        if (!previous || compare(weight, previous.weight) >= 0)
          winners.set(declaration.prop, {
            value: declaration.value.replace(/\s+/g, ' ').replace(/\s*\/\s*/g, ' / '),
            weight,
            rule,
          });
      }
    }
  return winners;
}
export function values(element, width, files = [...legacyFiles, phoneFile]) {
  return Object.fromEntries(
    [...cascade(element, width, files)].map(([key, item]) => [key, item.value]),
  );
}
export function node(classes, parent, tag = 'div', attrs = {}) {
  const element = {
    classes: new Set(classes.split(/\s+/).filter(Boolean)),
    parent,
    tag,
    attrs,
    children: [],
  };
  parent?.children.push(element);
  return element;
}
export function fixture(state = '', phone = true) {
  const root = node(`project-workspace ${state}`, null, 'div', phone ? { 'data-phone': '' } : {});
  const child = (classes, tag = 'div', attrs = {}) => node(classes, root, tag, attrs);
  const items = { root };
  items.rail = child('workspace-rail', 'nav');
  items.tabs = child('workspace-tabs phone-only', 'nav');
  items.tab = node('', items.tabs, 'a');
  items.tabLabel = node('', items.tab, 'span');
  items.account = child('wr-account-popover', 'div', { popover: 'auto' });
  if (!state.includes('has-application')) items.top = child('compact-top-bar phone-only', 'header');
  if (state.includes('is-task-flow') && !state.includes('is-composing'))
    items.segments = child('phone-task-segments phone-only', 'nav');
  items.resizer = child('ds-sidebar-resizer');
  if (state.includes('show-sidebar')) items.scrim = child('pw-sidebar-scrim', 'button');
  items.projects = child('pw-sidebar task-navigation', 'aside');
  if (state.includes('has-surface')) {
    items.sections = child('pw-sidebar ds-context-sidebar', 'aside');
    items.sectionLinks = node('ds-context-links', items.sections, 'nav');
    items.sectionLink = node('', items.sectionLinks, 'a');
    items.surface = child('pw-surface', 'section');
    items.content = node('pw-surface-content', items.surface);
    items.frame = node('dashboard-frame-root', items.content);
    items.notice = node('notice-row phone-only', items.frame, 'details');
    items.desktopNotice = node('desktop-notice', items.frame);
    items.shell = node('dashboard-shell', items.frame);
    items.canvas = node('dashboard-canvas', items.shell, 'main');
    items.viewport = node('dashboard-viewport', items.canvas);
    items.location = node('dashboard-location-bar', items.viewport);
    if (state.includes('has-application')) {
      items.application = node('graph-application-frame', items.viewport, 'section');
      items.top = node('compact-top-bar phone-only', items.application, 'header');
      items.chips = node('phone-section-chips phone-only', items.application, 'nav');
      items.deployment = node('ds-deployment-workbench', items.application);
    }
    items.resource = node('resource-row', items.viewport, 'a');
  }
  if (state.includes('has-task-tree')) items.tasks = items.projects;
  items.chat = child('pw-chat', 'section');
  items.transcript = node('pw-transcript', items.chat);
  items.compose = node('pw-compose-area', items.chat);
  items.composer = node('pw-composer', items.compose);
  items.textarea = node('', items.composer, 'textarea');
  items.toolbar = node('pw-composer-toolbar', items.composer);
  items.picker = node('pw-context-picker', items.toolbar);
  items.model = node('pw-composer-options', items.toolbar);
  items.send = node('pw-send', items.composer, 'button');
  items.review = child('pw-context ds-work-pane', 'aside');
  if (state.includes('is-task-flow') && !state.includes('is-composing'))
    items.control = child('pw-control-panel pw-control-viewer pw-floating-viewer', 'section');
  if (state.includes('has-repository')) {
    items.repository = child('pw-project-hub repository-workspace', 'section');
    items.repoNav = node('ph-navigation ds-context-sidebar', items.repository, 'aside');
    items.repoWork = node('ph-work ds-work-pane', items.repository, 'section');
  }
  items.dialog = child('pw-project-dialog', 'dialog');
  items.title = node('compact-title', items.top || items.chat, 'strong');
  return items;
}

/** All authored grid/flex/display candidates for the root and direct children,
 * plus their final values. The evidence report also names UA/inline overlays.
 */
export function layoutInventory() {
  const properties =
    /^(?:display|grid(?:-.*)?|flex(?:-.*)?|align-(?:items|self|content)|justify-(?:items|self|content)|gap|order)$/;
  const states = [
    'has-surface',
    'has-surface has-application',
    'has-task-tree',
    'is-task-flow is-composing',
    'is-task-flow',
    'is-task-flow has-inspector',
    'has-repository',
    'is-task-flow is-composing show-sidebar',
  ];
  const files = [...legacyFiles, phoneFile];
  const records = new Map();
  for (const width of [375, 390, 430, 639])
    for (const state of states) {
      const f = fixture(state);
      for (const element of [f.root, ...f.root.children]) {
        const final = values(element, width, files);
        for (const file of files)
          for (const rule of parse(file)) {
            if (!rule.conditions.every((item) => condition(item.params, width))) continue;
            const selectors = rule.selectors.filter((item) => matches(item.selector, element));
            if (!selectors.length) continue;
            const declarations = rule.declarations.filter((item) => properties.test(item.prop));
            if (!declarations.length) continue;
            const key = `${file}:${rule.line}`;
            if (!records.has(key))
              records.set(key, { rule, selectors: new Set(), finals: new Map(), declarations });
            const record = records.get(key);
            selectors.forEach((item) =>
              record.selectors.add(item.selector.toString().trim().replace(/\s+/g, ' ')),
            );
            for (const item of declarations) {
              if (!record.finals.has(item.prop)) record.finals.set(item.prop, new Set());
              record.finals.get(item.prop).add(final[item.prop] || 'initial');
            }
          }
      }
    }
  const code = (value) => `\`${value}\``;
  return [...records.values()]
    .sort(
      (a, b) =>
        files.indexOf(a.rule.file) - files.indexOf(b.rule.file) || a.rule.line - b.rule.line,
    )
    .map(
      (
        record,
      ) => `- ${code(record.rule.file + ':' + record.rule.line)} — ${[...record.selectors].map(code).join(', ')}.
  Declares ${record.declarations.map((item) => code(item.prop + ': ' + item.value)).join('; ')}.
  Final: ${[...record.finals].map(([property, result]) => code(property + ': ' + [...result].sort().join(' or '))).join('; ')}.`,
    )
    .join('\n\n');
}

if (process.argv.includes('--inventory')) process.stdout.write(layoutInventory() + '\n');
