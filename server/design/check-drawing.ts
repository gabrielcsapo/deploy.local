// How `deploy design check` draws a board, on deploy.local (Playwright) and on the computer (the
// CLI's own DevTools driver, bin/design-browser.mjs): the page as review shows it, one drawing in
// a scheme with what the check measures there, and Before beside After as one picture. Both
// drivers give the same small tab, so the order of steps and what is measured are one piece of code.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { syncInstances, type Library } from './board-html.ts';
import { measureOverflow, type Overflow } from '../../shared/v2/design-overflow.ts';
import { inspectBoard, type Inspection } from '../../shared/v2/design-inspect.ts';
import type { PairLayout } from '../../shared/v2/design-platforms.ts';
import {
  headingsEndingPages,
  logoMarkSizes,
  pngSize,
  type LogoMarks,
  type LogoGround,
  type StrandedHeading,
} from './kind-checks.ts';
import type { ArtSheet, ArtSprite } from './art-checks.ts';
import {
  paletteOfCss,
  parseModelBox,
  type ModelBuild,
  type ModelStats,
  type ModelUnbuilt,
} from './model-build.ts';
import { parseBoardMeta } from '../../shared/v2/design-board-meta.ts';

/** A browser tab, as either driver gives it. */
export type DrawingTab = {
  setContent(html: string): Promise<void>;
  /** A JavaScript expression run in the page; a promise it returns is awaited. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(options?: {
    fullPage?: boolean;
    /** Just this box of the page, in CSS px. */
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Buffer>;
  /**
   * The page as printed: one picture per sheet, from the browser's own print path (the board's
   * @page size and margins, running header and footer, page breaks). Absent when the driver
   * cannot print; null when it could not draw the sheets.
   */
  printedPages?(options: {
    paperWidth: number;
    paperHeight: number;
    scale?: number;
  }): Promise<Buffer[] | null>;
};

/** Where a board's page gets what it links to, at one commit (or the working copy). */
export type BoardSources = {
  library(): Promise<Library | null>;
  /** A design-system file by its path under design/, like ds/deploy-local/tokens.css. */
  css(path: string): Promise<Buffer | null>;
  /** A picture in boards/captures, by its path under boards/. */
  capture(path: string): Promise<Buffer | null>;
  /**
   * A model board's model, built: null when design/models/ has no such model, `unbuilt` when
   * nothing here can build one. Absent when the drawing cannot build models.
   */
  model?(input: {
    name: string;
    palette: Record<string, string>;
    box: [number, number, number];
  }): Promise<ModelBuild | ModelUnbuilt | null>;
};

const captureLink = /((?:src|srcset)=")(captures\/[A-Za-z0-9_.-]+\.png)(")/g;

/** A board's pictures in boards/captures, as data, since a drawn page has no address to load from. */
export async function inlineBoardCaptures(
  page: string,
  capture: (path: string) => Promise<Buffer | null>,
) {
  const paths = [...new Set([...page.matchAll(captureLink)].map((match) => match[2]))];
  if (!paths.length) return page;
  const data = new Map<string, string>();
  for (const path of paths) {
    if (path.split('/').includes('..')) continue;
    const bytes = await capture(path);
    if (bytes) data.set(path, `data:image/png;base64,${bytes.toString('base64')}`);
  }
  return page.replace(captureLink, (whole, before, path, after) =>
    data.has(path) ? `${before}${data.get(path)}${after}` : whole,
  );
}

/**
 * A board as it is drawn: its instances by the library, with the design system and its pictures
 * inlined, so the page needs nothing from a server.
 */
