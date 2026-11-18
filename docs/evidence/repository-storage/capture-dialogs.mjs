// Captures the Storage dialogs on a local fixture server at the board widths, and checks the
// dialog's keyboard and sorting behaviour on the way.
// Usage: node docs/evidence/repository-storage/capture-dialogs.mjs <origin> <project-id> <cookie> <out>
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [origin, project, cookie, out] = process.argv.slice(2);
if (!['127.0.0.1', 'localhost'].includes(new URL(origin).hostname))
  throw new Error('Only for a local fixture server');
const { chromium } = createRequire(process.cwd() + '/')('playwright');
const [username, token] = decodeURIComponent(cookie).split(':');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function open(width, height) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  await context.addCookies([{ name: 'deploy-sh-auth', value: cookie, url: origin }]);
  await context.addInitScript(
    ([u, t]) => localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: u, token: t })),
    [username, token],
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('page error:', error.message));
  page.on(
    'console',
    (message) =>
      message.type() === 'error' && console.error('console:', message.text().slice(0, 200)),
  );
  await page.goto(`${origin}/dashboard/projects/${project}/settings`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /Large files/ }).waitFor();
  await page.waitForTimeout(800);
  return { context, page };
}
const dialog = (page) => page.getByRole('dialog');
async function shot(page, name, width) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}-${width}.png`) });
  console.log('wrote', name, width);
}

for (const width of [1440, 700]) {
  const { context, page } = await open(width, 900);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(width, 'page scrollWidth', scrollWidth);

  await page.getByRole('button', { name: /Large files/ }).click();
  await dialog(page).waitFor();
  await dialog(page).locator('table').waitFor();
  console.log(width, 'focused', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')));
  await shot(page, 'StorageLargeFiles', width);

  await page.getByRole('textbox', { name: 'Search files' }).fill('video');
  await shot(page, 'StorageLargeFilesSearch', width);
  console.log(width, 'search line', await dialog(page).locator('.v2-storage-line').textContent());

  await page.getByRole('textbox', { name: 'Search files' }).fill('backup');
  await shot(page, 'StorageLargeFilesNoMatch', width);

  if (width === 1440) {
    await page.getByRole('textbox', { name: 'Search files' }).fill('');
    const sorts = async () =>
      dialog(page)
        .locator('th')
        .evaluateAll((cells) => cells.map((th) => `${th.textContent}:${th.getAttribute('aria-sort') ?? '-'}`));
    console.log('sort before', await sorts());
    await dialog(page).getByRole('button', { name: 'Size' }).click();
    console.log('after Size', await sorts());
    await dialog(page).getByRole('button', { name: 'Added' }).focus();
    await page.keyboard.press('Enter');
    console.log('after Added (Enter)', await sorts());
    console.log(
      'first rows',
      await dialog(page)
        .locator('tbody tr')
        .evaluateAll((rows) => rows.slice(0, 3).map((row) => row.textContent)),
    );
    const table = dialog(page).locator('.v2-storage-table');
    console.log(
      'table scrolls inside',
      await table.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight })),
    );
  }
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'hidden' });
  console.log(width, 'Escape closed; focus back on', await page.evaluate(() => document.activeElement?.textContent?.slice(0, 20)));

  await page.getByRole('button', { name: /Branches and tags/ }).click();
  await dialog(page).locator('table').waitFor();
  await shot(page, 'StorageHistory', width);
  await page.keyboard.press('Escape');
  await context.close();
}
await browser.close();
