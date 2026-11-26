// The checks `deploy design check` adds to what is cut off and what lost its ID: what a person
// reviewing the board would reject (problems) and what they would call off (notes, for taste).
// Each one looks only at what the branch changed: it runs on main's board too and drops what main
// already had. Everything here is plain text and arithmetic, so the same code runs on deploy.local
// and on the computer; what comes from a drawn page arrives as an Inspection.
import {
  assignLayerIds,
  boardElements,
  instanceQuestions,
  layerIds,
  syncInstances,
  type Library,
} from './board-html.ts';
import type { CheckProblem } from '../../shared/v2/design-overflow.ts';
import { platformInfo } from '../../shared/v2/design-platforms.ts';
import {
  contrast,
  hex,
  neededContrast,
  parseHex,
  type Inspection,
  type Rgb,
} from '../../shared/v2/design-inspect.ts';

export type Finding = CheckProblem & { code: string };

/** The design system as the checks read it: colour tokens by theme, and the type and space scales. */
export type DesignTokens = {
  colors: { name: string; light: string | null; dark: string | null }[];
  type: number[];
  /** The phone's own type scale, when the design system has one; phone boards are judged by it. */
  phoneType?: number[];
  /** The type scale of a platform with one of its own (mac, slide, doc, print, game), in px. */
  platformType?: Record<string, number[]>;
  /** Those scales' tokens as written ("--text-print-body: 8pt"), for what guide says. */
  typeTokens?: Record<string, { name: string; value: string }[]>;
  space: number[];
};

const px = (value: unknown) => {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
};

/** Tokens from tokens.json, or from tokens.css when that is all there is. */
export function readTokens(json: string | null, css: string | null): DesignTokens | null {
  try {
    const tokens = json ? JSON.parse(json) : null;
    if (tokens?.color?.tokens) {
      const colors = tokens.color.tokens.map((token: any) => ({
        name: String(token.name),
        light: typeof token.value === 'string' ? token.value : (token.value?.light ?? null),
        dark: typeof token.value === 'string' ? token.value : (token.value?.dark ?? null),
      }));
      const sizes = (groups: any[]) =>
        [
          ...new Set<number>(
            groups
              .flatMap((group: any) => group.styles ?? [])
              .map((style: any) => px(style.fontSize))
              .filter((size: number | null): size is number => size !== null),
          ),
        ].sort((a, b) => a - b);
      const groups: any[] = tokens.type?.groups ?? [];
      const isPhone = (group: any) => /phone|ios|iphone/i.test(String(group?.name ?? ''));
      const phone = groups.filter(isPhone);
      const type = sizes(phone.length ? groups.filter((group) => !isPhone(group)) : groups);
      const phoneType = phone.length ? sizes(phone) : undefined;
      const space = (tokens.spacing?.tokens ?? [])
        .map((token: any) => px(token.value))
        .filter((size: number | null): size is number => size !== null);
      return { colors, type, ...(phoneType ? { phoneType } : {}), space };
    }
  } catch {
    // Fall through to the stylesheet.
  }
  if (!css) return null;
  return tokensFromCss(css);
}

/** px from "16px", "1rem" (16 px a rem) or "9pt" (a point is 96/72 px). */
const cssPx = (value: string) => {
  const match = /^(-?\d*\.?\d+)(px|rem|pt)$/.exec(value.trim());
  return match ? Number(match[1]) * (match[2] === 'rem' ? 16 : match[2] === 'pt' ? 96 / 72 : 1) : null;
};

/** The platforms whose type scale is their own: --text-mac-*, --text-slide-*, --text-doc-* … */
const kindScales = ['mac', 'slide', 'doc', 'print', 'game'];

/**
 * Tokens from a stylesheet's custom properties: colours from :root (or [data-theme="light"]) for
 * light and from [data-theme="dark"] or a prefers-color-scheme: dark block for dark; the type scale
 * from --text-*, --font-size-*, --type-* or --fs-*; spacing from --space-* or --spacing-*.
 */
export function tokensFromCss(css: string): DesignTokens {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Take out the prefers-color-scheme: dark blocks (with their braces), keeping what they set.
  let outside = '';
  const darkBlocks: string[] = [];
  for (let at = 0; at < text.length;) {
    const media = text.slice(at).search(/@media[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{/);
    if (media < 0) {
      outside += text.slice(at);
      break;
    }
    const start = at + media;
    outside += text.slice(at, start);
    let depth = 0;
    let end = text.indexOf('{', start);
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    darkBlocks.push(text.slice(text.indexOf('{', start) + 1, end));
    at = end + 1;
  }
  const values = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--([\w-]+)\s*:\s*([^;}]+)[;}]?/g)].map((match) => [
        match[1],
        match[2].trim(),
      ]),
    );
  const blocks = (source: string, selector: RegExp) =>
    [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => selector.test(match[1]))
      .map((match) => match[2]);
  const light: Record<string, string> = {};
  for (const block of blocks(
    outside,
    /(^|[\s,]):root\b|\[data-theme=["']?light["']?\]|(^|[\s,])html\b/,
  ))
    Object.assign(light, values(block));
  const dark: Record<string, string> = {};
  for (const block of darkBlocks) Object.assign(dark, values(block));
  for (const block of blocks(outside, /\[data-theme=["']?dark["']?\]/))
    Object.assign(dark, values(block));
  const colors = Object.keys(light)
    .filter((name) => parseHex(light[name]))
    .map((name) => ({ name, light: light[name], dark: dark[name] ?? null }));
  const all = { ...light, ...values(outside) };
  const sizes = (pattern: RegExp) =>
    [
      ...new Set(
        Object.entries(all)
          .filter(([name]) => pattern.test(name))
          .map(([, value]) => cssPx(value))
          .filter((size): size is number => size !== null && size > 0),
      ),
    ].sort((a, b) => a - b);
  // Phone (iOS) sizes, named so, are the phone's own scale.
  const phoneType = sizes(/^(text|font-size|type|fs)-.*\b(phone|ios)\b/);
  const platformType: Record<string, number[]> = {};
  const typeTokens: Record<string, { name: string; value: string }[]> = {};
  for (const kind of kindScales) {
    const own = new RegExp(`^(text|font-size|type|fs)-.*\\b${kind}\\b`);
    const found = sizes(own);
    if (!found.length) continue;
    platformType[kind] = found;
    typeTokens[kind] = Object.entries(all)
      .filter(([name, value]) => own.test(name) && cssPx(value) !== null)
      .map(([name, value]) => ({ name: `--${name}`, value: value.trim() }));
  }
  return {
    colors,
    type: sizes(/^(text|font-size|type|fs)-(?!.*\b(phone|ios|mac|slide|doc|print|game)\b)/),
    ...(phoneType.length ? { phoneType } : {}),
    ...(Object.keys(platformType).length ? { platformType, typeTokens } : {}),
    space: sizes(/^(space|spacing)-/),
  };
}

// ── Reading a board's CSS ───────────────────────────────────────────────────────────────────────

const decode = (text: string) =>
  text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&');

const attribute = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}=("([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decode(match[2] ?? match[3] ?? '') : null;
};

/** One declaration, as written in a <style> rule or a style attribute, and where. */
export type Declaration = { property: string; value: string; where: string; layer?: string };

/** Every declaration in a board's <style> blocks and style attributes. */
export function boardDeclarations(html: string | null | undefined): Declaration[] {
  if (!html) return [];
  const found: Declaration[] = [];
  const split = (block: string, where: string, layer?: string) => {
    for (const part of block.split(';')) {
      const at = part.indexOf(':');
      if (at < 0) continue;
      const property = part.slice(0, at).trim().toLowerCase();
      const value = part
        .slice(at + 1)
        .trim()
        .replace(/\s+/g, ' ');
      if (property && value && /^[-a-z]+$/.test(property))
        found.push({ property, value, where, ...(layer ? { layer } : {}) });
    }
  };
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi))
    for (const rule of cssRules(style[1])) split(rule.body, rule.selector);
  for (const element of boardElements(html)) {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    const style = attribute(tag, 'style');
    if (style)
      split(
        style,
        element.layer ? `layer ${element.layer}` : 'a style attribute',
        element.layer ?? undefined,
      );
  }
  return found;
}

/** The innermost rules of a stylesheet: what each selector sets, @media blocks flattened. */
export function cssRules(css: string) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/\s+/g, ' '),
    body: match[2],
  }));
}

