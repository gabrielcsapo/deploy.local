// Captures the built pages for the clone + SSH keys slice at the board widths.
// Usage: node capture-states.mjs <repo> <scratchpad> <out>
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
async function shot(name, width, height, path, act) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' });
  await context.addCookies([{ name: 'deploy-sh-auth', value: cookie, url: origin }]);
  await context.addInitScript(
    ([u, t]) => {
      localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: u, token: t }));
      localStorage.setItem('deploy.clone-protocol', 'ssh');
    },
    [username, token],
  );
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error(name, 'page error:', error.message));
  await page.goto(origin + path, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  if (act) await act(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, `${name}-${width}.png`), fullPage: false });
  console.log('wrote', name, width);
  await context.close();
}

for (const width of [1440, 700]) {
  await shot('CodeClone', width, 900, `/dashboard/projects/${project}/code`, async (page) => {
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.getByRole('tab', { name: 'SSH' }).waitFor();
  });
  await shot('Project', width, 900, `/dashboard/projects/${project}`, async (page) => {
    await page.getByRole('heading', { name: 'Clone' }).scrollIntoViewIfNeeded();
  });
  await shot('Settings', width, 1300, `/dashboard/settings/account`, async (page) => {
    await page.locator('#ssh-keys').scrollIntoViewIfNeeded();
  });
  await shot('SshKeyAdd', width, 1300, `/dashboard/settings/account`, async (page) => {
    await page.getByRole('button', { name: 'Add key' }).click();
    await page
      .getByLabel('2. Paste it here')
      .fill(
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK9xR2mQ7tW4vB8nL3cY6pF1hD0sZ5aJ2eU8oG4kT7qM gabriel@MacBook-Pro',
      );
  });
}
await browser.close();