export async function buildBoardPage(html: string, sources: BoardSources) {
  let page = html;
  if (page.includes(' data-component="')) {
    const library = await sources.library();
    if (library) page = syncInstances(page, library);
  }
  // A stylesheet of the project's under design/ (look.css, or a design system's in ds/),
  // however the tag is written (a formatter writes <link … />).
  for (const match of page.matchAll(
    /<link\b(?=[^>]*\srel="stylesheet")[^>]*\shref="\.\.\/([A-Za-z0-9_][\w./-]*\.css)"[^>]*>/g,
  )) {
    if (match[1].split('/').includes('..')) continue;
    const css = await sources.css(match[1]);
    page = page.replace(match[0], () => `<style>${css?.toString() ?? ''}</style>`);
  }
  if (/\sdata-model-(?:view|stat)="/.test(page)) page = await fillModel(page, sources.model);
  page = await inlineBoardCaptures(page, sources.capture);
  return inlineBoardImages(page, (path) => sources.css(path));
}

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};
const imageLink = /(<img\b[^>]*?\ssrc=")([^"]+)(")/g;

/**
 * Where a board's own picture lives under design/, from the src a board in boards/ gives it
 * (../sprites/cat.png, art/cat.svg): null for data, a web address, or a path that leaves design/.
 */
export function boardImagePath(src: string): string | null {
  if (/^(?:data:|[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src) || !src) return null;
  const parts: string[] = ['boards'];
  for (const part of src.split(/[?#]/)[0].split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

/** A board's pictures under design/, as data, since a drawn page has no address to load from. */
export async function inlineBoardImages(
  page: string,
  read: (path: string) => Promise<Buffer | null>,
) {
  const found = new Map<string, string | null>();
  for (const match of page.matchAll(imageLink)) {
    const path = boardImagePath(match[2]);
    const type = imageTypes[path?.split('.').pop()?.toLowerCase() ?? ''];
    if (!path || !type || found.has(match[2])) continue;
    const bytes = await read(path);
    found.set(match[2], bytes ? `data:${type};base64,${bytes.toString('base64')}` : null);
  }
  if (![...found.values()].some(Boolean)) return page;
  return page.replace(imageLink, (whole, before, src, after) =>
    found.get(src) ? `${before}${found.get(src)}${after}` : whole,
  );
}

/** The pictures a board names that are not there: src paths under design/ with no file. */
export async function missingBoardImages(
  html: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const match of html.matchAll(imageLink)) {
    const src = match[2];
    if (/^(?:data:|[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src) || missing.includes(src)) continue;
    const path = boardImagePath(src);
    if (!path || !(await exists(path))) missing.push(src);
  }
  return missing;
}

/** What a model board's page carries for the check: the model, its box and budget, and its build. */
export type ModelSheet = {
  name: string | null;
  /** The box it must fit, in metres (width, depth, height), as the board's size= says. */
  box: [number, number, number] | null;
  /** The triangles it may use, as the board's tris= says. */
  budget: number | null;
  palette: Record<string, string>;
  /** Why it was not built: no model named, none in design/models/, or no Blender here. */
  missing?: string;
  unbuilt?: string;
  stats?: ModelStats;
};

const modelLabels: Record<string, string> = {
  front: 'the front',
  side: 'the side',
  'three-quarter': 'three-quarter view',
  top: 'the top',
};

/** A plain picture in place of a view that could not be drawn, saying why. */
const modelPlaceholder = (text: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><rect width="400" height="400" fill="#eeeef2"/><text x="200" y="200" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#55556a">${text.replace(/[<&>"]/g, '')}</text></svg>`,
  ).toString('base64')}`;

/**
 * A model board with its model drawn in: each <img data-model-view="front|side|three-quarter|top|bottom">
 * gets the picture from that side, each data-model-stat="tris|size" the number measured, and the
 * page carries the build's stats for the check.
 */
async function fillModel(page: string, build: BoardSources['model']) {
  const meta = parseBoardMeta(page);
  const name = meta.other.model?.trim() || null;
  const box = parseModelBox(meta.size);
  const budget = Number(meta.other.tris) > 0 ? Math.round(Number(meta.other.tris)) : null;
  const palette = paletteOfCss(page);
  const sheet: ModelSheet = { name, box, budget, palette };
  let built: ModelBuild | null = null;
  if (!name) sheet.missing = 'The board names no model (model=<Name> in its design-board meta)';
  else if (!build) sheet.unbuilt = 'This drawing cannot build models';
  else {
    const result = await build({ name, palette, box: box ?? [1, 1, 1] });
    if (!result) sheet.missing = `design/models/ has no ${name}.py, .glb, .gltf or .blend`;
    else if ('unbuilt' in result) sheet.unbuilt = result.unbuilt;
    else {
      built = result;
      sheet.stats = result.stats;
    }
  }
  const why = sheet.stats?.error
    ? `${name} did not build`
    : (sheet.missing ?? sheet.unbuilt)
      ? `${name ?? 'The model'} is not drawn here`
      : '';
  let filled = page.replace(
    /<img\b(?=[^>]*\sdata-model-view="([a-z-]+)")[^>]*>/g,
    (tag: string, view: string) => {
      const png = built?.views[view as keyof ModelBuild['views']];
      const src = png
        ? `data:image/png;base64,${png.toString('base64')}`
        : modelPlaceholder(why || `No picture from ${modelLabels[view] ?? view}`);
      const without = tag.replace(/\ssrc="[^"]*"/, '');
      return without.replace(/^<img\b/, `<img src="${src}"`);
    },
  );
  const stats = sheet.stats;
  const size =
    stats?.bounds &&
    stats.bounds.max
      .map((high, i) => (high - stats.bounds!.min[i]).toFixed(2))
      .join(' × ')
      .concat(' m');
  const values: Record<string, string | undefined> = {
    tris: stats?.tris?.toLocaleString('en-US'),
    size,
  };
  filled = filled.replace(
    /<([a-z][a-z0-9]*)\b([^>]*\sdata-model-stat="([a-z]+)"[^>]*)>[^<]*<\/\1>/g,
    (whole: string, tag: string, attributes: string, stat: string) =>
      values[stat] === undefined ? whole : `<${tag}${attributes}>${values[stat]}</${tag}>`,
  );
  const json = JSON.stringify(sheet).replace(/</g, '\\u003c');
  const carried = `<script type="application/json" data-model-sheet>${json}</script>`;
  return /<\/body>/i.test(filled)
    ? filled.replace(/<\/body>/i, () => `${carried}</body>`)
    : `${filled}${carried}`;
}

/**
 * Runs in the page: reads the model sheet the page carries and draws the model's box over each
 * picture of it, dashed, with a red edge where the model runs off the picture.
 */
export function frameModel(doc: Document = document): ModelSheet | null {
  const carried = doc.querySelector('script[data-model-sheet]');
  if (!carried) return null;
  let sheet: ModelSheet;
  try {
    sheet = JSON.parse(carried.textContent ?? 'null');
  } catch {
    return null;
  }
  const views = sheet?.stats?.views ?? {};
  const view = doc.defaultView!;
  const svgNs = 'http://www.w3.org/2000/svg';
  for (const img of doc.querySelectorAll<HTMLImageElement>('img[data-model-view]')) {
    const picture = views[img.getAttribute('data-model-view') as keyof typeof views];
    if (!picture) continue;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    // The picture is square and drawn whole in its box (object-fit contain, or its own size).
    const side = Math.min(rect.width, rect.height);
    const left = rect.left + view.scrollX + (rect.width - side) / 2;
    const top = rect.top + view.scrollY + (rect.height - side) / 2;
    const svg = doc.createElementNS(svgNs, 'svg');
    svg.setAttribute('data-check-marks', '');
    svg.setAttribute('viewBox', '0 0 1 1');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute(
      'style',
      `position:absolute;left:${left}px;top:${top}px;width:${side}px;height:${side}px;overflow:visible;pointer-events:none;z-index:2147483646`,
    );
    for (const [a, b] of picture.boxEdges) {
      const line = doc.createElementNS(svgNs, 'line');
      const [x1, y1] = picture.box[a];
      const [x2, y2] = picture.box[b];
      line.setAttribute('x1', String(x1));
      line.setAttribute('y1', String(y1));
      line.setAttribute('x2', String(x2));
      line.setAttribute('y2', String(y2));
      line.setAttribute(
        'style',
        'stroke:#2f6fde;stroke-width:1.25px;stroke-dasharray:5 4;vector-effect:non-scaling-stroke;opacity:.85',
      );
      svg.append(line);
    }
    for (const edge of picture.edges) {
      const bar = doc.createElementNS(svgNs, 'rect');
      const across = edge === 'top' || edge === 'bottom';
      bar.setAttribute('x', edge === 'right' ? '0.985' : '0');
      bar.setAttribute('y', edge === 'bottom' ? '0.985' : '0');
      bar.setAttribute('width', across ? '1' : '0.015');
      bar.setAttribute('height', across ? '0.015' : '1');
      bar.setAttribute('fill', '#d92d20');
      svg.append(bar);
    }
    doc.body.append(svg);
  }
  return sheet;
}

export type BoardQuestion = { n: number; layer: string; question: string };

/**
 * Runs in the page, after measuring: each layer that asks a question gets a thin dashed line on
 * its own edge and a small numbered badge outside its box (after its right edge, else above),
 * where it covers no text, drawn above the page so nothing moves. The questions themselves are
 * listed beside the picture, never over the board.
 */
export function markQuestions(doc: Document = document): BoardQuestion[] {
  const view = doc.defaultView!;
  const found: BoardQuestion[] = [];
  const layer = doc.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.setAttribute('data-check-marks', '');
  layer.style.cssText =
    'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none';
  // Questions on layers, and an instance root's questions about its inner layers.
  const asked: [Element, string][] = [];
  for (const element of doc.querySelectorAll('[data-question], [data-questions]')) {
    const own = (element.getAttribute('data-question') ?? '').trim();
    if (own) asked.push([element, own]);
    let inner: Record<string, unknown> = {};
    try {
      inner = JSON.parse(element.getAttribute('data-questions') ?? '{}') ?? {};
    } catch {
      inner = {};
    }
    for (const [id, text] of Object.entries(inner)) {
      const target = [...element.querySelectorAll('[data-layer]')].find(
        (candidate) => candidate.getAttribute('data-layer') === id,
      );
      if (target && typeof text === 'string' && text.trim()) asked.push([target, text.trim()]);
    }
  }
  // Where text is drawn: a badge never covers any, its own layer's or another's.
  const textBoxes: DOMRect[] = [];
  const walker = doc.createTreeWalker(doc.body, 4);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(node);
    for (const box of range.getClientRects()) if (box.width && box.height) textBoxes.push(box);
  }
  const placedBadges: { left: number; top: number; right: number; bottom: number }[] = [];
  const size = 16;
  const clear = (left: number, top: number) => {
    const box = { left, top, right: left + size, bottom: top + size };
    if (left < 0 || top < 0 || box.right > view.innerWidth || box.bottom > view.innerHeight)
      return false;
    const hits = (other: { left: number; top: number; right: number; bottom: number }) =>
      box.left < other.right &&
      other.left < box.right &&
      box.top < other.bottom &&
      other.top < box.bottom;
    return !textBoxes.some(hits) && !placedBadges.some(hits);
  };
  for (const [element, question] of asked) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const n = found.length + 1;
    found.push({ n, layer: element.getAttribute('data-layer') ?? '', question });
    const outline = doc.createElement('div');
    outline.style.cssText = `position:absolute;left:${rect.left + view.scrollX}px;top:${rect.top + view.scrollY}px;width:${rect.width}px;height:${rect.height}px;box-sizing:border-box;border:1px dashed #2f5bb7;border-radius:2px`;
    // Outside the layer's box: just after its right edge, else above it, else before its left
    // edge, else below it; the first spot that covers no text.
    const middle = rect.top + (rect.height - size) / 2;
    const spots = [
      [rect.right + 3, middle],
      [rect.right + 3, rect.top],
      [rect.right - size, rect.top - size - 3],
      [rect.left, rect.top - size - 3],
      [rect.left - size - 3, middle],
      [rect.right - size, rect.bottom + 3],
      [rect.left, rect.bottom + 3],
    ];
    const [left, top] = spots.find(([x, y]) => clear(x, y)) ?? spots[0];
    placedBadges.push({ left, top, right: left + size, bottom: top + size });
    const badge = doc.createElement('div');
    badge.textContent = String(n);
    badge.style.cssText = `position:absolute;left:${left + view.scrollX}px;top:${top + view.scrollY}px;width:${size}px;height:${size}px;border-radius:${size}px;background:#2f5bb7;color:#fff;font:600 10px/${size}px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff`;
    layer.append(outline, badge);
  }
  if (found.length) doc.body.append(layer);
  return found;
}

/**
 * Runs in the page before it is printed: the paper is white. A page's ground colour (on the page,
 * the body or the one wrapper that spans it) is the screen's; on paper it is not printed, as a
 * browser's own print dialog leaves it out by default.
 */
export function whitePaper(doc: Document = document) {
  const view = doc.defaultView!;
  const style = doc.createElement('style');
  style.textContent = '@media print{html,body{background:#fff!important}}';
  doc.head.append(style);
  const paint = (element: Element) => {
    const color = view.getComputedStyle(element).backgroundColor;
    return color === 'transparent' || /rgba\(.*,\s*0\)$/.test(color) ? null : color;
  };
  // The ground is the page's colour (the page's or the body's), or that of the wrapper that spans
  // the body; a wrapper's own colour is the ground, and only that colour inside it. A tinted block
  // in the page is the design's own and stays.
  let ground = paint(doc.documentElement) ?? paint(doc.body);
  const clear = (element: Element, depth: number) => {
    const color = paint(element);
    const wide = element.getBoundingClientRect().width >= doc.body.clientWidth * 0.9;
    if (color && wide && (depth === 0 || ground === color)) {
      if (depth === 0) ground = color;
      (element as HTMLElement).style.setProperty('background', 'transparent', 'important');
    }
    if (wide && depth < 2) for (const child of element.children) clear(child, depth + 1);
  };
  for (const child of doc.body.children) clear(child, 0);
}

/**
 * Runs in the page for the probe print: headings are solid magenta, and what a printer repeats
 * from the page edge (fixed elements, a running header and footer) is hidden, so the last ink
 * on a sheet is its body and the colour of that ink says whether it is a heading.
 */
export function probeHeadings(doc: Document = document) {
  const style = doc.createElement('style');
  style.textContent =
    'h1,h2,h3,h4,h5,h6,h1 *,h2 *,h3 *,h4 *,h5 *,h6 *{background:#f0f!important;color:#f0f!important;border-color:#f0f!important;text-shadow:none!important}';
  doc.head.append(style);
  const view = doc.defaultView!;
  for (const element of doc.body.querySelectorAll('*'))
    if (view.getComputedStyle(element).position === 'fixed')
      (element as HTMLElement).style.setProperty('visibility', 'hidden', 'important');
}

/**
 * Runs in the page: the mark of a logo board as a self-contained SVG (every colour resolved to
 * what it is drawn with), the colour it sits on, and the ink it is drawn in. The mark is the
 * layer named "mark", else the first .ds-logo-mark, else the first SVG.
 */
export function readMark(doc: Document = document) {
  const view = doc.defaultView!;
  const mark =
    doc.querySelector('svg[data-layer="mark"]') ??
    doc.querySelector('svg.ds-logo-mark') ??
    doc.querySelector('svg');
  if (!mark) return null;
  // The mark as drawn now, every colour resolved and what is hidden left out.
  const serialize = () => {
    const clone = mark.cloneNode(true) as SVGElement;
    const from = [mark, ...mark.querySelectorAll('*')];
    const to = [clone, ...clone.querySelectorAll('*')];
    const rgb = (value: string) => value;
    const styles = [...clone.querySelectorAll('style')];
    to.forEach((node, at) => {
      const computed = view.getComputedStyle(from[at]);
      for (const name of [...node.getAttributeNames()])
        if (name === 'class' || name === 'style' || name.startsWith('data-'))
          node.removeAttribute(name);
      if (at === 0) return;
      if (computed.display === 'none') {
        node.setAttribute('data-hidden-cut', '');
        return;
      }
      node.setAttribute('fill', rgb(computed.fill));
      if (computed.stroke && computed.stroke !== 'none') {
        node.setAttribute('stroke', rgb(computed.stroke));
        node.setAttribute('stroke-width', computed.strokeWidth);
      }
      if (computed.opacity !== '1') node.setAttribute('opacity', computed.opacity);
    });
    for (const style of styles) style.remove();
    const box = (mark.getAttribute('viewBox') ?? '0 0 64 64').split(/[\s,]+/).map(Number);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(box[2] || 64));
    clone.setAttribute('height', String(box[3] || 64));
    clone.removeAttribute('role');
    for (const node of [...clone.querySelectorAll('[data-hidden-cut]')]) node.remove();
    return clone.outerHTML;
  };
  let ground = 'rgb(255, 255, 255)';
  for (let at: Element | null = mark; at; at = at.parentElement) {
    const paint = view.getComputedStyle(at).backgroundColor;
    if (paint !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(paint)) {
      ground = paint;
      break;
    }
  }
  const svg = serialize();
  // The small cut (a <g class="small"> the kit shows at 32 px and under), when the mark has one.
  let small: string | null = null;
  if (mark.querySelector('.small')) {
    mark.classList.add('small-cut');
    small = serialize();
    mark.classList.remove('small-cut');
  }
  return { svg, small, ground, ink: view.getComputedStyle(mark).color };
}

/**
 * Runs in the page: every element labelled for one fixed ground (light, dark, reversed, brand,
 * on-light, on-dark in its layer name or class) with the colour it is drawn on, so the same
 * labels can be compared between schemes.
 */
export function readGrounds(doc: Document = document): LogoGround[] {
  const view = doc.defaultView!;
  const label =
    /(^|[\s_-])(on-light|on-dark|light|dark|reversed|reverse|brand|inverse|inverted)([\s_-]|$)/i;
  const found: LogoGround[] = [];
  for (const element of doc.body.querySelectorAll('*')) {
    const layer = element.getAttribute('data-layer') ?? '';
    const said = `${layer} ${typeof element.className === 'string' ? element.className : ''}`;
    const match = label.exec(said);
    if (!match) continue;
    const paint = view.getComputedStyle(element).backgroundColor;
    if (paint === 'transparent' || /rgba\(.*,\s*0\)$/.test(paint)) continue;
    found.push({
      layer: layer || element.tagName.toLowerCase(),
      label: match[2].toLowerCase(),
      ground: paint,
    });
  }
  return found;
}

/**
 * Runs in the page: a sprite sheet's grid (tile= and play= in its head), its palette (every
 * --pal-* and --stage-* the stylesheets declare on :root, resolved), the grounds it is played on
 * (.art-ground) and each sprite (svg.art-sprite): its size, what it is painted with, what is off
 * the pixel grid, and the sprite alone as a self-contained SVG at one CSS px a pixel.
 */
export function readSprites(doc: Document = document) {
  const view = doc.defaultView!;
  const content = doc.querySelector('meta[name="design-board"]')?.getAttribute('content') ?? '';
  const said = (key: string) =>
    Number(new RegExp(`(?:^|[,;])\\s*${key}=([0-9.]+)`).exec(content)?.[1]) || 0;
  const tile = Math.max(1, Math.round(said('tile') || 16));
  const play = said('play') || tile * 3;
  const probe = doc.createElement('i');
  doc.body.append(probe);
  const resolve = (value: string) => {
    probe.style.color = '';
    probe.style.color = value;
    return view.getComputedStyle(probe).color;
  };
  const names = new Set<string>();
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      const style = (rule as CSSStyleRule).style;
      if (style && /(^|,)\s*:root\s*($|,)/.test((rule as CSSStyleRule).selectorText ?? ''))
        for (let at = 0; at < style.length; at++)
          if (/^--(pal|stage)-/.test(style[at])) names.add(style[at]);
      if ((rule as CSSGroupingRule).cssRules) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of doc.styleSheets) {
    try {
      visit(sheet.cssRules);
    } catch {
      // A sheet the page may not read says nothing.
    }
  }
  const root = view.getComputedStyle(doc.documentElement);
  const palette = [...names].map((name) => ({
    name: name.slice(2),
    colour: resolve(root.getPropertyValue(name).trim()),
  }));
  probe.remove();
  const painted = (value: string) =>
    Boolean(value) &&
    value !== 'none' &&
    value !== 'transparent' &&
    !value.startsWith('url') &&
    !/rgba\(.*,\s*0\)$/.test(value);
  const grounds = [...doc.querySelectorAll('.art-ground')]
    .map((element) => ({
      label:
        element.textContent?.trim() ||
        element.closest('figure')?.querySelector('figcaption')?.textContent?.trim() ||
        element.getAttribute('data-layer') ||
        element.className.toString(),
      colour: view.getComputedStyle(element).backgroundColor,
    }))
    .filter((ground) => painted(ground.colour));
  if (!grounds.length) {
    let colour = view.getComputedStyle(doc.body).backgroundColor;
    if (!painted(colour)) colour = 'rgb(255, 255, 255)';
    grounds.push({ label: 'the page', colour });
  }
  const whole = (value: string | null) =>
    value === null || value === '' || Math.abs(Number(value) - Math.round(Number(value))) < 0.001;
  const sprites = [...doc.querySelectorAll('svg.art-sprite')].slice(0, 32).map((svg, index) => {
    const box = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
    const width = box[2] || 0;
    const height = box[3] || 0;
    const rect = svg.getBoundingClientRect();
    const set = svg.closest('.art-set');
    const colours = new Set<string>();
    const offGrid = new Set<string>();
    let translucent = false;
    for (const shape of svg.querySelectorAll(
      'path, rect, circle, ellipse, polygon, polyline, line',
    )) {
      const computed = view.getComputedStyle(shape);
      if (computed.display === 'none' || computed.visibility === 'hidden') continue;
      if (painted(computed.fill)) colours.add(computed.fill);
      if (painted(computed.stroke)) {
        colours.add(computed.stroke);
        offGrid.add('a stroke');
      }
      if (Number(computed.opacity) < 1 || Number(computed.fillOpacity) < 1) translucent = true;
      const tag = shape.tagName.toLowerCase();
      if (tag === 'circle' || tag === 'ellipse') offGrid.add(`a ${tag}`);
      else if (tag === 'rect') {
        if (!['x', 'y', 'width', 'height'].every((name) => whole(shape.getAttribute(name))))
          offGrid.add('a rect at a fraction of a pixel');
        if (shape.getAttribute('rx') || shape.getAttribute('ry')) offGrid.add('a rounded rect');
      } else if (tag === 'path') {
        const d = shape.getAttribute('d') ?? '';
        if (/[CcSsQqTtAa]/.test(d)) offGrid.add('a curve');
        else if (/\d\.\d*[1-9]/.test(d)) offGrid.add('a path at a fraction of a pixel');
      } else if (tag === 'polygon' || tag === 'polyline') {
        if (/\d\.\d*[1-9]/.test(shape.getAttribute('points') ?? ''))
          offGrid.add(`a ${tag} at a fraction of a pixel`);
      }
    }
    for (const moved of svg.querySelectorAll('[transform]'))
      if (
        !/^\s*translate\(\s*-?\d+(?:[\s,]+-?\d+)?\s*\)\s*$/.test(
          moved.getAttribute('transform') ?? '',
        )
      )
        offGrid.add('a transform that is not whole pixels');
    // The sprite alone: colours resolved, classes and styles dropped, one CSS px a pixel.
    const clone = svg.cloneNode(true) as SVGElement;
    const from = [svg, ...svg.querySelectorAll('*')];
    const to = [clone, ...clone.querySelectorAll('*')];
    to.forEach((node, at) => {
      const computed = view.getComputedStyle(from[at]);
      for (const name of [...node.getAttributeNames()])
        if (['class', 'style', 'role', 'aria-label'].includes(name) || name.startsWith('data-'))
          node.removeAttribute(name);
      if (at === 0) return;
      if (computed.display === 'none') {
        node.setAttribute('data-hidden', '');
        return;
      }
      if (node.tagName.toLowerCase() === 'g' || node.tagName.toLowerCase() === 'use') return;
      node.setAttribute('fill', computed.fill);
      if (painted(computed.stroke)) {
        node.setAttribute('stroke', computed.stroke);
        node.setAttribute('stroke-width', computed.strokeWidth);
      }
      if (computed.opacity !== '1') node.setAttribute('opacity', computed.opacity);
    });
    for (const node of [...clone.querySelectorAll('[data-hidden]')]) node.remove();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width || 16));
    clone.setAttribute('height', String(height || 16));
    clone.setAttribute('shape-rendering', 'crispEdges');
    return {
      name:
        svg.getAttribute('data-layer') || svg.getAttribute('aria-label') || `sprite ${index + 1}`,
      set:
        set?.getAttribute('data-layer') || set?.querySelector('h2, h3')?.textContent?.trim() || '',
      tile: svg.classList.contains('tile'),
      width,
      height,
      drawn: { width: rect.width, height: rect.height },
      colours: [...colours],
      offGrid: [...offGrid],
      translucent,
      svg: clone.outerHTML,
    };
  });
  return { tile, play, palette, grounds, sprites };
}