const colourLiteral =
  /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\bcolor-mix\((?:[^()]|\([^)]*\))*\)/gi;
/** Colours written out in a value: hex, rgb(), hsl(), or a color-mix() of literals. */
export function colourLiterals(value: string) {
  return [...value.matchAll(colourLiteral)]
    .map((match) => match[0])
    .filter(
      (literal) =>
        !/^color-mix/i.test(literal) ||
        /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(white|black)\b/i.test(literal),
    );
}

const key = (declaration: Declaration) => `${declaration.property}:${declaration.value}`;

/** Declarations the branch added: those the board has more of than main's board did. */
export function addedDeclarations(before: Declaration[], after: Declaration[]) {
  const counts = new Map<string, number>();
  for (const declaration of before)
    counts.set(key(declaration), (counts.get(key(declaration)) ?? 0) + 1);
  return after.filter((declaration) => {
    const left = counts.get(key(declaration)) ?? 0;
    if (left > 0) {
      counts.set(key(declaration), left - 1);
      return false;
    }
    return true;
  });
}

/** sRGB of a literal colour, when it is one this can read. */
function literalRgb(literal: string): Rgb | null {
  const fromHex = parseHex(literal);
  if (fromHex) return fromHex;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(literal);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : null;
}

const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The token nearest a colour, in either theme: "var(--surface)", exactly or nearly. */
export function nearestToken(literal: string, tokens: DesignTokens | null) {
  const rgb = literalRgb(literal);
  if (!rgb || !tokens?.colors.length) return null;
  let best: { name: string; value: string; distance: number } | null = null;
  for (const token of tokens.colors)
    for (const value of [token.light, token.dark]) {
      const tokenRgb = value ? parseHex(value) : null;
      if (!tokenRgb) continue;
      const gap = distance(rgb, tokenRgb);
      if (!best || gap < best.distance) best = { name: token.name, value: value!, distance: gap };
    }
  return best;
}

const atomPattern = /#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\)|\b(?:white|black)\b/gi;
/** The plain colours in a literal, written one way: a color-mix() is its parts. */
export const colourAtoms = (literal: string) =>
  [...literal.matchAll(atomPattern)].map((match) => match[0].toLowerCase().replace(/\s+/g, ''));

/**
 * Colours the branch wrote into a changed board's CSS or style attributes instead of a token. A
 * colour counts only when main's board (or, for a new board, the board it says it came from)
 * had no such colour anywhere: a declaration that changed around a colour it already had, like
 * a color-mix() whose other half became a token, is not new. A component's own markup (from the
 * library) is not the board's to change, so its styles are left out.
 */
