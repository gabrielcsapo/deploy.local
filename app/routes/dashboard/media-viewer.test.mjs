import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { resolve } from 'node:path';

// Isolated test fixtures; no coordinator, account, or task data is modified.
const attachments = Array.from({ length: 8 }, (_, index) => ({
  id: `image-${index}`,
  taskId: 'viewer-test',
  runId: `run-${index}`,
  kind: 'image',
  mimeType: 'image/svg+xml',
  size: 0,
  name: `Picture ${index + 1}`,
  caption: `Caption ${index + 1}`,
  source: 'test',
  createdAt: `2026-10-23T00:00:0${index}Z`,
}));
const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {AttachmentStrip} from './app/routes/dashboard/attachments.client.tsx';
import './app/design-tokens.css';
import './app/motion.css';
import './app/components/ui/ui.css';
import './app/routes/dashboard/attachments.css';
if (location.search === '?lazy') document.getElementById('root').className = 'lazy';
createRoot(document.getElementById('root')).render(React.createElement(AttachmentStrip, {rows: location.search === '?single' ? ${JSON.stringify(attachments)}.slice(0, 1) : ${JSON.stringify(attachments)}}));
`;

test('media modal keyboard, filmstrip, counter, dismissal, focus and zoom at desktop and phone widths', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'media-viewer-test',
        resolveId(id) {
          if (id === 'media-viewer-test') return resolve('media-viewer-test.tsx');
        },
        load(id) {
          if (id === resolve('media-viewer-test.tsx')) return entry;
        },
      },
    ],
    build: { write: false, rollupOptions: { input: 'media-viewer-test' } },
  });
  const output = bundle.output;
  const script = output.find((item) => item.type === 'chunk').code;
  const css = output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css} #root.lazy .pw-media-strip { flex-direction: column; gap: 1200px; }</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const width of [1440, 390]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: 'reduce',
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/workspace/attachments/**', (route) =>
        route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="blue"/></svg>',
        }),
      );
      await page.route('http://media-viewer.test/', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://media-viewer.test/');
      const opener = page.getByRole('button', { name: 'Open Caption 3', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Media viewer', exact: true });
      await dialog.waitFor();
      const counter = dialog.locator('h2 > span:first-child');
      assert.equal(await counter.textContent(), '3 of 8');
      await page.keyboard.press('ArrowRight');
      assert.equal(await counter.textContent(), '4 of 8');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await counter.textContent(), '3 of 8');
      await page.keyboard.press('End');
      assert.equal(await counter.textContent(), '8 of 8');
      assert.equal(
        await dialog.getByRole('button', { name: 'Next media', exact: true }).isDisabled(),
        true,
      );
      await page.keyboard.press('ArrowRight');
      assert.equal(await counter.textContent(), '8 of 8');
      const selected = dialog.locator('[aria-current="true"]');
      assert.equal(await selected.getAttribute('aria-label'), 'Image 8 of 8: Caption 8');
      const visible = await selected.evaluate((element) => {
        const rect = element.getBoundingClientRect(),
          parent = element.parentElement.getBoundingClientRect();
        return rect.left >= parent.left && rect.right <= parent.right;
      });
      assert.equal(visible, true);
      await page.keyboard.press('Home');
      assert.equal(await counter.textContent(), '1 of 8');
      await dialog.getByRole('button', { name: 'Image 2 of 8: Caption 2', exact: true }).click();
      assert.equal(await counter.textContent(), '2 of 8');
      const image = dialog.getByRole('img', { name: 'Image 2 of 8: Caption 2', exact: true });
      await image.dblclick();
      assert.match(await image.getAttribute('style'), /250%/);
      await page.keyboard.press('ArrowRight');
      await dialog.getByRole('img', { name: 'Image 3 of 8: Caption 3', exact: true }).waitFor();
      assert.match(await dialog.locator('.pw-media-viewport img').getAttribute('style'), /100%/);
      await page.keyboard.press('Escape');
      assert.equal(await dialog.count(), 0);
      assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
      await opener.click();
      await dialog.getByRole('button', { name: 'Close media viewer', exact: true }).click();
      assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
      await opener.click();
      // Desktop backdrop outside the surface; phone uses the inset between bars.
      if (width > 640) await page.mouse.click(2, 2);
      else await dialog.click({ position: { x: 1, y: 1 } });
      assert.equal(await dialog.count(), 0);
      assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
      await page.route('http://media-viewer.test/?single', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://media-viewer.test/?single');
      await page.getByRole('button', { name: 'Open Caption 1', exact: true }).click();
      assert.equal(await dialog.locator('h2 > span:first-child').textContent(), '1 of 1');
      assert.equal(await dialog.getByRole('navigation', { name: 'Media thumbnails' }).count(), 0);
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowRight');
      assert.equal(await dialog.locator('h2 > span:first-child').textContent(), '1 of 1');
      await page.keyboard.press('Escape');
      const thumbnails = [];
      page.on('request', (request) => {
        if (request.url().endsWith('/thumbnail')) thumbnails.push(request.url());
      });
      await page.route('http://media-viewer.test/?lazy', (route) =>
        route.fulfill({ contentType: 'text/html', body: html }),
      );
      await page.goto('http://media-viewer.test/?lazy');
      await page.getByRole('button', { name: 'Open Caption 1', exact: true }).waitFor();
      await page.waitForTimeout(100);
      assert.equal(thumbnails.length, 1, 'offscreen authenticated thumbnails must not fetch');
      await page.locator('.pw-attachment-image').last().scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: 'Open Caption 8', exact: true }).waitFor();
      assert.ok(thumbnails.some((url) => url.includes('/image-7/thumbnail')));
      assert.ok(thumbnails.length < attachments.length);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
  }
});
