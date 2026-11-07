// Run only on the orchestrator's browser-capable host, after starting fixture + Vite.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const out = resolve(process.argv[2] ?? '/private/tmp/design-chat-captures');
mkdirSync(out, { recursive: true });
const origin = 'http://127.0.0.1:5194';
const fixture = await (await fetch(`${origin}/fixture`)).json();
const browser = await chromium.launch();
try {
  for (const width of [1440, 700]) {
    await fetch(`${origin}/fixture/reset`);
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      colorScheme: 'light',
    });
    await context.addInitScript(() => {
      localStorage.setItem(
        'deploy-sh-auth',
        JSON.stringify({ username: 'Gabriel', token: 'fixture' }),
      );
      localStorage.setItem('deploy-v2-first-task-seen', 'yes');
    });
    const page = await context.newPage();
    await page.goto(fixture.chat);
    await page.waitForFunction(
      () => document.querySelectorAll('.dzr-card-mini svg image').length === 2,
      undefined,
      { timeout: 120_000 },
    );
    await page.screenshot({ path: `${out}/DesignChat-${width}.png` });
    await page.goto(fixture.review);
    const ask = page.getByRole('button', { name: 'Ask for 3 changes', exact: true });
    await ask.waitFor({ timeout: 120_000 });
    await page.waitForFunction(
      () => {
        const button = document.querySelector('.dl-review-footer button.primary');
        return button && !button.disabled;
      },
      undefined,
      { timeout: 120_000 },
    );
    await ask.click();
    await page
      .getByRole('heading', { name: '3 changes sent to Release notes writer', exact: true })
      .waitFor();
    await page.getByRole('link', { name: 'Open the task', exact: true }).waitFor();
    await page.screenshot({ path: `${out}/DesignReviewSent-${width}.png` });
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(out);