export function notATokenProblems(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
  tokens: DesignTokens | null;
  library?: Library | null;
  /** For a new board: the board it was drawn from (source= or replaces=), if any. */
  origin?: string | null;
}): Finding[] {
  const fromLibrary = new Set(
    (input.library?.components ?? []).flatMap((component) =>
      boardDeclarations(component.html).map(key),
    ),
  );
  const baseline = input.before ?? input.origin ?? null;
  const known = new Set(
    boardDeclarations(baseline).flatMap((declaration) =>
      colourLiterals(declaration.value).flatMap(colourAtoms),
    ),
  );
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const declaration of boardDeclarations(input.after)) {
    if (fromLibrary.has(key(declaration)) || declaration.property.startsWith('--')) continue;
    for (const literal of colourLiterals(declaration.value)) {
      const atoms = colourAtoms(literal);
      if (atoms.length && atoms.every((atom) => known.has(atom))) continue;
      const id = `${declaration.where} ${declaration.property} ${literal}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const near = nearestToken(literal, input.tokens);
      const fix = /shadow/.test(declaration.property)
        ? 'use a shadow token: var(--shadow-sm), var(--shadow-raised), var(--shadow-lg) or var(--shadow-xl)'
        : near
          ? near.distance < 1
            ? `use var(--${near.name}), which is ${near.value}`
            : `use a token: the nearest is var(--${near.name}) (${near.value})`
          : 'use a colour token from design/ds';
      findings.push({
        code: 'not_a_token',
        file: input.file,
        board: input.title,
        ...(declaration.layer ? { layer: declaration.layer } : {}),
        label: `${input.title} hard-codes ${literal}`,
        detail: `${declaration.property} in ${declaration.where}`,
        short: `hard-codes ${literal}`,
        fix: `${fix}, so it works in dark too`,
      });
    }
  }
  return findings;
}

const spacing =
  /^(margin|padding|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;
/** Margins, padding and gaps the branch added that are not on the design system's spacing scale. */
export function spacingNotes(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
  tokens: DesignTokens | null;
}): Finding[] {
  if (!input.tokens?.space.length) return [];
  const scale = new Set([0, ...input.tokens.space]);
  const off = new Map<number, string[]>();
  for (const declaration of addedDeclarations(
    boardDeclarations(input.before),
    boardDeclarations(input.after),
  )) {
    if (!spacing.test(declaration.property)) continue;
    for (const part of declaration.value.replace(/!important/, '').split(/\s+/)) {
      const value = px(part);
      if (value === null || scale.has(Math.abs(value))) continue;
      const where = declaration.layer ?? declaration.where;
      const places = off.get(Math.abs(value)) ?? [];
      if (!places.includes(where)) places.push(where);
      off.set(Math.abs(value), places);
    }
  }
  return [...off].map(([value, places]) => ({
    code: 'spacing_off_scale',
    file: input.file,
    board: input.title,
    ...(places.length === 1 && !places[0].includes(' ') ? { layer: places[0] } : {}),
    label: `${input.title} spaces by ${value} px`,
    detail: `${places.slice(0, 3).join(', ')}${places.length > 3 ? ` and ${places.length - 3} more` : ''}`,
    short: `${value} px spacing`,
    fix: `use the spacing scale: ${[...input.tokens!.space].join(', ')} px (var(--space-…))`,
  }));
}

// ── The canvas ──────────────────────────────────────────────────────────────────────────────────

export { noteOverlapProblems, overlapProblems } from './board-placement.ts';

/** A board's height in canvas.json and in its own meta disagreeing, when main's agreed. */
export function heightProblem(input: {
  file: string;
  title: string;
  canvasHeight: number | undefined;
  metaHeight: number | null;
  mainCanvasHeight?: number;
  mainMetaHeight?: number | null;
}): Finding | null {
  const { canvasHeight, metaHeight } = input;
  if (!canvasHeight || !metaHeight || canvasHeight === metaHeight) return null;
  if (input.mainCanvasHeight === canvasHeight && input.mainMetaHeight === metaHeight) return null;
  return {
    code: 'height_differs',
    file: input.file,
    board: input.title,
    label: `${input.title} is ${metaHeight} px tall in its meta and ${canvasHeight} in canvas.json`,
    detail: 'the two must agree',
    short: 'height differs',
    fix: 'deploy design check --fix measures the board and writes both',
  };
}

// ── Layers ──────────────────────────────────────────────────────────────────────────────────────

const empty =
  /^(?:[a-z]|t|c|v|x|on|off|end|start|layer|el|element|item|row|box|wrap|wrapper|inner|outer|container|group|block|text|label|content|span|div|svg|path|g|p|a|i|b|em|strong|small|button|img|ul|ol|li|figure)(?:-\d+)?$/;
/**
 * Whether a layer ID says nothing about what the element is: a, a-2, t-2, svg-3, item-3, on.
 * Landmarks (main, nav, header, footer, aside, section) say where they are, so they pass.
 */
/** A name that is only a value says nothing about the element either: 212-kb, 3, 41-s. */
export const saysNothing = (layer: string) => empty.test(layer) || /^\d/.test(layer);

/** New layer IDs on the branch whose names say nothing, as one note for the board. */
/** New layer IDs on the branch, outside component instances, whose names say nothing. */
export function meaninglessLayers(before: string | null, after: string | null) {
  if (!after) return [];
  const old = new Set(before ? layerIds(before) : []);
  // Layers inside a component instance are named when the library draws it, not by the board.
  const elements = boardElements(after);
  const drawnByLibrary = new Set<string>();
  elements.forEach((element) => {
    if (!element.layer) return;
    for (let at = element.parent; at >= 0; at = elements[at].parent)
      if (/^<[^>]*\sdata-component="/.test(elements[at].outer)) {
        drawnByLibrary.add(element.layer);
        return;
      }
  });
  return [
    ...new Set(
      layerIds(after).filter(
        (layer) => !old.has(layer) && !drawnByLibrary.has(layer) && saysNothing(layer),
      ),
    ),
  ];
}

/**
 * The board with those layers named again for what they are (deploy design check --fix): only IDs
 * main does not have, so nothing on deploy.local points at them yet.
 */
export function renameMeaninglessLayers(before: string | null, after: string) {
  const bad = new Set(meaninglessLayers(before, after));
  if (!bad.size) return after;
  const stripped = after.replace(/\sdata-layer="([^"]*)"/g, (whole, layer: string) =>
    bad.has(layer) ? '' : whole,
  );
  return assignLayerIds(stripped);
}

export function layerNameNote(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
}): Finding | null {
  const bad = meaninglessLayers(input.before, input.after);
  if (!bad.length) return null;
  return {
    code: 'layer_name_says_nothing',
    file: input.file,
    board: input.title,
    ...(bad.length === 1 ? { layer: bad[0] } : {}),
    label: `${input.title} has ${bad.length} new layer${bad.length === 1 ? '' : 's'} whose name says nothing`,
    detail: `${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ` and ${bad.length - 6} more` : ''}`,
    short: 'layer names say nothing',
    fix: 'rename each data-layer for what it is, like file-report-xml-size, or run deploy design check --fix (only IDs main does not have)',
  };
}

const plain = (html: string) =>
  decode(html.replace(/<(svg|style|script|title)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** The questions a board asks: each layer with data-question, its question and its words. */
export function boardQuestions(html: string | null | undefined) {
  if (!html) return [];
  const elements = boardElements(html);
  const found: { layer: string; question: string; text: string }[] = [];
  for (const element of elements) {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    const question = attribute(tag, 'data-question');
    if (question?.trim())
      found.push({
        layer: element.layer ?? '',
        question: question.trim(),
        text: plain(element.outer),
      });
    // An instance root asks about its inner layers, which the library draws.
    for (const [layer, asked] of Object.entries(instanceQuestions(tag))) {
      const inner = boardElements(element.outer).find((entry) => entry.layer === layer);
      found.push({ layer, question: asked.trim(), text: inner ? plain(inner.outer) : '' });
    }
  }
  return found;
}

type ValueKind = 'duration' | 'date' | 'count' | 'amount';
const spelled =
  '(?:\\d+(?:[.,]\\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety|hundred)';
/** Values of a kind as a layer would state them, in units. */
const statedKinds: [ValueKind, RegExp][] = [
  [
    'duration',
    new RegExp(
      `\\b${spelled}\\s*(?:s|sec|secs|seconds?|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?|months?|years?)\\b`,
      'i',
    ),
  ],
  [
    'date',
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  ],
  [
    'count',
    new RegExp(
      `\\b${spelled}\\s+(?:files?|runs?|items?|times|versions?|releases?|builds?|copies|boards?|jobs?|tasks?|attempts?|retries|computers?|agents?|people|users?)\\b`,
      'i',
    ),
  ],
  ['amount', /\b\d+(?:[.,]\d+)?\s*(?:b|kb|mb|gb|tb|bytes?|%)\b|[$€£]\s*\d/i],
];
/** What kind of value a question asks for, by its words; null when it asks which or what it means. */
export function askedKinds(question: string): ValueKind[] {
  const q = question.toLowerCase();
  if (/\bhow long\b|\bhow often\b|\bfor how\b|\bretention\b|\bexpire|\bkept for\b/.test(q))
    return ['duration', 'date'];
  if (/\bwhen\b|\bwhat date\b|\bwhich (?:day|date)\b|\bwhat day\b/.test(q))
    return ['date', 'duration'];
  if (/\bhow many\b|\bnumber of\b|\bhow often\b/.test(q)) return ['count'];
  if (/\bhow much\b|\bhow big\b|\bhow large\b|\bsize limit\b|\bwhat limit\b|\bcost\b/.test(q))
    return ['amount', 'count'];
  return [];
}
/** The values of these kinds a layer states, first one found. */
export function statedValue(text: string, kinds: ValueKind[]) {
  for (const [kind, pattern] of statedKinds)
    if (kinds.includes(kind)) {
      const match = pattern.exec(text);
      if (match) return { kind, value: match[0], at: match.index };
    }
  return null;
}
/** The specific date, duration, count or amount a layer states, if any. */
export const statedFact = (text: string) =>
  statedValue(text, ['duration', 'date', 'count', 'amount'])?.value ?? null;

/**
 * Open questions the branch added, as notes, and a problem for each layer that asks a question
 * and answers it at once with a date, number or duration.
 */
export function questionFindings(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
}): { problems: Finding[]; notes: Finding[] } {
  const old = new Set(
    boardQuestions(input.before).map((entry) => `${entry.layer} ${entry.question}`),
  );
  const problems: Finding[] = [];
  const notes: Finding[] = [];
  for (const entry of boardQuestions(input.after)) {
    // Only a value of the kind the question asks for answers it: "How long are files kept?" over
    // "Deleted after 30 days" does; "Which size is this?" over "Web 1440" does not.
    const fact = statedValue(entry.text, askedKinds(entry.question));
    if (fact) {
      // Words around the fact, so the agent sees what it said.
      const { at } = fact;
      const words = entry.text.slice(Math.max(0, at - 20), at + 30).trim();
      problems.push({
        code: 'question_invented',
        file: input.file,
        board: input.title,
        ...(entry.layer ? { layer: entry.layer } : {}),
        label: `${input.title} answers its own question in ${entry.layer || 'a layer'}`,
        detail: `"${entry.question}" but it says "${words}"`,
        short: 'question answered with a made-up fact',
        fix: "say only what is true today, with no value, e.g. 'Kept with this run.', and keep the data-question",
      });
    }
    if (old.has(`${entry.layer} ${entry.question}`)) continue;
    notes.push({
      code: 'open_question',
      file: input.file,
      board: input.title,
      ...(entry.layer ? { layer: entry.layer } : {}),
      label: `${input.title} asks: ${entry.question}`,
      detail: entry.layer ? `on ${entry.layer}` : 'on the board',
      short: 'open question',
      fix: 'the owner answers it in a comment; until then the board shows no value',
    });
  }
  return { problems, notes };
}

// ── A board against its source ───────────────────────────────────────────────────────────────────

/**
 * The web-to-phone board mappings the design system states, in its "Phone screens" section:
 * lines like "Package → PackageVersionsPhone" (or ->), where both are boards.
 */
export function phoneMappings(readme: string | null | undefined, boards: string[]) {
  const section = /^#{2,4}\s+Phone screens\b[^\n]*\n([\s\S]*?)(?=^#{1,4}\s|(?![\s\S]))/im.exec(
    readme ?? '',
  )?.[1];
  const known = new Set(boards);
  const found: Record<string, string[]> = {};
  for (const match of (section ?? '').matchAll(
    /\b([A-Z][A-Za-z0-9]+)\s*(?:→|->)\s*([A-Z][A-Za-z0-9]+)\b/g,
  )) {
    const [web, phone] = [`${match[1]}.html`, `${match[2]}.html`];
    if (!known.has(web) || !known.has(phone)) continue;
    found[web] = [...new Set([...(found[web] ?? []), phone])];
  }
  return found;
}

/**
 * App chrome, not the page's own content: the sidebar, the top bar and its search and New task,
 * a phone's title bar and tab bar. A web page and its phone screen are compared without it,
 * since on iPhone the chrome lives on the tab roots, not on a detail screen.
 */
export const isChrome = (tag: string) =>
  /^<(nav|header)\b/i.test(tag) ||
  /data-component="(sidebar|header|phone-title|phone-tabs)"/.test(tag) ||
  /\bclass="[^"]*\b(dl-side|dl-head|dl-tabbar|dl-ph-top|mac-lights)\b/.test(tag);

/** The words a person sees on a board and where it lets them go, leaving out the chrome. */
export function boardContent(
  html: string | null | undefined,
  { keepChrome = false }: { keepChrome?: boolean } = {},
) {
  if (!html) return { words: [] as string[], links: [] as string[] };
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  for (const element of boardElements(body)) {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    if ((!keepChrome && isChrome(tag)) || /\saria-hidden="true"/.test(tag))
      body = body.replace(element.outer, ' ');
  }
  const words = new Set<string>();
  for (const chunk of body
    .replace(/<(svg|style|script|title)\b[\s\S]*?<\/\1>/gi, '<x>')
    .split(/<[^>]+>/)) {
    const text = decode(chunk).replace(/\s+/g, ' ').trim();
    if (text.length >= 2 && /\p{L}/u.test(text)) words.add(text);
  }
  const links = new Set<string>();
  for (const match of body.matchAll(/\s(?:href|data-link)="([^"#?]+\.html)/g)) links.add(match[1]);
  return { words: [...words], links: [...links] };
}

/** Status words a phone shows as a glyph: "Passed · 41 s" on the web is the glyph and "41 s". */
const statusWords =
  /\b(passed|failed|failing|running|queued|waiting|skipped|cancell?ed|succeeded|success|errored|error|done|ready|pending|published|live|stopped|offline|online)\b/gi;
/** A line of words as the comparison sees it: lower case, status words and separators gone. */
export const comparable = (text: string) =>
  text
    .toLowerCase()
    .replace(statusWords, ' ')
    .replace(/[·•|,:;–—-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const rowClass = /\b(dl-setting|dl-item|dl-ph-row|dl-log-row|dl-menu-item|dl-asks-row|row)\b/;

/**
 * The actions a board offers: buttons and button-styled links, with their words, where they lead
 * and whether they sit in a list row (a phone usually makes those the row's own tap).
 */
export function boardActions(
  html: string | null | undefined,
  { keepChrome = false }: { keepChrome?: boolean } = {},
) {
  if (!html) return [];
  const elements = boardElements(/<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html);
  const tag = (outer: string) => /^<[^>]*>/.exec(outer)?.[0] ?? '';
  const hidden = (index: number) => {
    for (let at = index; at >= 0; at = elements[at].parent) {
      const start = tag(elements[at].outer);
      if (!keepChrome && isChrome(start)) return true;
    }
    return false;
  };
  const inRow = (index: number) => {
    for (let at = elements[index].parent; at >= 0; at = elements[at].parent)
      if (rowClass.test(attribute(tag(elements[at].outer), 'class') ?? '')) return true;
    return false;
  };
  return elements
    .map((element, index) => ({ element, index, start: tag(element.outer) }))
    .filter(
      ({ start }) =>
        /^<button\b/i.test(start) ||
        /\brole="button"/.test(start) ||
        /\bclass="[^"]*\bdl-btn\b/.test(start),
    )
    .filter(({ index }) => !hidden(index))
    .map(({ element, index, start }) => ({
      layer: element.layer,
      // A button's name is what a person reads, or its accessible label when it shows an icon or
      // a symbol ("−", "+") with no words.
      text: /\p{L}/u.test(plain(element.outer))
        ? plain(element.outer)
        : attribute(start, 'aria-label') || '',
      label: attribute(start, 'aria-label') ?? '',
      href: attribute(start, 'href') ?? attribute(start, 'data-link'),
      inRow: inRow(index),
    }))
    .filter((action) => /\p{L}/u.test(action.text));
}

/**
 * The boards a board's links reach, counting a link to a web board as reaching its phone
 * counterparts too (PackageVersionsPhone, drawn from Package, answers a link to Package).
 */
function reachable(links: string[], counterparts: Record<string, string[]>) {
  const reached = new Set(links);
  for (const [web, phones] of Object.entries(counterparts))
    if (phones.some((phone) => reached.has(phone))) reached.add(web);
  return reached;
}

/** What one board shows and the other does not, in both directions, as a person would read it. */
export function contentDifferences(
  board: string | null,
  source: string | null,
  counterparts: Record<string, string[]> = {},
) {
  const a = boardContent(board);
  const b = boardContent(source);
  // Words of actions inside rows: a phone makes the row itself the way there.
  const rowWords = new Set(
    [...boardActions(board), ...boardActions(source)]
      .filter((action) => action.inRow)
      .map((action) => comparable(action.text)),
  );
  const keep = (word: string) => comparable(word) && !rowWords.has(comparable(word));
  // A line is kept when each of its ·-separated parts shows somewhere on the other board: a phone
  // may move "4f2e9a1" into its bar and keep "#31 merged by you" in the body.
  const shownOn = (words: string[]) => {
    const all = new Set(words.map(comparable));
    const text = ` ${words.map(comparable).join(' | ')} `;
    return (word: string) =>
      all.has(comparable(word)) ||
      word
        .split(/\s*[·•|]\s*/)
        .map(comparable)
        .filter(Boolean)
        .every(
          (part) =>
            text.includes(` ${part} `) ||
            text.includes(` ${part} |`) ||
            text.includes(`| ${part} `) ||
            all.has(part),
        );
  };
  const inBoard = shownOn(a.words);
  const inSource = shownOn(b.words);
  return {
    onlySource: b.words.filter((word) => keep(word) && !inBoard(word)),
    onlyBoard: a.words.filter((word) => keep(word) && !inSource(word)),
    linksOnlySource: b.links.filter((link) => !reachable(a.links, counterparts).has(link)),
  };
}

/**
 * Page actions the source offers that the board drops entirely: no action or row with the same
 * words, and no way to where it leads. A data-question that names it says why, and is enough.
 */
export function droppedActions(
  board: string | null,
  source: string | null,
  counterparts: Record<string, string[]> = {},
) {
  if (!board || !source) return [];
  // The board offers what it shows anywhere, its own bars included (an iPhone's Cancel and Add
  // sit in the navigation or sheet bar), and what its buttons are named, icons included.
  const ownActions = boardActions(board, { keepChrome: true });
  const words = new Set(
    [
      ...boardContent(board, { keepChrome: true }).words,
      ...ownActions.flatMap((action) => [action.text, action.label]),
    ]
      .map(comparable)
      .filter(Boolean),
  );
  const links = reachable(boardContent(board, { keepChrome: true }).links, counterparts);
  const questions = boardQuestions(board).map((entry) => entry.question.toLowerCase());
  return boardActions(source)
    .filter((action) => !action.inRow)
    .filter((action) => !words.has(comparable(action.text)))
    .filter(
      (action) =>
        !(action.href && /\.html/.test(action.href) && links.has(action.href.split('#')[0])),
    )
    .filter((action) => {
      const named = comparable(action.text)
        .split(' ')
        .filter((word) => word.length >= 3);
      return !questions.some((question) => named.every((word) => question.includes(word)));
    });
}

const quoteList = (words: string[], limit = 4) =>
  `${words
    .slice(0, limit)
    .map((word) => `"${word.length > 32 ? `${word.slice(0, 31)}…` : word}"`)
    .join(', ')}${words.length > limit ? ` and ${words.length - limit} more` : ''}`;

/**
 * A board drawn from another (source= in its meta) against that board: an action the source has
 * and the board drops is a problem; other words and ways out on one and not the other are notes.
 * Differences main's board already had are left out.
 */
export function sourceNotes(input: {
  file: string;
  title: string;
  source: string;
  before: string | null;
  after: string | null;
  sourceBefore: string | null;
  sourceAfter: string | null;
  /** A web board's phone counterparts: boards drawn from it, or its name with Phone. */
  counterparts?: Record<string, string[]>;
}): Finding[] {
  if (!input.after || !input.sourceAfter) return [];
  const counterparts = input.counterparts ?? {};
  const now = contentDifferences(input.after, input.sourceAfter, counterparts);
  const then =
    input.before && input.sourceBefore
      ? contentDifferences(input.before, input.sourceBefore)
      : { onlySource: [], onlyBoard: [], linksOnlySource: [] };
  const fresh = (list: string[], old: string[]) => list.filter((item) => !old.includes(item));
  const sourceName = input.source.replace(/\.html$/, '');
  const name = input.file.replace(/\.html$/, '');
  const findings: Finding[] = [];
  const oldDropped = new Set(
    droppedActions(input.before, input.sourceBefore).map((action) => comparable(action.text)),
  );
  const dropped = droppedActions(input.after, input.sourceAfter, counterparts).filter(
    (action) => !oldDropped.has(comparable(action.text)),
  );
  // Both boards new on this branch (a new project, a new screen): the designer is drawing both, so a
  // missing action is worth a look, not a block.
  const bothNew = !input.before && !input.sourceBefore;
  for (const action of dropped)
    findings.push({
      code: bothNew ? 'differs_from_source' : 'source_action_missing',
      file: input.file,
      board: input.title,
      ...(action.layer ? { layer: action.layer } : {}),
      label: `${name} has no "${action.text}"; ${sourceName} does`,
      detail: `${sourceName} ${action.layer ?? ''}`.trim(),
      short: `no "${action.text}"`,
      fix: `offer "${action.text}" on ${name}, or put data-question on the board saying why it has no "${action.text}"`,
    });
  const droppedWords = new Set(dropped.map((action) => comparable(action.text)));
  const note = (label: string, detail: string, short: string, fix: string) =>
    findings.push({
      code: 'differs_from_source',
      file: input.file,
      board: input.title,
      label,
      detail,
      short,
      fix,
    });
  const links = fresh(now.linksOnlySource, then.linksOnlySource);
  if (links.length)
    note(
      `${sourceName} leads to ${links
        .map((link) => link.replace(/\.html$/, ''))
        .slice(0, 4)
        .join(', ')}; ${name} has no way to reach ${links.length === 1 ? 'it' : 'them'}`,
      `links on ${sourceName} that ${name} lacks`,
      'cannot reach what its source reaches',
      `add the way there on ${name}, or say on the board why it is left out`,
    );
  const missing = fresh(now.onlySource, then.onlySource).filter(
    (word) => !droppedWords.has(comparable(word)),
  );
  if (missing.length)
    note(
      `${sourceName} shows ${quoteList(missing)}; ${name} does not`,
      `${missing.length} thing${missing.length === 1 ? '' : 's'} on ${sourceName} only`,
      'missing what its source shows',
      `show them on ${name}, or mark what is left out with data-question`,
    );
  const extra = fresh(now.onlyBoard, then.onlyBoard);
  if (extra.length)
    note(
      `${name} shows ${quoteList(extra)}; ${sourceName} does not`,
      `${extra.length} thing${extra.length === 1 ? '' : 's'} on ${name} only`,
      'shows what its source does not',
      `check the product does this; if it doesn't, mark it with data-question`,
    );
  return findings;
}

