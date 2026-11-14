/** The canvas a project's design/canvas.json describes, and what the Design page derives from it. */
import {
  layerLabel,
  type Board,
  type Canvas,
  type LayerChange,
} from '../../../../../shared/v2/design';

export {
  boardName,
  describeChange,
  isMark,
  layerLabel,
  markColors,
  markName,
  sectionAt,
  sections,
  type Board,
  type Canvas,
  type DesignLink,
  type LayerChange,
  type Mark,
  type Note,
  type Section,
} from '../../../../../shared/v2/design';

/**
 * Where a design lives: the project's App design in design/, or a design made under Artifacts in
 * artifacts/<name>. Its API is /api/projects/<id>/design or …/artifacts/<name>/design.
 */
export function designApi(projectId: string, artifact?: string | null) {
  return `/api/projects/${encodeURIComponent(projectId)}${artifact ? `/artifacts/${encodeURIComponent(artifact)}` : ''}/design`;
}
export const designFolderOf = (artifact?: string | null) =>
  artifact ? `artifacts/${artifact}` : 'design';
/** The artifact a design API path names; null for the App design. */
export function apiArtifact(api: string | null | undefined) {
  return api ? (/\/artifacts\/([^/]+)\/design$/.exec(api)?.[1] ?? null) : null;
}
/** The board file a changed path names, in any design's folder; null for anything else. */
export function boardFile(path: string) {
  return /^(?:design|artifacts\/[a-z0-9-]+)\/boards\/([^/]+)$/.exec(path)?.[1] ?? null;
}
/** Whether edits on this branch are this design's: design/… for the App design, artifact/<name>… for one. */
export function ownsBranch(branch: string, artifact: string | null) {
  return artifact ? branchArtifact(branch) === artifact : branch.startsWith('design/');
}
/** A branch an artifact's edits are on, artifact/<name> or artifact/<name>--…, names it. */
export function branchArtifact(branch: string) {
  return /^artifact\/([a-z0-9]+(?:-[a-z0-9]+)*?)(?:--.*)?$/.exec(branch)?.[1] ?? null;
}

export type Design = {
  ref: string;
  commit: string;
  canvas: Canvas | null;
  /** A design made under Artifacts that main does not have yet. */
  fresh?: boolean;
  branches: { name: string; commit: string; updatedAt: string; by?: string; edits?: number }[];
  openComments: number;
};
export type Tokens = {
  colors: { name: string; light: string; dark?: string; usage?: string }[];
  textStyles: { name: string; size: number; lineHeight: number; weight: number }[];
};

export const isPhone = (board: Board) => board.w <= 500;

/** The smallest box around some boards, in canvas coordinates. */
export function bounds(canvas: Canvas, files: string[]) {
  const boards = files.map((file) => canvas.boards[file]).filter(Boolean);
  if (!boards.length) return { x: 0, y: 0, w: 1440, h: 900 };
  const x = Math.min(...boards.map((board) => board.x));
  const y = Math.min(...boards.map((board) => board.y));
  const right = Math.max(...boards.map((board) => board.x + board.w));
  const bottom = Math.max(...boards.map((board) => board.y + board.h));
  return { x, y, w: right - x, h: bottom - y };
}

/** Zoom and pan that fit a box into a viewport with some room around it. */
export function fit(
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
) {
  const pad = 48;
  const z = Math.min(
    1,
    Math.max(0.02, Math.min((width - pad * 2) / box.w, (height - pad * 2) / box.h)),
  );
  return { z, x: (width - box.w * z) / 2 - box.x * z, y: (height - box.h * z) / 2 - box.y * z };
}

/** Read design/ds/deploy-local/tokens.json into the colours and text styles the panels match against. */
export function readTokens(json: any): Tokens {
  const colors = (json?.color?.tokens ?? []).flatMap((token: any) =>
    typeof token?.name === 'string'
      ? [
          {
            name: token.name,
            light: String(token.value?.light ?? token.value ?? ''),
            dark: token.value?.dark ? String(token.value.dark) : undefined,
            usage: token.usage,
          },
        ]
      : [],
  );
  const textStyles = (json?.type?.groups ?? []).flatMap((group: any) =>
    (group?.styles ?? []).flatMap((style: any) =>
      typeof style?.name === 'string'
        ? [
            {
              name: style.name,
              size: parseFloat(style.fontSize),
              lineHeight: parseFloat(style.lineHeight),
              weight: Number(style.fontWeight ?? style.weight ?? 400),
            },
          ]
        : [],
    ),
  );
  return { colors, textStyles };
}