/** Runs in the page: only one sprite, at a size, on a ground, its pixels kept square. */
export function showSprite(
  svg: string,
  width: number,
  height: number,
  ground: string,
  doc: Document = document,
) {
  doc.body.innerHTML = '';
  doc.body.setAttribute('style', 'margin:0;background:' + ground);
  doc.documentElement.setAttribute('style', 'background:' + ground);
  const box = doc.createElement('div');
  box.setAttribute(
    'style',
    `position:fixed;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;background:${ground}`,
  );
  box.innerHTML = svg;
  const sprite = box.firstElementChild as SVGElement;
  sprite.setAttribute('width', String(width));
  sprite.setAttribute('height', String(height));
  sprite.setAttribute('style', 'display:block;image-rendering:pixelated');
  doc.body.append(box);
}

/**
 * A sprite sheet's sprites, each drawn alone at play size (the tile at play= px) on each ground it
 * is played on, at 1:1. Null when the board has no sprites.
 */
export async function drawSprites(tab: DrawingTab): Promise<ArtSheet | null> {
  const read = await tab.evaluate<Omit<ArtSheet, 'sprites'> & { sprites: ArtSprite[] }>(
    run(readSprites),
  );
  if (!read?.sprites?.length) return read ? { ...read, sprites: [] } : null;
  const zoom = read.play / read.tile;
  const sprites: ArtSheet['sprites'] = [];
  for (const [index, sprite] of read.sprites.entries()) {
    const renders: ArtSheet['sprites'][number]['renders'] = [];
    const width = Math.max(1, Math.round((sprite.width || read.tile) * zoom));
    const height = Math.max(1, Math.round((sprite.height || read.tile) * zoom));
    // Past 24 sprites or 4 grounds the sheet is a library: the first ones say enough.
    if (index < 24)
      for (const ground of read.grounds.slice(0, 4)) {
        await tab.evaluate(run(showSprite, sprite.svg, width, height, ground.colour));
        renders.push({
          ground: ground.label,
          colour: ground.colour,
          png: await tab.screenshot({ clip: { x: 0, y: 0, width, height } }),
        });
      }
    sprites.push({ ...sprite, renders });
  }
  return { ...read, sprites };
}