// ── Boards copied from others, and specimen words ────────────────────────────────────────────────

/** The lines of a board's own <style>, trimmed: what a copy keeps of the board it came from. */
export function styleLines(html: string | null | undefined) {
  return [...(html ?? '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)]
    .flatMap((style) => style[1].split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length >= 12);
}

/** A board without its sidebar and window chrome: what is its own. */
function ownPart(html: string | null | undefined) {
  if (!html) return '';
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  for (const element of boardElements(body)) {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    if (/data-component="sidebar"/.test(tag) || /\bclass="[^"]*\b(dl-side|mac-lights)\b/.test(tag))
      body = body.replace(element.outer, ' ');
  }
  return body;
}

/** How alike two boards are, 0 to 1: shared style lines and the classes of their own part. */
export function boardSimilarity(a: string | null | undefined, b: string | null | undefined) {
  const classes = (html: string | null | undefined) =>
    new Set(
      [...ownPart(html).matchAll(/\sclass="([^"]*)"/g)].flatMap((match) =>
        match[1].split(/\s+/).filter(Boolean),
      ),
    );
  const jaccard = (x: Set<string>, y: Set<string>) => {
    if (!x.size && !y.size) return 0;
    let shared = 0;
    for (const item of x) if (y.has(item)) shared++;
    return shared / (x.size + y.size - shared);
  };
  return (
    (jaccard(new Set(styleLines(a)), new Set(styleLines(b))) + jaccard(classes(a), classes(b))) / 2
  );
}