/** An rgb()/rgba() or hex colour as six lowercase hex digits, or null when transparent or unknown. */
export function hex(color: string) {
  const short = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (short)
    return [...short[1]]
      .map((c) => c + c)
      .join('')
      .toLowerCase();
  const long = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (long) return long[2] && long[2].toLowerCase() !== 'ff' ? null : long[1].toLowerCase();
  // color-mix() computes to color(srgb r g b), each from 0 to 1.
  const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/i.exec(
    color.trim(),
  );
  if (srgb)
    return srgb[4] !== undefined && Number(srgb[4]) < 1
      ? null
      : srgb
          .slice(1, 4)
          .map((part) =>
            Math.round(Number(part) * 255)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('');
  const rgb = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/i.exec(color.trim());
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) < 1)) return null;
  return rgb
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('');
}

export function colorToken(color: string, tokens: Tokens) {
  const value = hex(color);
  if (!value) return null;
  return tokens.colors.find((token) => hex(token.light) === value)?.name ?? null;
}

export function textStyle(size: number, lineHeight: number, weight: number, tokens: Tokens) {
  return (
    tokens.textStyles.find(
      (style) =>
        Math.abs(style.size - size) < 0.5 &&
        (Number.isNaN(style.lineHeight) || Math.abs(style.lineHeight - lineHeight) < 0.5) &&
        Math.abs(style.weight - weight) < 50,
    )?.name ?? null
  );
}

// Design-system pieces a layer can be, by class, and what Layers calls them.
const componentNames: Record<string, string> = {
  'dl-app': 'App',
  'dl-side': 'Sidebar',
  'dl-side-top': 'Sidebar top',
  'dl-side-nav': 'Navigation',
  'dl-side-foot': 'Account',
  'dl-side-label': 'Section label',
  'dl-nav': 'Nav item',
  'dl-head': 'Header',
  'dl-composer': 'Composer',
  'dl-composer-bar': 'Composer bar',
  'dl-send': 'Send',
  'dl-greeting': 'Greeting',
  'dl-title': 'Title',
  'dl-group': 'Group',
  'dl-item': 'Row',
  'dl-btn': 'Button',
  'dl-icon-btn': 'Icon button',
  'dl-chip': 'Chip',
  'dl-tag': 'Tag',
  'dl-seg': 'Segmented',
  'dl-avatar': 'Avatar',
  'dl-mark': 'Mark',
  'dl-brand': 'Brand',
  'dl-glyph': 'Glyph',
  'dl-status': 'Status',
  'dl-panel': 'Panel',
  'dl-panel-item': 'Panel row',
  'dl-section': 'Section',
  'dl-section-title': 'Section title',
  'dl-setting': 'Setting',
  'dl-step': 'Step',
  'dl-steps': 'Steps',
  'dl-worklog': 'Work log',
  'dl-phone': 'Phone',
  'dl-ph-row': 'Phone row',
  'dl-ph-group': 'Phone group',
  'dl-ph-btn': 'Phone button',
  'dl-page': 'Page',
  'dl-kbd': 'Shortcut',
};
// Pieces that carry their own label (a nav item's "New task"), unlike containers.
const labelledComponents = new Set([
  'dl-nav',
  'dl-item',
  'dl-btn',
  'dl-chip',
  'dl-tag',
  'dl-panel-item',
  'dl-ph-row',
  'dl-setting',
  'dl-step',
]);
// Layout-only classes: an element with only these is a wrapper, not something people name.
const layoutClasses = new Set([
  'dl-main',
  'dl-scroll',
  'dl-side-scroll',
  'dl-col',
  'dl-grow',
  'dl-lead',
  'dl-end',
  'dl-dock',
  'dl-hide-mid',
  'dl-hide-narrow',
]);
const tagNames: Record<string, string> = {
  svg: 'Icon',
  img: 'Image',
  h1: 'Heading',
  h2: 'Heading',
  h3: 'Heading',
  p: 'Paragraph',
  button: 'Button',
  a: 'Link',
  input: 'Field',
  textarea: 'Field',
  ul: 'List',
  li: 'List item',
  nav: 'Navigation',
  header: 'Header',
  aside: 'Panel',
  main: 'Main',
};

