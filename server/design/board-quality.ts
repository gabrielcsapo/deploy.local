// The checks `deploy design check` adds to what is cut off and what lost its ID: what a person
// reviewing the board would reject (problems) and what they would call off (notes, for taste).
// Each one looks only at what the branch changed: it runs on main's board too and drops what main
// already had. Everything here is plain text and arithmetic, so the same code runs on deploy.local
// and on the computer; what comes from a drawn page arrives as an Inspection.
import { boardElements, layerIds, type Library } from './board-html.ts';
import type { CheckProblem } from '../../shared/v2/design-overflow.ts';
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
      const type = [
        ...new Set<number>(
          (tokens.type?.groups ?? [])
            .flatMap((group: any) => group.styles ?? [])
            .map((style: any) => px(style.fontSize))
            .filter((size: number | null): size is number => size !== null),
        ),
      ].sort((a, b) => a - b);
      const space = (tokens.spacing?.tokens ?? [])
        .map((token: any) => px(token.value))
        .filter((size: number | null): size is number => size !== null);
      return { colors, type, space };
    }
  } catch {
    // Fall through to the stylesheet.
  }
  if (!css) return null;
  const light = /(?::root|\[data-theme="light"\])[^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const dark = /\[data-theme="dark"\][^{]*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const values = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
    );
  const lightValues = values(light);
  const darkValues = values(dark);
  const colors = Object.keys(lightValues)
    .filter((name) => parseHex(lightValues[name]))
    .map((name) => ({ name, light: lightValues[name], dark: darkValues[name] ?? null }));
  const all = values(css.replace(/\}/g, ';}'));
  const space = Object.entries(all)
    .filter(([name]) => /^space-/.test(name))
    .map(([, value]) => px(value))
    .filter((size): size is number => size !== null);
  const type = Object.entries(all)
    .filter(([name]) => /^(text|font-size|type)-/.test(name))
    .map(([, value]) => px(value))
    .filter((size): size is number => size !== null);
  return { colors, type: [...new Set(type)].sort((a, b) => a - b), space };
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

/**
 * Colours the branch wrote into a changed board's CSS or style attributes instead of a token.
 * A component's own markup (from the library) is not the board's to change, so its styles are
 * left out.
 */