/** Runs in the page: only the mark, at a size, in a box, on a ground; nothing else. */
export function showMark(
  svg: string,
  size: number,
  ground: string,
  options: { ink?: string; radius?: number; inset?: number } = {},
  doc: Document = document,
) {
  doc.body.innerHTML = '';
  doc.body.setAttribute('style', 'margin:0;background:' + ground);
  doc.documentElement.setAttribute('style', 'background:' + ground);
  const box = doc.createElement('div');
  const inset = options.inset ?? 0;
  box.setAttribute(
    'style',
    `position:fixed;left:0;top:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;overflow:hidden;box-sizing:border-box;background:${options.ink ?? ground};border-radius:${options.radius ?? 0}px${options.radius ? ';box-shadow:inset 0 0 0 1px rgba(128,128,128,.45)' : ''}`,
  );
  box.innerHTML = svg;
  const mark = box.firstElementChild as SVGElement;
  const inner = Math.max(1, size - inset * 2);
  mark.setAttribute('width', String(inner));
  mark.setAttribute('height', String(inner));
  mark.setAttribute('style', 'display:block;flex:none');
  doc.body.append(box);
}

const run = (fn: (...args: any[]) => unknown, ...args: unknown[]) =>
  `(${fn.toString()})(${args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg))).join(', ')})`;