export type LayerFacts = {
  tag: string;
  classes: string[];
  dataName?: string | null;
  ariaLabel?: string | null;
  ownText: string;
  label?: string;
  childLayers: number;
};

const short = (text: string, limit = 40) => {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
};

/** The name Layers shows: an explicit name, a text layer's text, a component and its label, or the element's kind. */
export function layerName(facts: LayerFacts) {
  if (facts.dataName?.trim()) return short(facts.dataName);
  if (facts.ariaLabel?.trim()) return short(facts.ariaLabel);
  const component = facts.classes.map((name) => componentNames[name]).find(Boolean);
  // A mark's single letter or an icon's glyph is not a name; its component is.
  const text = facts.ownText.trim();
  if (text && !facts.childLayers && !(component && text.length <= 2)) return short(text);
  // Rows, buttons and chips read better with their label; containers never take a child's.
  const labelled = facts.classes.some((name) => labelledComponents.has(name));
  if (component)
    return labelled && facts.label ? `${component} · ${short(facts.label, 28)}` : component;
  return tagNames[facts.tag] ?? 'Frame';
}

/** A layer Layers folds away: no name of its own and nothing but layout around one child. */
export function isWrapper(facts: LayerFacts) {
  if (facts.dataName || facts.ariaLabel || facts.ownText.trim()) return false;
  if (facts.classes.some((name) => componentNames[name])) return false;
  if (facts.classes.some((name) => name.startsWith('dl-') && !layoutClasses.has(name)))
    return false;
  return facts.childLayers <= 1 || facts.classes.some((name) => layoutClasses.has(name));
}

/** What layerName needs to know about an element in a board's document. */
export function layerFacts(element: Element): LayerFacts {
  const own = [...element.childNodes]
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join(' ');
  const label = element.querySelector('.dl-t')?.textContent ?? '';
  return {
    tag: element.tagName.toLowerCase(),
    classes: (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
    dataName: element.getAttribute('data-name'),
    ariaLabel: element.getAttribute('aria-label'),
    ownText: own,
    label: short(label, 28),
    childLayers: element.querySelectorAll(':scope > [data-layer]').length,
  };
}

/** A layer's name within its board, or a readable form of its ID when the board isn't at hand. */
export function nameOf(doc: Document | null | undefined, id: string) {
  const element = doc?.querySelector(`[data-layer="${id.replace(/"/g, '')}"]`);
  return element ? layerName(layerFacts(element)) : layerLabel(id, '');
}

/** The named layers from the board down to a layer, skipping wrappers: Welcome › Greeting › Title. */
export function layerPath(element: Element) {
  const names: string[] = [];
  for (let at: Element | null = element; at && at.tagName !== 'BODY'; at = at.parentElement) {
    if (!at.hasAttribute('data-layer')) continue;
    const facts = layerFacts(at);
    if (at === element || !isWrapper(facts)) names.unshift(layerName(facts));
  }
  return names;
}

/** The short label drawn on a changed layer in the overlay. */
export function changeLabel(change: LayerChange) {
  if (change.change !== 'changed') return change.change;
  return change.details[0] ?? 'changed';
}

const parsed = new Map<string, Promise<Document | null>>();
/** A board's document, fetched and parsed once per URL, for naming layers outside the canvas. */
export function boardDocument(url: string, fetcher: (url: string) => Promise<Response>) {
  if (!parsed.has(url))
    parsed.set(
      url,
      fetcher(url)
        .then((response) => (response.ok ? response.text() : ''))
        .then((html) => (html ? new DOMParser().parseFromString(html, 'text/html') : null))
        .catch(() => null),
    );
  return parsed.get(url)!;
}
