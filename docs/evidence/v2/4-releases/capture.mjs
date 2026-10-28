// Run with fixture.mjs on 5195 and isolated Vite on 5196.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const root = resolve(import.meta.dirname, 'captures');
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const [board, route, height] of [
    ['Deployments', 'deploy.local/releases/2a91c0e', 900],
    ['ReleaseLive', 'deploy.local/releases/7f3b2d4', 900],
    ['ReleaseFailed', 'home-gym/releases/b81e4c0', 900],
    ['AutoRollback', 'home-gym/releases/9c3e1fa', 1100],
  ]) {
    for (const width of [1440, 700]) {
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:5196/dashboard/projects/${route}`);
      await page.getByRole('region', { name: 'Release detail' }).waitFor();
      await page.screenshot({ path: resolve(root, `${board}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
} finally {
  await browser.close();
}