/** Boards that are the design system's own specimens, not product screens. */
export const isSpecimen = (file: string) => /^DesignSystem/.test(file);

/** Distinctive words on a board: text longer than 12 characters, as written. */
export const distinctiveWords = (html: string | null | undefined) =>
  boardContent(html).words.filter((word) => word.length > 12);

/** A product board's words that come from a design-system specimen and nowhere else. */
export function specimenNote(input: {
  file: string;
  title: string;
  words: string[];
  specimen: string;
}): Finding | null {
  if (!input.words.length) return null;
  return {
    code: 'specimen_text',
    file: input.file,
    board: input.title,
    label: `${input.title} shows sample words from ${input.specimen.replace(/\.html$/, '')}`,
    detail: quoteList(input.words, 3),
    short: 'specimen words',
    fix: "use this product's own data (deploy design guide lists the fixtures), not the design system's samples",
  };
}

// ── What the drawn page shows ────────────────────────────────────────────────────────────────────

/** The text token that reads best on a background, for a contrast fix. */
export function readableToken(
  bg: Rgb,
  scheme: 'light' | 'dark',
  tokens: DesignTokens | null,
  need: number,
) {
  const candidates = (tokens?.colors ?? [])
    .filter((token) => /^(ink|ink-soft|muted|on-action|accent)$/.test(token.name))
    .map((token) => ({ name: token.name, rgb: parseHex(token[scheme] ?? '') }))
    .filter((token): token is { name: string; rgb: Rgb } => Boolean(token.rgb))
    .map((token) => ({ ...token, ratio: contrast(token.rgb, bg) }))
    .filter((token) => token.ratio >= need);
  return candidates[0] ?? null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** Text that does not read against what is behind it, in one scheme; main's board is the baseline. */
export function contrastProblems(input: {
  file: string;
  title: string;
  width: number;
  scheme: 'light' | 'dark';
  after: Inspection | null;
  before: Inspection | null;
  tokens: DesignTokens | null;
}): Finding[] {
  if (!input.after) return [];
  const failing = (inspection: Inspection | null) => {
    const worst = new Map<
      string,
      { ratio: number; text: Inspection['texts'][number]; need: number }
    >();
    for (const text of inspection?.texts ?? []) {
      // WCAG exempts inactive controls, and so does the check.
      if (!text.bg || text.inactive) continue;
      const need = neededContrast(text.size, text.weight);
      const ratio = contrast(text.color, text.bg);
      if (ratio >= need) continue;
      const id = `${text.layer ?? ''} ${text.text}`;
      if (!worst.has(id) || worst.get(id)!.ratio > ratio) worst.set(id, { ratio, text, need });
    }
    return worst;
  };
  const old = failing(input.before);
  const findings: Finding[] = [];
  for (const [id, { ratio, text, need }] of failing(input.after)) {
    if (old.has(id)) continue;
    const better = readableToken(text.bg!, input.scheme, input.tokens, need);
    // A background no theme colour matches does not change with the theme: that is the fix.
    const themed = (input.tokens?.colors ?? []).some(
      (token) => token[input.scheme] && parseHex(token[input.scheme]!)?.join() === text.bg!.join(),
    );
    findings.push({
      code: 'low_contrast',
      file: input.file,
      board: input.title,
      width: input.width,
      scheme: input.scheme,
      ...(text.layer ? { layer: text.layer } : {}),
      label: `${input.title} ${text.layer ?? 'text'} is ${ratio.toFixed(1)}:1 in ${input.scheme}`,
      detail: `"${text.text}" ${hex(text.color)} on ${hex(text.bg!)}, needs ${need}:1`,
      short: `low contrast in ${input.scheme}`,
      fix:
        !themed || !better
          ? `what is behind it (${hex(text.bg!)}) is no theme colour in ${input.scheme}: put it on var(--surface) and colour the text var(--ink)`
          : `colour it var(--${better.name}), so it reads in ${input.scheme}`,
    });
  }
  return findings;
}

/** Taste, from the drawing at the board's first width in light: notes main's board did not have. */
/** The type sizes (px) a platform's boards are judged by; none when it has no scale to hold them to. */
export function typeScaleFor(tokens: DesignTokens | null, platform: string): number[] {
  if (!tokens) return [];
  const info = platformInfo(platform);
  if (!info.typed) return [];
  if (!info.scale) return tokens.type;
  if (info.scale === 'phone') return tokens.phoneType?.length ? tokens.phoneType : tokens.type;
  const own = tokens.platformType?.[info.scale];
  if (own?.length) return own;
  if (info.scaleFallback === 'phone')
    return tokens.phoneType?.length ? tokens.phoneType : tokens.type;
  return [];
}

const typeScaleName = (platform: string) =>
  ['web', 'tablet', 'tv'].includes(platform) ? '' : `${platform} `;

/** A scale as the design system writes it: pt for a print piece, else px. */
function typeScaleWords(tokens: DesignTokens | null, platform: string, scale: number[]) {
  const written = tokens?.typeTokens?.[platformInfo(platform).scale ?? '']?.map((token) => token.value);
  if (written?.length && platformInfo(platform).scale === platform)
    return [...new Set(written)].join(', ');
  return `${scale.map((size) => Math.round(size * 10) / 10).join(', ')} px`;
}

export function drawnNotes(input: {
  file: string;
  title: string;
  width: number;
  after: Inspection | null;
  before: Inspection | null;
  tokens: DesignTokens | null;
  /** The board's platform; a phone board is judged by the phone's type scale. */
  platform?: string | null;
  /** The same kinds of list on sibling boards of this platform, as main draws them. */
  siblings?: { file: string; rows: Record<string, number[]> }[];
}): Finding[] {
  const { after, before, file, title, width } = input;
  if (!after) return [];
  const notes: Finding[] = [];
  const at = { file, board: title, width, scheme: 'light' as const };

  // Type sizes off the scale, one note per size. Each platform is judged by its own scale: a
  // slide or a printed card is never held to the web's.
  const platform = input.platform ?? (width < 600 ? 'phone' : 'web');
  const typeScale = typeScaleFor(input.tokens, platform);
  if (typeScale.length) {
    const round = (value: number) => Math.round(value * 10) / 10;
    const scale = new Set(typeScale.map(round));
    const old = new Set((before?.texts ?? []).map((text) => `${text.layer} ${text.size}`));
    const off = new Map<number, string[]>();
    for (const text of after.texts) {
      const size = round(text.size);
      if (scale.has(size) || old.has(`${text.layer} ${text.size}`)) continue;
      const layers = off.get(size) ?? [];
      const where = text.layer ?? `"${text.text}"`;
      if (!layers.includes(where)) layers.push(where);
      off.set(size, layers);
    }
    for (const [size, layers] of off)
      notes.push({
        code: 'type_off_scale',
        ...at,
        ...(layers.length === 1 && !layers[0].startsWith('"') ? { layer: layers[0] } : {}),
        label: `${title} sets ${size} px type`,
        detail: `${layers.slice(0, 4).join(', ')}${layers.length > 4 ? ` and ${layers.length - 4} more` : ''}`,
        short: `${size} px type`,
        fix: `use a size on the ${typeScaleName(platform)}type scale: ${typeScaleWords(input.tokens, platform, typeScale)}`,
      });
  }
  // The rest of the notes are about app screens: lists, cards, aligned chrome, one primary action.
  if (!platformInfo(platform).appChecks) return notes;

  // Edges that nearly line up.
  const oldPairs = new Set((before?.aligned ?? []).map((pair) => `${pair.a} ${pair.b}`));
  for (const pair of after.aligned
    .filter((entry) => !oldPairs.has(`${entry.a} ${entry.b}`))
    .slice(0, 5))
    notes.push({
      code: 'nearly_aligned',
      ...at,
      layer: pair.b,
      label: `${title} ${pair.b} starts ${pair.dx} px from ${pair.a}`,
      detail: 'the left edges nearly line up',
      short: 'nearly aligned',
      fix: `line ${pair.b} up with ${pair.a}, or set it clearly apart`,
    });

  // Rows of a list taller or shorter than the same list on sibling boards.
  for (const [kind, heights] of Object.entries(after.rows)) {
    const height = median(heights);
    if (before?.rows[kind]?.length && median(before.rows[kind]) === height) continue;
    const others = (input.siblings ?? []).filter((sibling) => sibling.rows[kind]?.length);
    if (!others.length) continue;
    const usual = median(others.map((sibling) => median(sibling.rows[kind])));
    if (Math.abs(usual - height) <= 2) continue;
    notes.push({
      code: 'row_height_differs',
      ...at,
      label: `${title} ${kind} rows are ${height} px; ${usual} px on ${others
        .map((sibling) => sibling.file.replace(/\.html$/, ''))
        .slice(0, 3)
        .join(', ')}`,
      detail: `${heights.length} row${heights.length === 1 ? '' : 's'}`,
      short: 'row height differs',
      fix: `use the ${kind} rows as the sibling boards do, without extra padding or lines`,
    });
  }

  // A box inside a card.
  const oldBoxes = new Set((before?.boxes ?? []).map((box) => box.layer));
  for (const box of after.boxes.filter((entry) => !oldBoxes.has(entry.layer)).slice(0, 3))
    notes.push({
      code: 'box_in_card',
      ...at,
      layer: box.layer,
      label: `${title} draws a box, ${box.layer}, inside ${box.inside}`,
      detail: 'a bordered box inside a bordered box',
      short: 'box in a card',
      fix: `drop ${box.layer}'s border and background, or use rows inside the card`,
    });

  // A second primary button.
  if (after.primaries.length > 1 && after.primaries.length > (before?.primaries.length ?? 0))
    notes.push({
      code: 'second_primary',
      ...at,
      layer: after.primaries[1],
      label: `${title} shows ${after.primaries.length} primary buttons`,
      detail: after.primaries.slice(0, 4).join(', '),
      short: 'more than one primary',
      fix: 'keep one primary button, the next decision; make the rest secondary',
    });
  return notes;
}

// ── Board-local copies of components ────────────────────────────────────────────────────────────

/** Layout that any column or row sets: sharing it says nothing about copying a component. */
const layoutOnly =
  /^(display|flex|flex-[a-z-]+|align-[a-z-]+|justify-[a-z-]+|gap|row-gap|column-gap|width|min-width|max-width|height|min-height|max-height|box-sizing|position|overflow|overflow-[xy])\s*:/;

/**
 * Board-local rules the branch added that set what a design-system class already sets: three or
 * more of the same declarations, most of the rule. Cheap, and only a hint.
 */
export function localCopyNotes(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
  bundle: string | null;
  library?: Library | null;
  origin?: string | null;
}): Finding[] {
  if (!input.bundle || !input.after) return [];
  const systemRules = cssRules(input.bundle)
    .filter((rule) => /^\.[\w-]+$/.test(rule.selector))
    .map((rule) => ({
      selector: rule.selector,
      set: new Set(
        rule.body
          .split(';')
          .map((part) => part.trim().replace(/\s*:\s*/, ':'))
          .filter((part) => part && !layoutOnly.test(part)),
      ),
    }))
    .filter((rule) => rule.set.size >= 3);
  const systemClasses = new Set(
    [...input.bundle.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((match) => match[1]),
  );
  const local = (html: string | null) =>
    [...(html ?? '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].flatMap((style) =>
      // The board's own rules: those that style no class of the design system.
      cssRules(style[1]).filter(
        (rule) =>
          ![...rule.selector.matchAll(/\.([\w-]+)/g)].some((match) => systemClasses.has(match[1])),
      ),
    );
  // Only rules the branch added: a selector main's board (or, for a new board, the board it was
  // drawn from) did not have. A rule that changed is the board's own and was judged before.
  const old = new Set(local(input.before ?? input.origin ?? null).map((rule) => rule.selector));
  const notes: Finding[] = [];
  const done = new Set<string>();
  for (const rule of local(input.after)) {
    if (old.has(rule.selector) || done.has(rule.selector)) continue;
    done.add(rule.selector);
    const set = rule.body
      .split(';')
      .map((part) => part.trim().replace(/\s*:\s*/, ':'))
      .filter((part) => part && !layoutOnly.test(part));
    if (set.length < 3) continue;
    let best: { selector: string; shared: number } | null = null;
    for (const system of systemRules) {
      const shared = set.filter((declaration) => system.set.has(declaration)).length;
      if (shared >= 3 && shared / set.length >= 0.6 && (!best || shared > best.shared))
        best = { selector: system.selector, shared };
    }
    if (!best) continue;
    const className = best.selector.slice(1);
    const component = input.library?.components.find((entry) =>
      new RegExp(`class="[^"]*\\b${className}\\b`).test(entry.html),
    );
    notes.push({
      code: 'local_copy_of_component',
      file: input.file,
      board: input.title,
      label: `${input.title} ${rule.selector} copies ${best.selector}`,
      detail: `${best.shared} of its ${set.length} declarations`,
      short: `copies ${best.selector}`,
      fix: component
        ? `use the ${component.name} component (class ${className}) instead`
        : `use class ${className} instead`,
    });
  }
  return notes;
}

// ── Sibling boards ──────────────────────────────────────────────────────────────────────────────

/** A board's name without its platform: "PipelineRun" for PipelineRunPhone.html. */
export const screenBase = (file: string) =>
  file.replace(/\.html$/, '').replace(/(Phone|Pad|Tablet|Mac|TV)$/, '');

/** Whether a board's base name starts with a prefix at a word boundary: App holds AppLogs, not Apps. */
const under = (name: string, prefix: string) =>
  name === prefix || (name.startsWith(prefix) && /[A-Z0-9]/.test(name[prefix.length] ?? ''));

/**
 * The boards of the same screen as this one: those whose names start with the shortest board name
 * that is a prefix of this one and keeps the group small (16 boards), else those starting with
 * this one's own name. Platforms are not told apart here; callers filter by platform.
 */
export function screenFamily(
  file: string,
  files: string[],
  keep: (other: string) => boolean = () => true,
  limit = 16,
) {
  const mine = screenBase(file);
  const bases = new Set(files.map(screenBase));
  const prefixes = [...(mine.match(/[A-Z0-9][a-z0-9]*|[a-z0-9]+/g) ?? [])]
    .map((_, at, words) => words.slice(0, at + 1).join(''))
    .filter((prefix) => prefix === mine || bases.has(prefix));
  const kept = files.filter((other) => other !== file && keep(other));
  for (const prefix of prefixes) {
    const group = kept.filter((other) => under(screenBase(other), prefix));
    if (group.length <= limit) return group;
  }
  return kept.filter((other) => under(screenBase(other), mine));
}

/** Every code the check reports, whether it blocks, and what it means: what guide prints. */
export const checkCodes: { code: string; problem: boolean; means: string }[] = [
  { code: 'text_cut_off', problem: true, means: 'text leaves the page (at 700 px; at its size for the rest)' },
  { code: 'overflows_sideways', problem: true, means: 'the page scrolls sideways' },
  { code: 'low_contrast', problem: true, means: 'text under 4.5:1 (3:1 large) in light or dark' },
  { code: 'not_a_token', problem: true, means: 'a colour written out instead of a token' },
  { code: 'boards_overlap', problem: true, means: 'two boards on top of each other on the canvas' },
  {
    code: 'board_overlaps_note',
    problem: true,
    means: 'a board on a canvas note or section title',
  },
  { code: 'source_action_missing', problem: true, means: 'an action its source board has, gone' },
  {
    code: 'edited_inside_component',
    problem: true,
    means: 'markup typed inside an instance; use data-props',
  },
  {
    code: 'cut_off_bottom',
    problem: true,
    means: "text cut by a frame's bottom or under a bottom bar",
  },
  {
    code: 'missing_scheme',
    problem: true,
    means: "fewer schemes than the project's (by default light and dark; a slide or print is light)",
  },
  {
    code: 'scheme_dropped',
    problem: true,
    means: 'drawn in fewer schemes than its source or siblings',
  },
  {
    code: 'scheme_pinned_page',
    problem: true,
    means: 'data-theme on the page, its root or an instance root',
  },
  { code: 'question_invented', problem: true, means: 'a layer asks a question and states a value' },
  { code: 'height_differs', problem: true, means: 'canvas.json and the head disagree; --fix' },
  {
    code: 'lost_layer',
    problem: true,
    means: 'a layer ID main has, gone from an element still drawn',
  },
  {
    code: 'layer_renamed',
    problem: true,
    means: 'an element still drawn under a new ID; keep the old',
  },
  { code: 'broken_link', problem: true, means: 'a link to a board that does not exist' },
  { code: 'not_on_canvas', problem: true, means: 'a board file canvas.json does not place' },
  { code: 'canvas_only', problem: true, means: 'canvas.json places a board with no file' },
  { code: 'part_carried', problem: true, means: 'boards carried only for a component change' },
  { code: 'not_drawn', problem: true, means: 'the boards could not be drawn' },
  {
    code: 'outside_safe_area',
    problem: true,
    means: 'print: text or a mark closer to the trim than the safe margin',
  },
  {
    code: 'taller_than_frame',
    problem: true,
    means: 'slide, card, window or screen: more content than its frame holds',
  },
  { code: 'type_off_scale', problem: false, means: "a font size not on its platform's type scale" },
  { code: 'page_break_inside', problem: false, means: 'doc: a printed page ends on a heading' },
  {
    code: 'logo_small_unreadable',
    problem: false,
    means: 'logo: contrast under 3:1 at 16 px on a ground',
  },
  { code: 'spacing_off_scale', problem: false, means: 'a margin, padding or gap off the scale' },
  { code: 'nearly_aligned', problem: false, means: 'left edges 1 to 4 px apart' },
  {
    code: 'row_height_differs',
    problem: false,
    means: 'list rows unlike the same list on siblings',
  },
  { code: 'box_in_card', problem: false, means: 'a bordered box inside a card' },
  { code: 'second_primary', problem: true, means: 'more than one primary button shows' },
  { code: 'layer_name_says_nothing', problem: true, means: 'new layer IDs like a, t-2, svg-3' },
  {
    code: 'local_copy_of_component',
    problem: false,
    means: 'board CSS copying a design system class',
  },
  { code: 'layer_removed', problem: false, means: 'layer IDs whose elements the branch removed' },
  { code: 'specimen_text', problem: false, means: 'sample words from a DesignSystem board' },
  { code: 'open_question', problem: false, means: 'a data-question the owner has not answered' },
  {
    code: 'differs_from_source',
    problem: false,
    means: 'words or ways out unlike its source board',
  },
];

/** Layer IDs whose elements the branch removed: fine, and listed once per board. */
export function removedLayersNote(input: { file: string; title: string; layers: string[] }) {
  if (!input.layers.length) return null;
  const { layers } = input;
  return {
    code: 'layer_removed',
    file: input.file,
    board: input.title,
    label: `${input.title} removed ${layers.length} layer${layers.length === 1 ? '' : 's'}`,
    detail: `${layers.slice(0, 6).join(', ')}${layers.length > 6 ? ` and ${layers.length - 6} more` : ''}`,
    short: 'layers removed',
    fix: 'if any of these is still on the board under another ID, move the old ID onto it',
  } satisfies Finding;
}

// ── Instances edited by hand ─────────────────────────────────────────────────────────────────────

const instanceSignature = (outer: string) =>
  outer
    // Its values and questions sit on the root in either quotes: what is drawn is what counts.
    .replace(/\sdata-(props|questions)=("[^"]*"|'[^']*')/g, '')
    .replace(/\sdata-layer="[^"]*"/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s+/g, ' ')
    .trim();
const textChunks = (outer: string) =>
  outer
    .replace(/<(svg|style|script)\b[\s\S]*?<\/\1>/gi, '<x>')
    .split(/<[^>]+>/)
    .map((chunk) => decode(chunk).replace(/\s+/g, ' ').trim())
    .filter((chunk) => chunk && /\p{L}|\d/u.test(chunk));

/** A board's outermost component instances, in order, with their markup. */
function instancesOf(html: string | null | undefined) {
  if (!html) return [];
  const elements = boardElements(html);
  const inInstance = (index: number) => {
    for (let at = elements[index].parent; at >= 0; at = elements[at].parent)
      if (/^<[^>]*\sdata-component="/.test(elements[at].outer)) return true;
    return false;
  };
  return elements
    .map((element, index) => ({
      element,
      component: /^<[^>]*\sdata-component="([a-z0-9-]+)"/.exec(element.outer)?.[1] ?? null,
      index,
    }))
    .filter((entry) => entry.component && !inInstance(entry.index))
    .map(({ element, component }) => ({
      component: component!,
      layer: element.layer,
      outer: element.outer,
    }));
}

/**
 * Instances whose markup on the branch is not what their component draws from their props: the
 * renderer draws them again from data-props, so whatever was typed inside them never shows. An
 * instance the branch did not touch (as main had it) is left alone.
 */
export function editedInstanceProblems(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
  library: Library | null;
}): Finding[] {
  if (!input.after || !input.library || !input.after.includes(' data-component="')) return [];
  const written = instancesOf(input.after);
  const drawn = instancesOf(syncInstances(input.after, input.library));
  const old = new Set(instancesOf(input.before).map((entry) => instanceSignature(entry.outer)));
  const findings: Finding[] = [];
  written.forEach((entry, at) => {
    const component = input.library!.components.find((item) => item.id === entry.component);
    const rendered = drawn[at];
    if (!component || !rendered || rendered.component !== entry.component) return;
    const mine = instanceSignature(entry.outer);
    if (mine === instanceSignature(rendered.outer) || old.has(mine)) return;
    const shown = new Set(textChunks(rendered.outer));
    const lost = textChunks(entry.outer).filter((chunk) => !shown.has(chunk));
    const props = component.props.map((prop) => prop.id);
    findings.push({
      code: 'edited_inside_component',
      file: input.file,
      board: input.title,
      ...(entry.layer ? { layer: entry.layer } : {}),
      label: `${input.title} changes the inside of its ${component.name} instance${entry.layer ? ` ${entry.layer}` : ''}`,
      detail: lost.length
        ? `never drawn: ${lost
            .slice(0, 3)
            .map((chunk) => `"${chunk.length > 32 ? `${chunk.slice(0, 31)}…` : chunk}"`)
            .join(', ')}${lost.length > 3 ? ` and ${lost.length - 3} more` : ''}`
        : 'its markup is drawn again from data-props, so the change never shows',
      short: `edited inside ${component.id}`,
      fix: props.length
        ? `set it with data-props (props: ${props.join(', ')}) or put it outside the instance, then run deploy design sync`
        : `${component.id} takes no props: put it outside the instance`,
    });
  });
  return findings;
}

/**
 * Text partly hidden at the bottom of a fixed-height frame or a phone screen, or under a bar
 * pinned there: what main's board already hid is left out.
 */
export function cutOffBottomProblems(input: {
  file: string;
  title: string;
  width: number;
  after: Inspection | null;
  before: Inspection | null;
}): Finding[] {
  const old = new Set((input.before?.clipped ?? []).map((entry) => `${entry.layer} ${entry.text}`));
  return (input.after?.clipped ?? [])
    .filter((entry) => !old.has(`${entry.layer} ${entry.text}`))
    .slice(0, 5)
    .map((entry) => ({
      code: 'cut_off_bottom',
      file: input.file,
      board: input.title,
      width: input.width,
      scheme: 'light' as const,
      ...(entry.layer ? { layer: entry.layer } : {}),
      label:
        entry.by === 'bar'
          ? `${input.title} ${entry.layer ?? 'text'} sits under ${entry.frame ?? 'a bar'}`
          : `${input.title} ${entry.layer ?? 'text'} is cut off at the bottom${entry.frame ? ` of ${entry.frame}` : ''}`,
      detail: `"${entry.text}" is partly hidden`,
      short: 'cut off at the bottom',
      fix:
        entry.by === 'bar'
          ? 'leave room above the bar (padding at the foot of the scrolling content), or end the content sooner'
          : 'make the board taller (deploy design check --fix measures it), show fewer rows, or end on a whole row',
    }));
}

// ── Schemes ─────────────────────────────────────────────────────────────────────────────────────

const schemeFix =
  'draw it in every scheme its siblings draw; to keep a preview light, pin the inner preview, not the page';

/** The schemes a board is drawn in: what its head says, else light and dark. */
export const boardSchemes = (
  meta: { schemes: ('light' | 'dark')[] | null },
  fallback: ('light' | 'dark')[] = ['light', 'dark'],
) => meta.schemes ?? fallback;

/**
 * A board drawn in fewer schemes than the board it comes from or its siblings: its dark pairs
 * vanish. A source that is itself single-scheme sets the bar for it.
 */
export function schemeDroppedProblem(input: {
  file: string;
  title: string;
  schemes: string[];
  /** The board it came from (source= or copied_from=), with its schemes, when it names one. */
  from?: { file: string; schemes: string[] } | null;
  /** Its siblings' schemes, one list per sibling of the same platform. */
  siblings?: { file: string; schemes: string[] }[];
}): Finding | null {
  let expected: string[] | null = null;
  let because = '';
  if (input.from) {
    if (input.from.schemes.length < 2) return null;
    expected = input.from.schemes;
    because = input.from.file.replace(/\.html$/, '');
  } else if (input.siblings?.length) {
    // The usual set among siblings: the most common one.
    const counts = new Map<string, { schemes: string[]; count: number }>();
    for (const sibling of input.siblings) {
      const set = [...sibling.schemes].sort().join(' ');
      counts.set(set, { schemes: sibling.schemes, count: (counts.get(set)?.count ?? 0) + 1 });
    }
    const usual = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    expected = usual.schemes;
    because = `its siblings (${input.siblings
      .slice(0, 3)
      .map((sibling) => sibling.file.replace(/\.html$/, ''))
      .join(', ')})`;
  }
  const missing = (expected ?? []).filter((scheme) => !input.schemes.includes(scheme));
  if (!missing.length) return null;
  return {
    code: 'scheme_dropped',
    file: input.file,
    board: input.title,
    label: `${input.title} is drawn only in ${input.schemes.join(' and ')}`,
    detail: `${because} ${because.startsWith('its') ? 'draw' : 'draws'} ${expected!.join(' and ')}; ${missing.join(' and ')} is not drawn`,
    short: `no ${missing.join(' and ')}`,
    fix: schemeFix,
  };
}

/**
 * Where a board pins its scheme for the whole page: data-theme on <html> or <body>, on the
 * board's root element, or on a component instance's root. An inner preview (a frame on a canvas)
 * may pin itself; the page may not, or its dark pairs show a light page.
 */
export function pinnedSchemes(html: string | null | undefined) {
  if (!html) return [];
  const found: { layer: string | null; where: string; theme: string }[] = [];
  for (const match of html.matchAll(/<(html|body)\b[^>]*\sdata-theme="([^"]*)"/gi))
    found.push({ layer: null, where: `<${match[1].toLowerCase()}>`, theme: match[2] });
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const elements = boardElements(body);
  elements.forEach((element, index) => {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    const theme = /\sdata-theme="([^"]*)"/.exec(tag)?.[1];
    if (!theme) return;
    const root = element.parent < 0 && index === elements.findIndex((entry) => entry.parent < 0);
    const instance = /\sdata-component="([^"]*)"/.exec(tag)?.[1];
    if (root || instance)
      found.push({
        layer: element.layer,
        where: instance ? `the ${instance} instance` : 'the board root',
        theme,
      });
  });
  return found;
}

/** Pins the branch added: main's board already pinning the same place is not new. */
export function schemePinnedProblems(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
}): Finding[] {
  const pin = (entry: { layer: string | null; where: string; theme: string }) =>
    `${entry.layer} ${entry.where} ${entry.theme}`;
  const old = new Set(pinnedSchemes(input.before).map(pin));
  return pinnedSchemes(input.after)
    .filter((entry) => !old.has(pin(entry)))
    .map((entry) => ({
      code: 'scheme_pinned_page',
      file: input.file,
      board: input.title,
      ...(entry.layer ? { layer: entry.layer } : {}),
      label: `${input.title} pins ${entry.where}${entry.layer ? ` (${entry.layer})` : ''} to ${entry.theme}`,
      detail: `data-theme="${entry.theme}" there makes every scheme's pair show ${entry.theme}`,
      short: `pinned to ${entry.theme}`,
      fix: schemeFix,
    }));
}
