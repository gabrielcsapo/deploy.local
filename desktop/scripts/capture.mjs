import { chromium } from '../../node_modules/playwright/index.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
await import('./evidence.mjs');
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = resolve(root, 'docs/evidence/v2/13-desktop');
await mkdir(resolve(evidence, 'captures'), { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const board of [
    'Setup',
    'SetupLinux',
    'Permissions',
    'Offline',
    'Tray',
    'ScreenAsk',
    'ScreenWatch',
  ]) {
    for (const width of [1440, 700]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        colorScheme: 'light',
      });
      await page.goto(`file://${evidence}/previews/${board}.html`);
      await page.evaluate(() => document.fonts.ready);
      const capture = resolve(evidence, `captures/${board}-${width}.png`);
      await page.screenshot({ path: capture, fullPage: true });
      await page.close();
      const result = spawnSync(
        'uv',
        [
          'run',
          '--no-project',
          '--python',
          '3.13',
          '--with',
          'pillow',
          'python',
          resolve(root, 'design/v2/tools/pair.py'),
          resolve(evidence, `${board}-${width}.png`),
          resolve(root, `design/v2/canvas/png/${board}-${width}.png`),
          capture,
        ],
        { stdio: 'inherit' },
      );
      if (result.status !== 0) throw new Error(`Pairing ${board} failed`);
    }
  }
} finally {
  await browser.close();
}