export type BoardShot = {
  png: Buffer;
  measured: Overflow | null;
  inspected: Inspection | null;
  questions?: BoardQuestion[];
  /** A document's printed sheets, one picture each (the browser's print path), when asked for. */
  pages?: Buffer[];
  /** The headings that end a printed sheet with nothing after them on it. */
  stranded?: StrandedHeading[];
  /** A logo's mark rendered from the mark itself at each size, when asked for. */
  marks?: LogoMarks | null;
  /** The labelled grounds of a logo board, to compare between schemes. */
  grounds?: LogoGround[];
  /** A sprite sheet's palette, grounds and sprites, each drawn at play size, when asked for. */
  art?: ArtSheet | null;
  /** A model board's model, its box and budget and what its build measured, when asked for. */
  model?: ModelSheet | null;
};

/**
 * One drawing: the page in a scheme (dark as the design system and the page's own colour scheme
 * both see it), measured for what leaves the page when `measure`, inspected for the other checks
 * when `inspect`, then pictured with its questions marked. With `printed` a document is also
 * printed (white paper, its @page size and margins, running header and footer, page breaks) and
 * each sheet pictured; with `logo` the mark is drawn from the mark itself at true size.
 */
export async function shootBoard(
  tab: DrawingTab,
  page: string,
  options: {
    scheme: 'light' | 'dark';
    measure: boolean;
    inspect?: boolean;
    fullPage?: boolean;
    printed?: { paperWidth: number; paperHeight: number };
    logo?: boolean;
    art?: boolean;
    model?: boolean;
  },
): Promise<BoardShot> {
  await tab.setContent(page);
  if (options.scheme === 'dark')
    await tab.evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
  await tab.evaluate('document.fonts.ready.then(() => true)');
  const measured = options.measure ? await tab.evaluate<Overflow>(run(measureOverflow)) : null;
  const inspected = options.inspect ? await tab.evaluate<Inspection>(run(inspectBoard)) : null;
  const questions = /data-questions?=/.test(page)
    ? await tab.evaluate<BoardQuestion[]>(run(markQuestions))
    : [];
  // A model's box over each of its pictures, so a review sees what it must fit.
  const model = options.model ? await tab.evaluate<ModelSheet | null>(run(frameModel)) : undefined;
  const png = await tab.screenshot(options.fullPage ? { fullPage: true } : undefined);
  const shot: BoardShot = { png, measured, inspected, questions };
  if (model !== undefined) shot.model = model;
  if (options.logo) {
    shot.grounds = await tab.evaluate<LogoGround[]>(run(readGrounds));
    shot.marks = await drawMarks(tab);
  }
  // Last: drawing each sprite alone replaces the page.
  if (options.art) shot.art = await drawSprites(tab);
  if (options.printed && tab.printedPages) {
    // After the picture and the measuring: printing changes the page, so it comes last.
    // The numbered badges are for the screen picture; paper has none.
    await tab.evaluate(
      "document.querySelectorAll('[data-check-marks]').forEach((node) => node.remove())",
    );
    await tab.evaluate(run(whitePaper));
    const pages = await tab.printedPages({ ...options.printed, scale: 1 });
    if (pages?.length) {
      shot.pages = pages;
      shot.png = pages[0];
      await tab.evaluate(run(probeHeadings));
      const probe = await tab.printedPages({ ...options.printed, scale: 1 });
      if (probe?.length === pages.length) {
        try {
          shot.stranded = headingsEndingPages(probe);
        } catch {
          // A picture that cannot be read says nothing about breaks.
        }
      }
    }
  }
  return shot;
}

