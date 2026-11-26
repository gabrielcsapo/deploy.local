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
import { pngSize } from './kind-checks.ts';

/** A browser tab, as either driver gives it. */
export type DrawingTab = {
  setContent(html: string): Promise<void>;
  /** A JavaScript expression run in the page; a promise it returns is awaited. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
};

/** Where a board's page gets what it links to, at one commit (or the working copy). */
export type BoardSources = {
  library(): Promise<Library | null>;
  /** A design-system file by its path under design/, like ds/deploy-local/tokens.css. */
  css(path: string): Promise<Buffer | null>;
  /** A picture in boards/captures, by its path under boards/. */
  capture(path: string): Promise<Buffer | null>;
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
  // A design system stylesheet beside the board, however the tag is written (a formatter
  // writes <link … />).
  for (const match of page.matchAll(
    /<link\b(?=[^>]*\srel="stylesheet")[^>]*\shref="\.\.\/(ds\/[^"]+\.css)"[^>]*>/g,
  )) {
    const css = await sources.css(match[1]);
    page = page.replace(match[0], () => `<style>${css?.toString() ?? ''}</style>`);
  }
  return inlineBoardCaptures(page, sources.capture);
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

const run = (fn: (...args: any[]) => unknown) => `(${fn.toString()})()`;

export type BoardShot = {
  png: Buffer;
  measured: Overflow | null;
  inspected: Inspection | null;
  questions?: BoardQuestion[];
};

/**
 * One drawing: the page in a scheme (dark as the design system and the page's own colour scheme
 * both see it), measured for what leaves the page when `measure`, inspected for the other checks
 * when `inspect`, then pictured with its questions marked.
 */
export async function shootBoard(
  tab: DrawingTab,
  page: string,
  options: { scheme: 'light' | 'dark'; measure: boolean; inspect?: boolean; fullPage?: boolean },
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
  return {
    png: await tab.screenshot(options.fullPage ? { fullPage: true } : undefined),
    measured,
    inspected,
    questions,
  };
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

/** A mark at the sizes it is used at, side by side on the drawn ground. */
function sheetFigure(png: Buffer, layout: Extract<PairLayout, { kind: 'sheet' }>) {
  return `<div class="sheet">${layout.sizes
    .map(
      (size) =>
        `<figure><img src="${dataUri(png)}" width="${size}" height="${size}" style="border:0"><figcaption>${size} px</figcaption></figure>`,
    )
    .join('')}</div>`;
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
}) {
  const { before, after, width, scheme, layout } = input;
  const questions = input.questions?.length
    ? `<ol class="q">${input.questions.map((entry) => `<li value="${entry.n}">${escapeHtml(entry.question)}${entry.layer ? ` <span>${escapeHtml(entry.layer)}</span>` : ''}</li>`).join('')}</ol>`
    : '';
  const image = (png: Buffer, id: string) =>
    layout?.kind === 'pages'
      ? pagesFigure(png, layout, id)
      : layout?.kind === 'print'
        ? printFigure(png, layout)
        : layout?.kind === 'sheet'
          ? sheetFigure(png, layout)
          : `<img src="${dataUri(png)}">`;
  const caption = (label: string) => `${label} · ${width} · ${scheme}`;
  return (
    `<style>body{margin:0;display:flex;gap:16px;padding:16px;align-items:flex-start;font:13px system-ui;background:${scheme === 'dark' ? '#18181b' : '#f4f4f5'};color:${scheme === 'dark' ? '#fafafa' : '#18181b'}}figure{margin:0}figcaption{margin-bottom:8px}img{display:block;border:1px solid #888}p{width:${width}px}ol.q{margin:12px 0 0;padding:0 0 0 24px;width:${Math.max(240, width - 24)}px;line-height:20px}ol.q li::marker{color:#2f5bb7;font-weight:600}ol.q span{opacity:.6}.pages{display:grid;gap:16px}.sheet-page{position:relative;background:#fff;border:1px solid #888;box-sizing:content-box;overflow:hidden}.pg span{display:block;margin-top:4px;opacity:.6}.legend{margin:8px 0 0;width:auto;opacity:.7}.sheet{display:flex;align-items:flex-end;gap:24px;padding:12px}.sheet figure{display:flex;flex-direction:column;gap:6px;align-items:flex-start}.sheet figcaption{margin:0;opacity:.6}</style>` +
    (before
      ? `<figure><figcaption>${caption('Before · main')}</figcaption>${image(before, 'pgA')}</figure>`
      : '') +
    `<figure><figcaption>${caption(before ? 'After · this branch' : 'New board')}</figcaption>${image(after, 'pgB')}${questions}</figure>`
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
