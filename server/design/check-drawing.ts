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
  for (const match of page.matchAll(/<link rel="stylesheet" href="\.\.\/(ds\/[^"]+\.css)">/g)) {
    const css = await sources.css(match[1]);
    page = page.replace(match[0], () => `<style>${css?.toString() ?? ''}</style>`);
  }
  return inlineBoardCaptures(page, sources.capture);
}

/**
 * A layer that asks a question is drawn with a dashed outline and the question under it. Added
 * after measuring, so the question never counts as the board's own content.
 */
export const questionStyle = `[data-question]{outline:2px dashed #2f5bb7!important;outline-offset:2px}
[data-question]::after{content:"? " attr(data-question);display:block;width:max-content;max-width:min(320px,90vw);margin-top:6px;padding:4px 8px;border-radius:6px;background:#e6eefc;color:#1f3a7a;font:500 12px/16px system-ui,sans-serif;white-space:normal;text-align:left}`;

const run = (fn: (...args: any[]) => unknown) => `(${fn.toString()})()`;

export type BoardShot = { png: Buffer; measured: Overflow | null; inspected: Inspection | null };

/**
 * One drawing: the page in a scheme (dark as the design system and the page's own colour scheme
 * both see it), measured for what leaves the page when `measure`, inspected for the other checks
 * when `inspect`, then pictured with any questions shown.
 */
export async function shootBoard(
  tab: DrawingTab,
  page: string,
  options: { scheme: 'light' | 'dark'; measure: boolean; inspect?: boolean },
): Promise<BoardShot> {
  await tab.setContent(page);
  if (options.scheme === 'dark')
    await tab.evaluate("document.documentElement.setAttribute('data-theme', 'dark')");
  await tab.evaluate('document.fonts.ready.then(() => true)');
  const measured = options.measure ? await tab.evaluate<Overflow>(run(measureOverflow)) : null;
  const inspected = options.inspect ? await tab.evaluate<Inspection>(run(inspectBoard)) : null;
  if (page.includes('data-question='))
    await tab.evaluate(
      `(() => { const style = document.createElement('style'); style.textContent = ${JSON.stringify(questionStyle)}; document.head.append(style); return true; })()`,
    );
  return { png: await tab.screenshot(), measured, inspected };
}

/** Before beside After, captioned, as one page to picture in full. */
export function pairPage(input: {
  before: Buffer | null;
  after: Buffer;
  width: number;
  scheme: 'light' | 'dark';
}) {
  const { before, after, width, scheme } = input;
  const image = (png: Buffer | null) =>
    png
      ? `<img src="data:image/png;base64,${png.toString('base64')}">`
      : '<p>New board · no Before</p>';
  return (
    `<style>body{margin:0;display:flex;gap:16px;padding:16px;font:13px system-ui;background:${scheme === 'dark' ? '#18181b' : '#f4f4f5'};color:${scheme === 'dark' ? '#fafafa' : '#18181b'}}figure{margin:0}figcaption{margin-bottom:8px}img{display:block;border:1px solid #888}p{width:${width}px}</style>` +
    `<figure><figcaption>Before · main · ${width} · ${scheme}</figcaption>${image(before)}</figure>` +
    `<figure><figcaption>After · this branch · ${width} · ${scheme}</figcaption>${image(after)}</figure>`
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
