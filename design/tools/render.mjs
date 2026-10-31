// Render boards from design/boards to PNG with headless Playwright Chromium.
//   node design/tools/render.mjs [Board ...]
// Web boards render at 1440 and 700 px, phone boards at their own width, into
// output/design/<Board>-<width>.png. With no names, every board on the canvas renders.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const canvas = JSON.parse(readFileSync(resolve(root, 'design/canvas.json'), 'utf8'));
const names = process.argv.slice(2);
const boards = Object.entries(canvas.boards).filter(
  ([file]) => names.length === 0 || names.includes(file.replace(/\.html$/, '')),
);
if (boards.length === 0) {
  console.error(`No boards named ${names.join(', ')} in design/canvas.json.`);
  process.exit(1);
}
const out = resolve(root, 'output/design');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(`${root}/`)('playwright');
const browser = await chromium.launch();
try {
  for (const [file, board] of boards) {
    const widths = board.w <= 500 ? [board.w] : [1440, 700];
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height: board.h } });
      await page.goto(pathToFileURL(resolve(root, 'design/boards', file)).href);
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: resolve(out, `${file.replace(/\.html$/, '')}-${width}.png`) });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`Rendered ${boards.length} board${boards.length === 1 ? '' : 's'} into output/design.`);
