// Captures the Storage dialogs on a local fixture server at the board widths, and checks the
// dialog's keyboard, sorting, searching and paging behaviour on the way. Exits non-zero when a
// check fails. The fixture (seed.mts) holds more than 50 files in both lists, so both page.
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

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
}

async function open(width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'light',
    // The built server answers over HTTPS with its own local certificate.
    ignoreHTTPSErrors: true,
  });
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
  // Every request for a page of files, with what it asked for and how many rows came back.
  const requests = [];
  // Counted when sent, so a request the dialog drops before its answer still counts.
  const sent = new Map();
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.endsWith('/storage/files')) return;
    const entry = { at: Date.now(), params: Object.fromEntries(url.searchParams), rows: null };
    requests.push(entry);
    sent.set(request, entry);
  });
  page.on('response', async (response) => {
    const entry = sent.get(response.request());
    if (!entry) return;
    try {
      entry.rows = (await response.json()).files?.length ?? null;
    } catch {
      // An aborted request has no body.
    }
  });
  await page.goto(`${origin}/dashboard/projects/${project}/settings`, { waitUntil: 'load' });
  await page.getByRole('button', { name: /Large files/ }).waitFor();
  await page.waitForTimeout(800);
  return { context, page, requests };
}
const dialog = (page) => page.getByRole('dialog');
async function shot(page, name, width) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(out, `${name}-${width}.png`) });
  console.log('wrote', name, width);
}
const range = (page) => dialog(page).locator('.v2-storage-pages .dl-meta').textContent();
const pager = (page) => dialog(page).locator('.v2-storage-pages');
const previous = (page) => dialog(page).getByRole('button', { name: 'Previous' });
const next = (page) => dialog(page).getByRole('button', { name: 'Next' });
const rowCount = (page) => dialog(page).locator('tbody tr').count();
const firstRow = (page) => dialog(page).locator('tbody tr td.dl-name').first().textContent();
/** Waits until the range reads `text`, then checks it and the two buttons. */
async function expectPage(page, label, text, { previousOn, nextOn, rows }) {
  await dialog(page)
    .locator('.v2-storage-pages .dl-meta', { hasText: text })
    .waitFor({ timeout: 5000 })
    .catch(() => {});
  const shown = await range(page).catch(() => null);
  check(`${label}: range reads "${text}"`, shown === text, `got "${shown}"`);
  check(
    `${label}: Previous ${previousOn ? 'enabled' : 'disabled'}`,
    (await previous(page).isEnabled()) === previousOn,
  );
  check(
    `${label}: Next ${nextOn ? 'enabled' : 'disabled'}`,
    (await next(page).isEnabled()) === nextOn,
  );
  const count = await rowCount(page);
  check(`${label}: ${rows} rows`, count === rows, `got ${count}`);
}
/**
 * Clicks a pager button with the next answer held back, and checks the rows stay in place (the
 * same table element, its rows, no skeleton) until the answer arrives.
 */