/**
 * A logo's mark drawn at each size from the mark itself (never the artboard shrunk): the SVG is
 * put alone in a box of that many CSS px and the box is pictured at 1:1. Also the app icon
 * (a rounded square, the mark in the ground on the ink and the mark in the ink on the ground)
 * and the favicon sizes. Null when the board has no SVG mark.
 */
export async function drawMarks(tab: DrawingTab): Promise<LogoMarks | null> {
  const mark = await tab.evaluate<{
    svg: string;
    small: string | null;
    ground: string;
    ink: string;
  } | null>(run(readMark));
  if (!mark) return null;
  const crop = async (
    size: number,
    options: { ink?: string; radius?: number; inset?: number } = {},
    ground = mark.ground,
    svg = mark.svg,
  ) => {
    await tab.evaluate(run(showMark, svg, size, ground, options));
    return tab.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
  };
  const sizes: LogoMarks['sizes'] = [];
  const cutFor = (size: number) => (size <= 32 && mark.small) || mark.svg;
  for (const size of logoMarkSizes)
    sizes.push({ size, png: await crop(size, {}, mark.ground, cutFor(size)) });
  const smallReference = mark.small ? await crop(128, {}, mark.ground, mark.small) : undefined;
  const icons: LogoMarks['icons'] = [];
  for (const size of [120, 60]) {
    // Light: the mark in its ink on the ground, in a rounded square; dark: the reverse.
    const radius = Math.round(size * 0.2237);
    icons.push({
      tone: 'light',
      size,
      png: await crop(size, { radius, inset: Math.round(size * 0.16), ink: mark.ground }),
    });
    await tab.evaluate(
      run(showMark, mark.svg.replace(/fill="[^"]*"/g, `fill="${mark.ground}"`), size, mark.ground, {
        radius,
        inset: Math.round(size * 0.16),
        ink: mark.ink,
      }),
    );
    icons.push({
      tone: 'dark',
      size,
      png: await tab.screenshot({ clip: { x: 0, y: 0, width: size, height: size } }),
    });
  }
  return { svg: mark.svg, ground: mark.ground, ink: mark.ink, sizes, icons, smallReference };
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!,
  );

const dataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

/** A tall render as the pages it prints on, side by side, three to a row. */
function pagesFigure(png: Buffer, layout: Extract<PairLayout, { kind: 'pages' }>, id: string) {
  const { height } = pngSize(png);
  const margin = layout.margin ?? { top: 0, right: 0, bottom: 0, left: 0 };
  // The text is drawn as wide as a sheet's text area; each sheet shows the next stretch of it.
  const room = Math.max(1, layout.pageHeight - margin.top - margin.bottom);
  const count = Math.max(1, Math.ceil(height / room));
  const tiles = Array.from(
    { length: count },
    (_, at) =>
      `<div class="pg"><div class="sheet-page" style="width:${layout.pageWidth}px;height:${layout.pageHeight}px"><div class="${id}" style="left:${margin.left}px;top:${margin.top}px;width:${Math.max(1, layout.pageWidth - margin.left - margin.right)}px;height:${Math.min(room, height - at * room)}px;background-position:0 -${at * room}px"></div></div><span>Page ${at + 1} of ${count}</span></div>`,
  ).join('');
  return `<style>.${id}{position:absolute;background:url(${dataUri(png)}) no-repeat}</style><div class="pages" style="grid-template-columns:repeat(${Math.min(count, 3)},max-content)">${tiles}</div>`;
}

/** The printed sheets themselves, white paper side by side, three to a row. */
function sheetsFigure(pages: Buffer[], scale = 1) {
  const tiles = pages
    .map((png, at) => {
      const { width, height } = pngSize(png);
      return `<div class="pg"><img class="paper" src="${dataUri(png)}" width="${Math.round(width / scale)}" height="${Math.round(height / scale)}" style="background:#fff"><span>Page ${at + 1} of ${pages.length}</span></div>`;
    })
    .join('');
  return `<div class="pages" style="grid-template-columns:repeat(${Math.min(pages.length, 3)},max-content)">${tiles}</div>`;
}

