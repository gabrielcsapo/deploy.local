// Run one capture at a time: the reset endpoint replaces the shared fixture data.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';

const state = process.argv[2] ?? 'Projects';
const width = Number(process.argv[3] ?? 1440);
const states = [
  'Projects',
  'Live',
  'LiveDark',
  'AppNoRepository',
  'AddRepository',
  'NewProjectExistingApp',
  'ProjectEmpty',
  'AddExistingApp',
];
if (!states.includes(state) || ![1440, 700].includes(width))
  throw new Error(
    `Usage: node docs/evidence/projects-join/capture.mjs <${states.join('|')}> <1440|700>`,
  );
const port = Number(process.env.PORT ?? 5180);
if (!Number.isInteger(port) || port < 5180 || port > 5189) throw new Error('Use ports 5180–5189');
const origin = `http://127.0.0.1:${port}`;
const board = state === 'LiveDark' ? 'Live' : state;
const source = readFileSync(`design/boards/${board}.html`, 'utf8');
const height = Math.max(
  900,
  Number(source.match(/name="design-board" content="[^"]*height=(\d+)/)?.[1] ?? 900),
);
const browser = await chromium.launch();
const errors = [];
try {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: state === 'LiveDark' ? 'dark' : 'light',
    locale: 'en-US',
    timezoneId: 'America/New_York',
    serviceWorkers: 'block',
  });
  // No requests to app addresses, remote fonts, analytics or the real coordinator.
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    errors.push(`Outside request blocked: ${route.request().url()}`);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (request) => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED'))
      errors.push(`${request.failure()?.errorText}: ${request.url()}`);
  });
  await page.goto(`${origin}/__fixture?state=${state}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.locator('.dl-app').waitFor();
  const main = page.locator('main');
  // Wait on data-backed content, not networkidle: the real shell keeps a long poll open.
  if (state === 'Projects') {
    await main.getByText('kettle-timer · Done', { exact: true }).waitFor();
    await main.getByText('2 apps · SER and imac', { exact: true }).waitFor();
  } else if (state === 'Live' || state === 'LiveDark') {
    await main.getByText('forma jobs', { exact: true }).waitFor();
    await main
      .getByRole('heading', { name: 'Roll back home-gym to 81be0d2?', exact: true })
      .waitFor();
  } else if (state === 'AppNoRepository' || state === 'AddRepository') {
    await main.getByRole('button', { name: 'Add a repository', exact: true }).waitFor();
    await main.getByText('28 ms', { exact: true }).waitFor();
    if (state === 'AddRepository') {
      await main.getByRole('button', { name: 'Add a repository', exact: true }).click();
      await page.getByRole('dialog', { name: 'Add a repository to pantry', exact: true }).waitFor();
    }
  } else if (state === 'NewProjectExistingApp') {
    await main.getByText('pantry · Active', { exact: true }).waitFor();
    await main.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
    await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('pantry');
    await dialog.getByRole('button', { name: 'Add repository to pantry', exact: true }).waitFor();
  } else {
    await main.getByRole('heading', { name: 'What should recipes be?', exact: true }).waitFor();
    await main.getByRole('link', { name: 'Add an app you shipped', exact: true }).waitFor();
    if (state === 'AddExistingApp') {
      await main.getByRole('link', { name: 'Add an app you shipped', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Add an app to recipes', exact: true });
      await dialog
        .getByText('recipes.deploy.local · on SER · same name as this project', { exact: true })
        .waitFor();
      await dialog.getByText('pantry.deploy.local · on SER', { exact: true }).waitFor();
    }
  }
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
  await page.evaluate(() => document.fonts.ready);
  // Let dialog transitions settle, without waiting for the long-poll connection to close.
  await page.waitForTimeout(300);
  if (errors.length) throw new Error(errors.join('\n'));
  mkdirSync('output/projects-join', { recursive: true });
  const path = `output/projects-join/${state}-${width}.png`;
  await page.screenshot({ path, animations: 'disabled', caret: 'hide' });
  console.log(
    JSON.stringify(
      {
        path,
        url: page.url(),
        width,
        height,
        errors,
        text: (await page.locator('body').innerText()).slice(0, 5000),
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
