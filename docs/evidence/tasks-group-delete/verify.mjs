// Drives the running fixture with real pointer and keyboard input and checks the behaviour the
// boards describe. Run after fixture-server.ts is listening; it changes only fixture data.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { chromium } = createRequire(process.cwd() + '/')('playwright');
const port = Number(process.env.PORT ?? 5191);
assert.ok(port >= 5180 && port <= 5199, 'Use only ports 5180–5199');
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
const results = [];
const check = async (name, run) => {
  await run();
  results.push(`PASS ${name}`);
};
try {
  // A short window so the sidebar list scrolls.
  const page = await browser.newPage({ viewport: { width: 1440, height: 640 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/__fixture?state=by-project`);
  const side = page.locator('.dl-app > .dl-side');
  const row = (title) => side.locator('.side-task').filter({ hasText: title });
  const time = (title) => row(title).locator('.dl-nav .dl-end');
  const more = (title) => row(title).getByRole('button', { name: 'Task actions' });
  await row('Check SER release health').waitFor();

  await check('hover swaps the time for ⋯', async () => {
    await page.mouse.move(700, 600);
    assert.equal(await time('Check SER release health').isVisible(), true);
    assert.equal(
      await more('Check SER release health').evaluate((el) => getComputedStyle(el).opacity),
      '0',
    );
    await row('Check SER release health').hover();
    assert.equal(await time('Check SER release health').isVisible(), false);
    assert.equal(
      await more('Check SER release health').evaluate((el) => getComputedStyle(el).opacity),
      '1',
    );
  });

  await check('keyboard focus swaps the time for ⋯, and Tab reaches it', async () => {
    await page.mouse.move(700, 600);
    await row('Show checks on merged PRs').locator('a').focus();
    assert.equal(await time('Show checks on merged PRs').isVisible(), false);
    await page.keyboard.press('Tab');
    assert.equal(
      await more('Show checks on merged PRs').evaluate((el) => el === document.activeElement),
      true,
    );
    await page.keyboard.press('Enter');
    const item = side.getByRole('menuitem', { name: 'Delete task…' });
    await item.waitFor();
    assert.equal(await item.evaluate((el) => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await item.count(), 0);
    assert.equal(
      await more('Show checks on merged PRs').evaluate((el) => el === document.activeElement),
      true,
    );
  });

  await check('a running task has no ⋯ and no right-click menu', async () => {
    assert.equal(await more('Self-release pipeline').count(), 0);
    await row('Self-release pipeline').click({ button: 'right' });
    assert.equal(await side.getByRole('menu', { name: 'Task actions' }).count(), 0);
    await page.keyboard.press('Escape');
  });

  await check(
    'right-click on the last row opens the menu, fully visible in the sidebar',
    async () => {
      const last = row('Fix bazzite startup');
      await last.scrollIntoViewIfNeeded();
      await last.click({ button: 'right' });
      const menu = side.getByRole('menu', { name: 'Task actions' });
      await menu.waitFor();
      await page.waitForTimeout(300);
      const box = await menu.boundingBox();
      const scroll = await side.locator('.dl-side-scroll').boundingBox();
      assert.ok(
        box.y >= scroll.y && box.y + box.height <= scroll.y + scroll.height + 0.5,
        `menu ${JSON.stringify(box)} outside scroll area ${JSON.stringify(scroll)}`,
      );
      await page.keyboard.press('Escape');
    },
  );

  await check('Show 2 more reveals the rest', async () => {
    await side.getByRole('button', { name: 'Show 2 more' }).click();
    await row('Queue runs per computer').waitFor();
  });

  await check('deleting a row from the dialog removes it', async () => {
    await row('Review home-gym changes').hover();
    await more('Review home-gym changes').click();
    await side.getByRole('menuitem', { name: 'Delete task…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this task?' });
    await dialog
      .getByText(
        '“Review home-gym changes” is removed for good: its conversation and its saved checkpoints.',
      )
      .waitFor();
    await dialog.getByRole('button', { name: 'Delete task' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await row('Review home-gym changes').waitFor({ state: 'detached' });
  });

  await check('the Group tasks menu switches to Date and back', async () => {
    await side.getByRole('button', { name: 'Group tasks' }).click();
    const menu = side.getByRole('menu', { name: 'Group tasks by' });
    assert.equal(
      await menu.getByRole('menuitemradio', { name: 'Project' }).getAttribute('aria-checked'),
      'true',
    );
    await menu.getByRole('menuitemradio', { name: 'Date' }).click();
    await side.locator('.dl-side-label', { hasText: 'Today' }).waitFor();
    await side.getByRole('button', { name: 'Group tasks' }).click();
    await side.getByRole('menuitemradio', { name: 'Project' }).click();
    await side.locator('.dl-side-label', { hasText: 'home-gym' }).waitFor();
  });

  await check('deleting the open task goes to the start page; its page is Not found', async () => {
    await page.getByRole('button', { name: 'More task actions' }).click();
    await page.locator('#task-actions').getByRole('button', { name: 'Delete task…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this task?' });
    await dialog
      .getByText('The branch has 2 commits that are not on main. They are deleted with it.')
      .waitFor();
    await dialog.getByRole('button', { name: 'Delete task' }).click();
    await page.waitForURL(`${origin}/dashboard`);
    await page.getByRole('heading', { name: 'What should we build?' }).waitFor();
    assert.equal(await row('Cache Discover images on SER').count(), 0);
    await page.goto(`${origin}/dashboard/tasks/cache-discover`);
    await page.getByText('Not found', { exact: true }).waitFor();
  });

  await check('a project heading’s + starts a task in that project', async () => {
    await page.goto(`${origin}/__fixture?state=by-project`);
    await side.getByRole('link', { name: 'New task in home-gym' }).click();
    await page.waitForURL(`${origin}/dashboard?project=home-gym`);
    const composer = page.locator('.dl-home-composer');
    await composer.locator('.dl-chip', { hasText: 'home-gym' }).waitFor();
    assert.equal(await side.getByRole('link', { name: /^New task in No project/ }).count(), 0);
    const sent = page.waitForRequest((request) => request.url().endsWith('/api/composer/messages'));
    await composer.getByRole('textbox', { name: 'Message' }).fill('Add a calmer header');
    await composer.getByRole('button', { name: 'Send' }).click();
    assert.equal(JSON.parse((await sent).postData()).projectId, 'home-gym');
    // The start page opens the started task.
    await page.waitForURL(`${origin}/dashboard/tasks/cache-discover`);
  });

  await check('an unknown project in the URL leaves New task as it is', async () => {
    await page.goto(`${origin}/dashboard?project=removed`);
    const composer = page.locator('.dl-home-composer');
    await composer.locator('.dl-chip', { hasText: 'deploy.local' }).waitFor();
    const sent = page.waitForRequest((request) => request.url().endsWith('/api/composer/messages'));
    await composer.getByRole('textbox', { name: 'Message' }).fill('Plain new task');
    await composer.getByRole('button', { name: 'Send' }).click();
    assert.equal(JSON.parse((await sent).postData()).projectId, undefined);
  });
  assert.deepEqual(errors, []);
} finally {
  console.log(results.join('\n'));
  await browser.close();
}