export function notATokenProblems(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
  tokens: DesignTokens | null;
  library?: Library | null;
}): Finding[] {
  const fromLibrary = new Set(
    (input.library?.components ?? []).flatMap((component) =>
      boardDeclarations(component.html).map(key),
    ),
  );
  const added = addedDeclarations(boardDeclarations(input.before), boardDeclarations(input.after));
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const declaration of added) {
    if (fromLibrary.has(key(declaration)) || declaration.property.startsWith('--')) continue;
    for (const literal of colourLiterals(declaration.value)) {
      const id = `${declaration.where} ${declaration.property} ${literal}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const near = nearestToken(literal, input.tokens);
      const fix = near
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

type Placed = { x?: number; y?: number; w?: number; h?: number };
const overlaps = (a: Placed, b: Placed) => {
  const [ax, ay, aw, ah] = [Number(a.x), Number(a.y), Number(a.w), Number(a.h)];
  const [bx, by, bw, bh] = [Number(b.x), Number(b.y), Number(b.w), Number(b.h)];
  if (![ax, ay, aw, ah, bx, by, bw, bh].every(Number.isFinite)) return false;
  return ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
};

/** Boards placed on top of each other on the branch's canvas that were apart (or absent) on main. */
export function overlapProblems(
  branch: Record<string, Placed> | undefined,
  main: Record<string, Placed> | undefined = {},
): Finding[] {
  const entries = Object.entries(branch ?? {});
  const findings: Finding[] = [];
  for (let at = 0; at < entries.length; at++)
    for (let next = at + 1; next < entries.length; next++) {
      const [[a, placedA], [b, placedB]] = [entries[at], entries[next]];
      if (!overlaps(placedA, placedB)) continue;
      if (main[a] && main[b] && overlaps(main[a], main[b])) continue;
      // The board that moved or is new is the one to move.
      const moved = !main[b] || JSON.stringify(main[b]) !== JSON.stringify(placedB) ? b : a;
      const other = moved === a ? b : a;
      const place = (branch ?? {})[moved];
      findings.push({
        code: 'boards_overlap',
        file: moved,
        board: moved.replace(/\.html$/, ''),
        label: `${moved} sits on top of ${other} on the canvas`,
        detail: `x ${place.x}, y ${place.y}, ${place.w} × ${place.h}`,
        short: `on top of ${other}`,
        fix: `move it in canvas.json to an empty place, clear of ${other}`,
      });
    }
  return findings;
}

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
  /^(?:[a-z]|t|c|v|x|on|off|end|start|layer|el|element|item|row|box|wrap|wrapper|inner|outer|container|group|block|text|label|content|span|div|svg|path|g|p|a|i|b|em|strong|small|section|header|footer|main|nav|aside|button|img|ul|ol|li|figure)(?:-\d+)?$/;
/** Whether a layer ID says nothing about what the element is: a, a-2, t-2, svg-3, item-3, on. */
export const saysNothing = (layer: string) => empty.test(layer);

/** New layer IDs on the branch whose names say nothing, as one note for the board. */
export function layerNameNote(input: {
  file: string;
  title: string;
  before: string | null;
  after: string | null;
}): Finding | null {
  if (!input.after) return null;
  const old = new Set(input.before ? layerIds(input.before) : []);
  const bad = [
    ...new Set(layerIds(input.after).filter((layer) => !old.has(layer) && saysNothing(layer))),
  ];
  if (!bad.length) return null;
  return {
    code: 'layer_name_says_nothing',
    file: input.file,
    board: input.title,
    ...(bad.length === 1 ? { layer: bad[0] } : {}),
    label: `${input.title} has ${bad.length} new layer${bad.length === 1 ? '' : 's'} whose name says nothing`,
    detail: `${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ` and ${bad.length - 6} more` : ''}`,
    short: 'layer names say nothing',
    fix: 'rename each data-layer for what it is, like run-status or download-button',
  };
}

const plain = (html: string) =>
  decode(html.replace(/<(svg|style|script|title)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** The questions a board asks: each layer with data-question, its question and its words. */
export function boardQuestions(html: string | null | undefined) {
  if (!html) return [];
  return boardElements(html)
    .map((element) => {
      const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
      const question = attribute(tag, 'data-question');
      return question === null
        ? null
        : { layer: element.layer ?? '', question: question.trim(), text: plain(element.outer) };
    })
    .filter((entry): entry is { layer: string; question: string; text: string } =>
      Boolean(entry?.question),
    );
}

const numbers =
  /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety|hundred)\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?|times|runs|files)\b|\b(tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
/** The specific date, number or duration a layer states, if any. */
export const statedFact = (text: string) => numbers.exec(text)?.[0] ?? null;

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
    const fact = statedFact(entry.text);
    if (fact) {
      // Words around the fact, so the agent sees what it said.
      const at = entry.text.search(numbers);
      const words = entry.text.slice(Math.max(0, at - 20), at + 30).trim();
      problems.push({
        code: 'question_invented',
        file: input.file,
        board: input.title,
        ...(entry.layer ? { layer: entry.layer } : {}),
        label: `${input.title} answers its own question in ${entry.layer || 'a layer'}`,
        detail: `"${entry.question}" but it says "${words}"`,
        short: 'question answered with a made-up fact',
        fix: 'leave the value out or write it as a placeholder (like "after N days") until the owner answers',
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

/** The words a person sees on a board and where it lets them go, leaving out the sidebar. */
export function boardContent(html: string | null | undefined) {
  if (!html) return { words: [] as string[], links: [] as string[] };
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  for (const element of boardElements(body)) {
    const tag = /^<[^>]*>/.exec(element.outer)?.[0] ?? '';
    if (
      /^<nav\b/i.test(tag) ||
      /data-component="(sidebar|phone-title)"/.test(tag) ||
      /\bclass="[^"]*\b(dl-side|mac-lights)\b/.test(tag) ||
      /\saria-hidden="true"/.test(tag)
    )
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

/** What one board shows and the other does not, in both directions. */
export function contentDifferences(board: string | null, source: string | null) {
  const a = boardContent(board);
  const b = boardContent(source);
  const fold = (text: string) => text.toLowerCase();
  const has = (list: string[]) => new Set(list.map(fold));
  const inBoard = has(a.words);
  const inSource = has(b.words);
  return {
    onlySource: b.words.filter((word) => !inBoard.has(fold(word))),
    onlyBoard: a.words.filter((word) => !inSource.has(fold(word))),
    linksOnlySource: b.links.filter((link) => !a.links.includes(link)),
  };
}

const quoteList = (words: string[], limit = 4) =>
  `${words
    .slice(0, limit)
    .map((word) => `"${word.length > 32 ? `${word.slice(0, 31)}…` : word}"`)
    .join(', ')}${words.length > limit ? ` and ${words.length - limit} more` : ''}`;

/**
 * A board drawn from another (source= in its meta) against that board: what the source shows or
 * reaches that this one does not, and the reverse. Differences main's board already had are left
 * out.
 */
export function sourceNotes(input: {
  file: string;
  title: string;
  source: string;
  before: string | null;
  after: string | null;
  sourceBefore: string | null;
  sourceAfter: string | null;
}): Finding[] {
  if (!input.after || !input.sourceAfter) return [];
  const now = contentDifferences(input.after, input.sourceAfter);
  const then =
    input.before && input.sourceBefore
      ? contentDifferences(input.before, input.sourceBefore)
      : { onlySource: [], onlyBoard: [], linksOnlySource: [] };
  const fresh = (list: string[], old: string[]) => list.filter((item) => !old.includes(item));
  const sourceName = input.source.replace(/\.html$/, '');
  const name = input.file.replace(/\.html$/, '');
  const notes: Finding[] = [];
  const note = (label: string, detail: string, short: string, fix: string) =>
    notes.push({
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
  const missing = fresh(now.onlySource, then.onlySource);
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
  return notes;
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
      if (!text.bg) continue;
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
      fix: better
        ? `colour it var(--${better.name}), so it reads in ${input.scheme}`
        : `what is behind it does not change with the theme: put it on var(--surface) and colour the text var(--ink)`,
    });
  }
  return findings;
}

/** Taste, from the drawing at the board's first width in light: notes main's board did not have. */
export function drawnNotes(input: {
  file: string;
  title: string;
  width: number;
  after: Inspection | null;
  before: Inspection | null;
  tokens: DesignTokens | null;
  /** The same kinds of list on sibling boards of this platform, as main draws them. */
  siblings?: { file: string; rows: Record<string, number[]> }[];
}): Finding[] {
  const { after, before, file, title, width } = input;
  if (!after) return [];
  const notes: Finding[] = [];
  const at = { file, board: title, width, scheme: 'light' as const };

  // Type sizes off the scale, one note per size.
  if (input.tokens?.type.length) {
    const scale = new Set(input.tokens.type);
    const old = new Set((before?.texts ?? []).map((text) => `${text.layer} ${text.size}`));
    const off = new Map<number, string[]>();
    for (const text of after.texts) {
      const size = Math.round(text.size * 10) / 10;
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
        fix: `use a size on the type scale: ${input.tokens.type.join(', ')} px`,
      });
  }

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
}): Finding[] {
  if (!input.bundle || !input.after) return [];
  const systemRules = cssRules(input.bundle)
    .filter((rule) => /^\.dl-[\w-]+$/.test(rule.selector))
    .map((rule) => ({
      selector: rule.selector,
      set: new Set(
        rule.body
          .split(';')
          .map((part) => part.trim().replace(/\s*:\s*/, ':'))
          .filter(Boolean),
      ),
    }))
    .filter((rule) => rule.set.size >= 3);
  const local = (html: string | null) =>
    [...(html ?? '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].flatMap((style) =>
      cssRules(style[1]).filter((rule) => !/(^|[\s,>+~])\.dl-/.test(rule.selector)),
    );
  const old = new Set(local(input.before).map((rule) => `${rule.selector}{${rule.body}}`));
  const notes: Finding[] = [];
  for (const rule of local(input.after)) {
    if (old.has(`${rule.selector}{${rule.body}}`)) continue;
    const set = rule.body
      .split(';')
      .map((part) => part.trim().replace(/\s*:\s*/, ':'))
      .filter(Boolean);
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
export function screenFamily(file: string, files: string[], limit = 16) {
  const mine = screenBase(file);
  const bases = new Set(files.map(screenBase));
  const prefixes = [...(mine.match(/[A-Z0-9][a-z0-9]*|[a-z0-9]+/g) ?? [])]
    .map((_, at, words) => words.slice(0, at + 1).join(''))
    .filter((prefix) => prefix === mine || bases.has(prefix));
  for (const prefix of prefixes) {
    const group = files.filter((other) => other !== file && under(screenBase(other), prefix));
    if (group.length <= limit) return group;
  }
  return files.filter((other) => other !== file && under(screenBase(other), mine));
}
