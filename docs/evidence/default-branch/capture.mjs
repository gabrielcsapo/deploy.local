import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const [repo, scratch, out] = process.argv.slice(2);
const { chromium } = createRequire(repo + '/')('playwright');
const origin = 'http://127.0.0.1:5193';
const project = readFileSync(join(scratch, 'project-id'), 'utf8').trim();
const cookie = readFileSync(join(scratch, 'cookie-value'), 'utf8').trim();
const [username, token] = decodeURIComponent(cookie).split(':');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  await context.addCookies([{ name: 'deploy-sh-auth', value: cookie, url: origin }]);
  await context.addInitScript(([u, t]) => localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: u, token: t })), [username, token]);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('console:', m.text().slice(0, 200)));
  await page.goto(origin + `/dashboard/projects/${project}/settings`, { waitUntil: 'load' });
  await page.locator('.dl-setting', { hasText: 'Default branch' }).first().waitFor({ state: 'attached' });
  await page.waitForTimeout(1500);
  return { context, page };
}
for (const width of [1440, 700]) {
  let { context, page } = await open(width, 1380);
  await page.locator('.dl-setting', { hasText: 'Default branch' }).first().scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: join(out, `ProjectSettings-${width}.png`) });
  await page.locator('.dl-setting', { hasText: 'Default branch' }).getByRole('button', { name: 'Change' }).click();
  await page.getByRole('option', { name: /develop/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `ProjectDefaultBranch-${width}.png`) });
  if (width === 700) {
    console.log('options', await page.getByRole('option').allTextContents());
    console.log('note', await page.locator('.v2-default-branch-note').textContent());
    await page.getByRole('button', { name: 'Use develop' }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.waitForTimeout(800);
    console.log('row after', await page.locator('.dl-setting', { hasText: 'Default branch' }).textContent());
  }
  await context.close();
}
await browser.close();
