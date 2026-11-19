// deploy design capture: the running app, screenshotted at a board's widths with a local Chromium.
// Playwright stays outside the CLI bundle (see scripts/build-cli.mjs), so it is found the way
// `deploy browser install` finds it: beside the CLI, or in the folder it runs in.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { isSea } from 'node:sea';

/** Playwright's Chromium, or null when it is not installed here. */
export function localChromium(cwd = process.cwd()) {
  const places = isSea() ? [resolve(cwd, 'package.json')] : [import.meta.url];
  for (const place of places)
    try {
      const { chromium } = createRequire(place)('playwright');
      if (existsSync(chromium.executablePath())) return chromium;
    } catch {
      /* Not installed there. */
    }
  return null;
}

/**
 * One PNG per width, each the size of the board, or null when there is no Chromium here.
 * The page loads, then gets a moment to draw: apps keep requests open, so there is no idle.
 */
export async function captureRunningApp(url, widths, height, chromium = localChromium()) {
  if (!chromium) return null;
  const browser = await chromium.launch();
  try {
    const pictures = [];
    for (const width of widths) {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(750);
        pictures.push(await page.screenshot());
      } finally {
        await page.close();
      }
    }
    return pictures;
  } finally {
    await browser.close();
  }
}