/** A print piece with its trim and safe marks in the margin around it, never over it. */
function printFigure(png: Buffer, layout: Extract<PairLayout, { kind: 'print' }>) {
  const { width, height } = pngSize(png);
  const margin = 32;
  const k = layout.pxPerMm;
  const xs = (offset: number) => [margin + offset * k, margin + width - offset * k];
  const ys = (offset: number) => [margin + offset * k, margin + height - offset * k];
  const line = (x1: number, y1: number, x2: number, y2: number, safe: boolean) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${safe ? '#2f5bb7' : '#18181b'}" stroke-width="1"${safe ? ' stroke-dasharray="3 2"' : ''}/>`;
  const marks: string[] = [];
  // Trim: crop marks, from just outside the picture's edge, along the trim lines.
  for (const x of xs(layout.bleed)) {
    marks.push(line(x, margin - 22, x, margin - 4, false));
    marks.push(line(x, margin + height + 4, x, margin + height + 22, false));
  }
  for (const y of ys(layout.bleed)) {
    marks.push(line(margin - 22, y, margin - 4, y, false));
    marks.push(line(margin + width + 4, y, margin + width + 22, y, false));
  }
  // Safe: shorter dashed ticks beside them.
  for (const x of xs(layout.bleed + layout.safe)) {
    marks.push(line(x, margin - 12, x, margin - 4, true));
    marks.push(line(x, margin + height + 4, x, margin + height + 12, true));
  }
  for (const y of ys(layout.bleed + layout.safe)) {
    marks.push(line(margin - 12, y, margin - 4, y, true));
    marks.push(line(margin + width + 4, y, margin + width + 12, y, true));
  }
  return (
    `<div style="position:relative;width:${width + 2 * margin}px;height:${height + 2 * margin}px">` +
    `<img src="${dataUri(png)}" style="position:absolute;left:${margin}px;top:${margin}px;width:${width}px;height:${height}px;border:0;outline:1px solid #888">` +
    `<svg width="${width + 2 * margin}" height="${height + 2 * margin}" style="position:absolute;left:0;top:0">${marks.join('')}</svg></div>` +
    `<p class="legend">${layout.trim.w}×${layout.trim.h} mm trim (solid marks) · ${layout.bleed} mm bleed (the picture's edge) · ${layout.safe} mm safe, inside the trim (dashed marks) · ${layout.pxPerMm} px/mm</p>`
  );
}

/** The mark's pictures as an image of a size, pixel for pixel or magnified without smoothing. */
const markImage = (png: Buffer, size: number, shown = size) =>
  `<img src="${dataUri(png)}" width="${shown}" height="${shown}" style="border:0;image-rendering:${shown > size ? 'pixelated' : 'auto'};display:block">`;

/**
 * A mark at the sizes it is used at. With the mark drawn from itself: each size at true pixel
 * size (1:1, 512 shown at a quarter), the small ones magnified eight times beside it so a
 * reviewer can see what survives, the app icon rounded on light and on dark, and the favicon
 * sizes. Without it (a mark that is no SVG), the whole picture shrunk to each size.
 */
/**
 * A sprite sheet as drawn, then every sprite at play size, 1:1, on each ground it is played on
 * (one row a ground), and the tiles at play size: what a player sees, not the sheet's zoom.
 */
function artFigure(
  png: Buffer,
  layout: Extract<PairLayout, { kind: 'art' }>,
  art?: ArtSheet | null,
) {
  const board = `<div class="row" data-row="board"><img src="${dataUri(png)}" style="width:720px;height:auto"></div>`;
  if (!art?.sprites.length) return `<div class="sheet">${board}</div>`;
  const pixels = (entry: Buffer) => {
    const { width, height } = pngSize(entry);
    return `<img src="${dataUri(entry)}" width="${width}" height="${height}" style="border:0;image-rendering:pixelated">`;
  };
  const characters = art.sprites.filter((sprite) => !sprite.tile && sprite.renders.length);
  const tiles = art.sprites.filter((sprite) => sprite.tile && sprite.renders.length);
  const rows = art.grounds.slice(0, 4).map((ground, at) => {
    const cells = characters
      .map((sprite) => {
        const render = sprite.renders[at];
        return render
          ? `<figure><div class="chip" style="background:${render.colour}">${pixels(render.png)}</div><figcaption>${escapeHtml(sprite.name)}</figcaption></figure>`
          : '';
      })
      .join('');
    return cells
      ? `<div class="row" data-row="ground"><p class="legend" style="width:120px">On ${escapeHtml(ground.label)}, at play size</p>${cells}</div>`
      : '';
  });
  const tileRow = tiles.length
    ? `<div class="row" data-row="tiles"><p class="legend" style="width:120px">Tiles at play size</p>${tiles
        .map(
          (sprite) =>
            `<figure>${pixels(sprite.renders[0].png)}<figcaption>${escapeHtml(sprite.name)}</figcaption></figure>`,
        )
        .join('')}</div>`
    : '';
  return `<div class="sheet">${board}<p class="legend">${layout.tile} px tile at ${layout.play} px in play</p>${rows.join('')}${tileRow}</div>`;
}

function sheetFigure(
  png: Buffer,
  layout: Extract<PairLayout, { kind: 'sheet' }>,
  marks?: LogoMarks | null,
) {
  if (!marks)
    return `<div class="sheet">${layout.sizes
      .map(
        (size) =>
          `<figure><img src="${dataUri(png)}" width="${size}" height="${size}" style="border:0"><figcaption>${size} px</figcaption></figure>`,
      )
      .join('')}</div>`;
  const ground = `background:${marks.ground}`;
  const cell = (size: number, shown: number, note: string, label = `${size} px`) => {
    const entry = marks.sizes.find((candidate) => candidate.size === size);
    return entry
      ? `<figure><div class="chip" style="${ground}">${markImage(entry.png, size, shown)}</div><figcaption>${label}${note ? ` · ${note}` : ''}</figcaption></figure>`
      : '';
  };
  const small = marks.sizes.filter((entry) => entry.size <= 32);
  const icons = marks.icons
    .map(
      (entry) =>
        `<figure><div class="chip" style="${ground}">${markImage(entry.png, entry.size)}</div><figcaption>App icon, ${entry.tone}, ${entry.size} px</figcaption></figure>`,
    )
    .join('');
  const favicons = [16, 32].map((size) => cell(size, size, '', `Favicon ${size} px`)).join('');
  // The board itself first, as drawn (its lockups, tiles and notes), then the mark at its sizes.
  return (
    `<div class="sheet"><div class="row" data-row="board"><img src="${dataUri(png)}" style="width:720px;height:auto"></div><div class="row" data-row="sizes">${[
      cell(512, 256, 'shown at half'),
      cell(128, 128, '1:1'),
      cell(64, 64, '1:1'),
      ...layout.sizes.filter((size) => size <= 32).map((size) => cell(size, size, '1:1')),
    ].join('')}</div>` +
    `<div class="row" data-row="enlarged">${small
      .map((entry) => cell(entry.size, entry.size * 8, '', `${entry.size} px, enlarged 8×`))
      .join('')}</div>` +
    `<div class="row" data-row="icons">${icons}${favicons}</div></div>`
  );
}