async function pageWithoutFlash(page, label, click, remembered) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const pattern = (url) => url.pathname.endsWith('/storage/files');
  let heldRequests = 0;
  await page.route(pattern, async (route) => {
    heldRequests++;
    await held;
    await route.continue().catch(() => {});
  });
  const table = await dialog(page).locator('table').elementHandle();
  const before = await firstRow(page);
  await click();
  await page.waitForTimeout(500);
  const during = await page.evaluate(
    (el) => ({
      attached: el.isConnected,
      rows: el.querySelectorAll('tbody tr').length,
      skeleton: !!document.querySelector('.ui-skeleton, [aria-label="Loading files"]'),
      first: el.querySelector('tbody tr td.dl-name')?.textContent,
    }),
    table,
  );
  check(`${label}: table stays attached while the page loads`, during.attached);
  // The rows shown are the page being left or, for a page read before, its remembered answer.
  check(
    `${label}: rows stay shown while loading`,
    during.rows > 0 && (during.first === before || during.first === remembered),
    `${during.rows} rows, first "${during.first}" (${during.first === before ? 'the page being left' : 'the remembered page'})`,
  );
  check(`${label}: no skeleton while loading`, !during.skeleton);
  check(
    `${label}: the next page was held back while checking`,
    heldRequests >= 1,
    `${heldRequests} held`,
  );
  release();
  await page.waitForFunction(
    ([el, first]) => el.querySelector('tbody tr td.dl-name')?.textContent !== first,
    [table, before],
  );
  await page.unroute(pattern);
  check(
    `${label}: same table element after the page loads`,
    await table.evaluate((el) => el.isConnected),
  );
}
/** Where the pager, table and footnote sit, in CSS pixels. */
async function layout(page) {
  return dialog(page).evaluate((box) => {
    const rect = (el) => el && el.getBoundingClientRect();
    const table = box.querySelector('.v2-storage-table');
    const pages = box.querySelector('.v2-storage-pages');
    const meta = pages?.querySelector('.dl-meta');
    const buttons = [...(pages?.querySelectorAll('button') ?? [])].map(rect);
    const note = box.querySelector('.v2-storage-note');
    const field = box.querySelector('.dl-field');
    const r = (x) =>
      x && { top: x.top, bottom: x.bottom, left: x.left, right: x.right, height: x.height };
    return {
      viewport: window.innerHeight,
      dialog: r(rect(box)),
      dialogScroll: { client: box.clientHeight, scroll: box.scrollHeight },
      contentLeft: rect(field).left,
      contentRight: rect(field).right,
      table: r(rect(table)),
      tableScroll: table && { client: table.clientHeight, scroll: table.scrollHeight },
      pages: r(rect(pages)),
      meta: r(rect(meta)),
      buttons: buttons.map(r),
      note: r(rect(note)),
      overflowX: [...box.querySelectorAll('*')].some(
        (el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'hidden',
      ),
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  });
}
function checkLayout(label, width, l) {
  console.log(`${label} layout`, JSON.stringify(l));
  check(
    `${label}: dialog fits the viewport`,
    l.dialog.bottom <= l.viewport && l.dialog.top >= 0,
    `dialog ${Math.round(l.dialog.top)}–${Math.round(l.dialog.bottom)} of ${l.viewport}`,
  );
  check(
    `${label}: table scrolls inside the dialog`,
    l.tableScroll.scroll > l.tableScroll.client,
    `client ${l.tableScroll.client}, scroll ${l.tableScroll.scroll}`,
  );
  check(
    `${label}: pager below the table`,
    l.pages.top >= l.table.bottom,
    `gap ${Math.round(l.pages.top - l.table.bottom)}px`,
  );
  check(
    `${label}: footnote below the pager`,
    l.note.top >= l.pages.bottom,
    `gap ${Math.round(l.note.top - l.pages.bottom)}px`,
  );
  check(
    `${label}: pager and footnote visible`,
    l.note.bottom <= Math.min(l.viewport, l.dialog.bottom) && l.pages.bottom <= l.viewport,
  );
  check(
    `${label}: range at the left edge of the content`,
    Math.abs(l.meta.left - l.contentLeft) < 1,
    `meta ${l.meta.left}, content ${l.contentLeft}`,
  );
  const [a, b] = l.buttons;
  check(
    `${label}: 8px between Previous and Next`,
    Math.abs(b.left - a.right - 8) < 0.5,
    `${b.left - a.right}px`,
  );
  check(
    `${label}: Next at the right edge of the content`,
    Math.abs(b.right - l.contentRight) < 1,
    `next ${b.right}, content ${l.contentRight}`,
  );
  check(
    `${label}: nothing scrolls sideways`,
    l.pageScrollWidth <= width && !l.overflowX,
    `scrollWidth ${l.pageScrollWidth}`,
  );
}

for (const width of [1440, 700]) {
  const { context, page, requests } = await open(width, 900);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(width, 'page scrollWidth', scrollWidth);

  await page.getByRole('button', { name: /Large files/ }).click();
  await dialog(page).waitFor();
  await dialog(page).locator('table').waitFor();
  console.log(
    width,
    'focused',
    await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
  );
  await expectPage(page, `${width} Large files page 1`, '1–50 of 63', {
    previousOn: false,
    nextOn: true,
    rows: 50,
  });
  await shot(page, 'StorageLargeFiles', width);

  await page.getByRole('textbox', { name: 'Search files' }).fill('video');
  await dialog(page).locator('.v2-storage-line', { hasText: ' of ' }).waitFor();
  await shot(page, 'StorageLargeFilesSearch', width);
  console.log(width, 'search line', await dialog(page).locator('.v2-storage-line').textContent());

  await page.getByRole('textbox', { name: 'Search files' }).fill('backup');
  await dialog(page).getByText('No files match').waitFor();
  await shot(page, 'StorageLargeFilesNoMatch', width);

  if (width === 1440) {
    await page.getByRole('textbox', { name: 'Search files' }).fill('');
    await expectPage(page, '1440 Large files search cleared', '1–50 of 63', {
      previousOn: false,
      nextOn: true,
      rows: 50,
    });
    const sorts = async () =>
      dialog(page)
        .locator('th')
        .evaluateAll((cells) =>
          cells.map((th) => `${th.textContent}:${th.getAttribute('aria-sort') ?? '-'}`),
        );
    console.log('sort before', await sorts());
    await dialog(page).getByRole('button', { name: 'Size' }).click();
    await page.waitForTimeout(600);
    console.log('after Size', await sorts());
    await dialog(page).getByRole('button', { name: 'Added' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    console.log('after Added (Enter)', await sorts());
    console.log(
      'first rows',
      await dialog(page)
        .locator('tbody tr')
        .evaluateAll((rows) => rows.slice(0, 3).map((row) => row.textContent)),
    );
  }
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'hidden' });
  console.log(
    width,
    'Escape closed; focus back on',
    await page.evaluate(() => document.activeElement?.textContent?.slice(0, 20)),
  );

  // Branches and tags: 185 files, four pages.
  await page.getByRole('button', { name: /Branches and tags/ }).click();
  await dialog(page).locator('table').waitFor();
  await expectPage(page, `${width} history page 1`, '1–50 of 185', {
    previousOn: false,
    nextOn: true,
    rows: 50,
  });
  checkLayout(`${width} history page 1`, width, await layout(page));
  await shot(page, 'StorageHistory', width);

  await pageWithoutFlash(page, `${width} Next to page 2`, () => next(page).click());
  await expectPage(page, `${width} history page 2`, '51–100 of 185', {
    previousOn: true,
    nextOn: true,
    rows: 50,
  });
  await shot(page, 'StorageHistoryPage2', width);

  await next(page).click();
  await expectPage(page, `${width} history page 3`, '101–150 of 185', {
    previousOn: true,
    nextOn: true,
    rows: 50,
  });
  const page3First = await firstRow(page);
  await next(page).click();
  await expectPage(page, `${width} history last page`, '151–185 of 185', {
    previousOn: true,
    nextOn: false,
    rows: 35,
  });
  await shot(page, 'StorageHistoryLast', width);
  await pageWithoutFlash(
    page,
    `${width} Previous from the last page`,
    () => previous(page).click(),
    page3First,
  );
  await expectPage(page, `${width} history back to page 3`, '101–150 of 185', {
    previousOn: true,
    nextOn: true,
    rows: 50,
  });

  // Sorting from page 3 returns to the first page.
  const sortedAt = requests.length;
  await dialog(page).getByRole('button', { name: 'File' }).click();
  await expectPage(page, `${width} sorted by File`, '1–50 of 185', {
    previousOn: false,
    nextOn: true,
    rows: 50,
  });
  const sortRequest = requests.slice(sortedAt).at(-1)?.params;
  check(
    `${width} sort by File asks for page 1 by file, ascending`,
    sortRequest?.sort === 'file' &&
      sortRequest?.direction === 'ascending' &&
      sortRequest?.page === '1',
    JSON.stringify(sortRequest),
  );
  const names = await dialog(page).locator('tbody td.dl-name .dl-mono').allTextContents();
  check(
    `${width} sorted by File reads A to Z`,
    names.every(
      (name, i) =>
        i === 0 || new Intl.Collator().compare(names[i - 1].toLowerCase(), name.toLowerCase()) <= 0,
    ),
    `${names[0]} … ${names.at(-1)}`,
  );
  check(
    `${width} File header says ascending`,
    (await dialog(page).locator('th[aria-sort]').getAttribute('aria-sort')) === 'ascending',
  );
  await shot(page, 'StorageHistorySortFile', width);

  // Searching from page 2: typing waits for a pause, asks once, and returns to page 1.
  await next(page).click();
  await expectPage(page, `${width} sorted by File page 2`, '51–100 of 185', {
    previousOn: true,
    nextOn: true,
    rows: 50,
  });
  const typedAt = requests.length;
  const search = page.getByRole('textbox', { name: 'Search files' });
  await search.click();
  // When the last keystroke landed, by the page's own clock (the same clock as Date.now here).
  await search.evaluate((input) =>
    input.addEventListener('input', () => (window.lastInput = Date.now())),
  );
  const started = Date.now();
  await page.keyboard.type('components', { delay: 60 });
  await page.waitForTimeout(50);
  const typed = await page.evaluate(() => window.lastInput);
  await expectPage(page, `${width} search "components"`, '1–50 of 70', {
    previousOn: false,
    nextOn: true,
    rows: 50,
  });
  const searches = requests.slice(typedAt);
  check(
    `${width} search is debounced: one request for ten keystrokes`,
    searches.length === 1,
    `${searches.length} requests: ${searches.map((r) => r.params.query ?? '').join(', ')}; typing took ${typed - started}ms`,
  );
  check(
    `${width} search request asks for page 1 with the query and the sort`,
    searches[0]?.params.query === 'components' &&
      searches[0]?.params.page === '1' &&
      searches[0]?.params.sort === 'file' &&
      searches[0]?.params.direction === 'ascending',
    JSON.stringify(searches[0]?.params),
  );
  check(
    `${width} search request waits for the pause after typing`,
    // The dialog waits 200ms; a few ms of slack for the two event loops.
    !!searches[0] && searches[0].at - typed >= 190,
    `sent ${searches[0] && searches[0].at - typed}ms after the last keystroke`,
  );
  console.log(width, 'search line', await dialog(page).locator('.v2-storage-line').textContent());
  await shot(page, 'StorageHistorySearchMany', width);

  await search.fill('server/');
  await dialog(page).locator('.v2-storage-line', { hasText: '30 of 185' }).waitFor();
  check(`${width} search "server/" (30 matches) has no pager`, (await pager(page).count()) === 0);
  check(`${width} search "server/" shows 30 rows`, (await rowCount(page)) === 30);
  console.log(width, 'search line', await dialog(page).locator('.v2-storage-line').textContent());
  await shot(page, 'StorageHistorySearchFew', width);

  // Every request for files said what it wanted and got at most a page back.
  const malformed = requests.filter(
    (r) => !r.params.kind || !r.params.sort || !r.params.direction || !r.params.page,
  );
  check(
    `${width} every files request carries kind, sort, direction and page`,
    requests.length > 0 && malformed.length === 0,
    `${requests.length} requests, ${malformed.length} without`,
  );
  check(
    `${width} searched requests carry the query`,
    requests.filter((r) => r.params.query).length >= 2,
    requests
      .filter((r) => r.params.query)
      .map((r) => r.params.query)
      .join(', '),
  );
  const answered = requests.filter((r) => r.rows !== null);
  check(
    `${width} every answer holds at most 50 rows`,
    answered.length > 0 && answered.every((r) => r.rows <= 50),
    `largest ${Math.max(...answered.map((r) => r.rows))}`,
  );
  await page.keyboard.press('Escape');
  await context.close();
}
await browser.close();
console.log(failures ? `${failures} checks failed` : 'all checks passed');
process.exitCode = failures ? 1 : 0;
