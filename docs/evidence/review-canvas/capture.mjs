// Run sequentially against fixture-server.ts. Never used by the fixture server itself.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const [state = 'review', rawWidth = '1440'] = process.argv.slice(2);
const states = [
  'review',
  'approved',
  'approved-person',
  'building',
  'conflict',
  'notes-only',
  'loading',
];
const width = Number(rawWidth);
const port = Number(process.env.PORT ?? 5190);
assert.ok(states.includes(state), `State must be one of: ${states.join(', ')}`);
assert.ok([1440, 700].includes(width), 'Width must be 1440 or 700');
assert.ok(Number.isInteger(port) && port >= 5180 && port <= 5199, 'Use only ports 5180–5199');
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  const errors = [];
  // The fixture has a CSP too. Guard capture traffic so a new remote dependency cannot leak out.
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    errors.push(`External request blocked: ${url.href}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  await page.goto(`${origin}/__fixture?state=${state}`, { waitUntil: 'domcontentloaded' });
  const bar = page.locator('.dz-review-bar');
  await bar.waitFor({ timeout: 60000 });
  if (state === 'loading') {
    await page.getByRole('status', { name: 'Loading the review', exact: true }).waitFor();
    await page.getByRole('status', { name: 'Loading review decisions', exact: true }).waitFor();
    assert.equal(await bar.getByRole('button', { name: 'Approve design', exact: true }).count(), 0);
  } else {
    await bar.getByText('Keep the gutter at every width', { exact: true }).waitFor();
    await page.locator('.dz-world').waitFor();
    if (state === 'notes-only') {
      await page
        .locator('.dz-note')
        .filter({ hasText: 'Keep the gutter at every width, down to 390.' })
        .waitFor();
      assert.equal(await page.getByRole('checkbox', { name: /^Approve / }).count(), 0);
    } else {
      // Open the whole page through the product's Zoom to page shortcut, at both widths.
      await page.locator('iframe[title="Welcome"]').waitFor();
      await page.keyboard.press('Shift+Digit1');
      await page.waitForFunction(() => {
        const frames = [...document.querySelectorAll('.dz-board iframe')];
        return (
          frames.length > 0 &&
          frames.every((frame) => {
            const doc = frame.contentDocument;
            return (
              doc?.readyState === 'complete' &&
              !!doc.body?.children.length &&
              !doc.body.innerText.includes('Unknown fixture')
            );
          })
        );
      });
      await page.locator('.dz-review-area').first().waitFor();
      assert.equal(
        await page.getByRole('checkbox', { name: 'Approve Welcome', exact: true }).isChecked(),
        true,
      );
    }
    if (state === 'review') {
      await bar.getByText(/1 of 3 approved/).waitFor();
      assert.equal(
        await page
          .getByRole('checkbox', { name: 'Approve Welcome, narrow', exact: true })
          .isChecked(),
        false,
      );
    }
    if (state === 'approved') {
      await bar.getByText(/Approved · on main as 4f05991 · not built yet/).waitFor();
      await page.getByRole('button', { name: 'Where to build', exact: true }).click();
      await page.getByRole('menu', { name: 'Where to build', exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole('menuitemradio', { name: /In Designer’s task/ })
          .getAttribute('aria-checked'),
        'true',
      );
    }
    if (state === 'approved-person') {
      await bar.getByRole('button', { name: 'Build', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: 'Where to build', exact: true }).count(),
        0,
      );
    }
    if (state === 'building') {
      await bar
        .getByRole('link', { name: 'Keep the gutter at every width is building it', exact: true })
        .waitFor();
      assert.equal(await bar.getByRole('button', { name: 'Build', exact: true }).count(), 0);
    }
    if (state === 'conflict') {
      await bar.getByRole('button', { name: '0 of 1 resolved', exact: true }).click();
      await page.getByRole('dialog', { name: 'Changed on main too', exact: true }).waitFor();
    }
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.querySelectorAll('.dz-board iframe')].map(
        (frame) => frame.contentDocument?.fonts.ready,
      ),
    );
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  });
  assert.deepEqual(
    errors,
    [],
    'Page errors, failed resources or external traffic make the capture invalid',
  );
  mkdirSync('output/review-canvas', { recursive: true });
  const path = `output/review-canvas/${state}-${width}.png`;
  await page.screenshot({ path, animations: 'disabled' });
  console.log(JSON.stringify({ path, url: page.url(), viewport: { width, height: 900 }, errors }));
} finally {
  await browser.close();
}