/** Before beside After, captioned, as one page to picture in full. A new board has only an After. */
export function pairPage(input: {
  before: Buffer | null;
  after: Buffer;
  width: number;
  scheme: 'light' | 'dark';
  /** The After's questions, listed under it by their badges' numbers. */
  questions?: BoardQuestion[];
  /** How the picture is laid out when it is more than a screen: pages, a print piece, a sheet. */
  layout?: PairLayout;
  /** A document's printed sheets, as the browser printed them (Before and After). */
  beforePages?: Buffer[];
  afterPages?: Buffer[];
  /** A logo's mark drawn from the mark itself (Before and After). */
  beforeMarks?: LogoMarks | null;
  afterMarks?: LogoMarks | null;
  /** A sprite sheet's sprites at play size (Before and After). */
  beforeArt?: ArtSheet | null;
  afterArt?: ArtSheet | null;
  /** Captions in place of Before and After: a print proof's Front and Back. */
  labels?: { before: string; after: string };
}) {
  const { before, after, width, scheme, layout } = input;
  const questions = input.questions?.length
    ? `<ol class="q">${input.questions.map((entry) => `<li value="${entry.n}">${escapeHtml(entry.question)}${entry.layer ? ` <span>${escapeHtml(entry.layer)}</span>` : ''}</li>`).join('')}</ol>`
    : '';
  const image = (png: Buffer, id: string) =>
    layout?.kind === 'pages'
      ? (id === 'pgA' ? input.beforePages : input.afterPages)?.length
        ? sheetsFigure((id === 'pgA' ? input.beforePages : input.afterPages)!)
        : pagesFigure(png, layout, id)
      : layout?.kind === 'print'
        ? printFigure(png, layout)
        : layout?.kind === 'sheet'
          ? sheetFigure(png, layout, id === 'pgA' ? input.beforeMarks : input.afterMarks)
          : layout?.kind === 'art'
            ? artFigure(png, layout, id === 'pgA' ? input.beforeArt : input.afterArt)
            : `<img src="${dataUri(png)}">`;
  const caption = (label: string) => `${label} · ${width} · ${scheme}`;
  return (
    `<style>body{margin:0;display:flex;gap:16px;padding:16px;align-items:flex-start;font:13px system-ui;background:${scheme === 'dark' ? '#18181b' : '#f4f4f5'};color:${scheme === 'dark' ? '#fafafa' : '#18181b'}}figure{margin:0}figcaption{margin-bottom:8px}img{display:block;border:1px solid #888}p{width:${width}px}ol.q{margin:12px 0 0;padding:0 0 0 24px;width:${Math.max(240, width - 24)}px;line-height:20px}ol.q li::marker{color:#2f5bb7;font-weight:600}ol.q span{opacity:.6}.pages{display:grid;gap:16px}.sheet-page{position:relative;background:#fff;border:1px solid #888;box-sizing:content-box;overflow:hidden}.pg span{display:block;margin-top:4px;opacity:.6}.legend{margin:8px 0 0;width:auto;opacity:.7}.sheet{display:flex;flex-direction:column;gap:20px;padding:12px}.sheet .row{display:flex;align-items:flex-end;gap:24px;flex-wrap:wrap}.chip{display:inline-block;padding:12px;border:1px solid #8886}.paper{border:1px solid #888;background:#fff}.sheet figure{display:flex;flex-direction:column;gap:6px;align-items:flex-start}.sheet figcaption{margin:0;opacity:.6}</style>` +
    (before
      ? `<figure><figcaption>${caption(input.labels?.before ?? 'Before · main')}</figcaption>${image(before, 'pgA')}</figure>`
      : '') +
    `<figure><figcaption>${caption(input.labels?.after ?? (before ? 'After · this branch' : 'This branch · not on main yet'))}</figcaption>${image(after, 'pgB')}${questions}</figure>`
  );
}

const fontLink =
  /<link\s+rel="stylesheet"\s+href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"\s*\/?>/g;
const preconnect =
  /<link\s+rel="preconnect"\s+href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>/g;
// Google serves woff2 to a browser it knows.
const fontAgent =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/**
 * The design system's web fonts, put into the page as data and kept on disk, so every drawing on
 * this computer measures text with the same font, online or not. A font that never downloaded
 * leaves the page's fallback, and `missing` says which.
 */
export async function inlineWebFonts(
  page: string,
  options: { cache: string; fetch?: typeof fetch; known?: Map<string, string> },
) {
  const missing: string[] = [];
  const known = options.known ?? new Map<string, string>();
  const get = options.fetch ?? fetch;
  let out = page.replace(preconnect, '');
  for (const match of [...out.matchAll(fontLink)]) {
    const href = match[1].replace(/&amp;/g, '&');
    let css = known.get(href) ?? null;
    const file = join(
      options.cache,
      `${createHash('sha256').update(href).digest('hex').slice(0, 24)}.css`,
    );
    if (css === null && existsSync(file)) css = readFileSync(file, 'utf8');
    if (css === null)
      try {
        const sheet = await get(href, { headers: { 'User-Agent': fontAgent } });
        if (!sheet.ok) throw new Error(String(sheet.status));
        let text = await sheet.text();
        for (const url of new Set(
          [...text.matchAll(/url\((https:\/\/[^)]+)\)/g)].map((m) => m[1]),
        )) {
          const font = await get(url);
          if (!font.ok) throw new Error(String(font.status));
          const bytes = Buffer.from(await font.arrayBuffer());
          text = text.replaceAll(url, `data:font/woff2;base64,${bytes.toString('base64')}`);
        }
        mkdirSync(options.cache, { recursive: true });
        writeFileSync(file, text);
        css = text;
      } catch {
        css = null;
      }
    if (css === null) missing.push(href);
    else known.set(href, css);
    out = out.replace(match[0], () => (css === null ? '' : `<style>${css}</style>`));
  }
  return { page: out, missing };
}
