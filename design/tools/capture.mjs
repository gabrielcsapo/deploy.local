// Capture a page at the board widths with headless Playwright Chromium, for parity evidence.
//   node design/tools/capture.mjs <url> <out-prefix> [widths=1440,700] [height=1000] [--dark]
// Writes <out-prefix>-<width>.png. Run from a checkout with node_modules installed.
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
const dark = args.includes('--dark');
const [url, out, widths = '1440,700', height = '1000'] = args.filter((a) => a !== '--dark');
const { chromium } = createRequire(process.cwd() + '/')('playwright');
const browser = await chromium.launch();
for (const width of widths.split(',').map(Number)) {
  const page = await browser.newPage({
    viewport: { width, height: Number(height) },
    colorScheme: dark ? 'dark' : 'light',
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Pages keep a long-poll open, so wait a fixed time instead of for network idle.
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}-${width}.png` });
  await page.close();
}
await browser.close();
