/** Run against an existing production server. Never starts a server or changes application data. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const [origin, seedFile, outputDirectory] = process.argv.slice(2);
if (!origin || !seedFile || !outputDirectory)
  throw new Error(
    'Usage: node docs/evidence/dashboard-pages/server-first.mjs <origin> <seed.json> <output dir>',
  );
const fixture = JSON.parse(readFileSync(seedFile, 'utf8'));
if (!fixture.dashboardPages?.length)
  throw new Error('Regenerate seed.json with docs/evidence/project-pages/seed.mts');
const output = resolve(outputDirectory);
mkdirSync(output, { recursive: true });
const normalize = (path) => path.replace(/%2e/gi, '.');
const reports = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const path of [
    ...new Set([...fixture.dashboardPages, ...Object.values(fixture.pages ?? {})]),
  ]) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ignoreHTTPSErrors: true,
      locale: 'de-DE',
      timezoneId: 'Pacific/Honolulu',
    });
    const report = {
      path,
      status: null,
      htmlHasNoSkeleton: false,
      skeletonInBrowser: false,
      seedPaths: [],
      apiFirstTwoSeconds: [],
      hydrationErrors: [],
      pageErrors: [],
      repeatedSeededRequests: [],
    };
    const requests = [];
    let started;
    let deadline;
    try {
      const signIn = await context.request.post(new URL('/api/v2/auth/session', origin).href, {
        headers: { 'x-deploy-username': fixture.username, 'x-deploy-token': fixture.token },
        data: {},
      });
      if (!signIn.ok()) throw new Error(`Sign-in failed: ${signIn.status()}`);
      await context.addInitScript(({ username, token }) => {
        localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
        window.__dashboardSkeleton = false;
        let until = Infinity;
        document.addEventListener('DOMContentLoaded', () => {
          until = performance.now() + 2000;
        });
        const observer = new MutationObserver(() => {
          if (performance.now() > until) return observer.disconnect();
          if (
            [...document.querySelectorAll('.dl-skel, .dl-skeleton')].some(
              (node) => !node.closest('dialog:not([open]), [role="dialog"][aria-hidden="true"]'),
            )
          )
            window.__dashboardSkeleton = true;
        });
        observer.observe(document, { childList: true, subtree: true, attributes: true });
      }, fixture);
      const page = await context.newPage();
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/'))
          requests.push({
            path: normalize(url.pathname + url.search),
            method: request.method(),
            at: Date.now(),
          });
      });
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /hydrat|react error #4(18|23|25)|did not match/i.test(message.text())
        )
          report.hydrationErrors.push(message.text());
      });
      page.on('pageerror', (error) => report.pageErrors.push(error.message));
      started = Date.now();
      const response = await page.goto(new URL(path, origin).href, {
        waitUntil: 'domcontentloaded',
      });
      deadline = Date.now() + 2000;
      if (!response) throw new Error('No document response');
      report.status = response.status();
      const html = await response.text();
      const name = path.replace(/[^a-z0-9]/gi, '_');
      writeFileSync(resolve(output, `${name}.html`), html);
      // JSON script tags are attached but never visible.
      await page.waitForSelector('script[data-project-seed]', {
        state: 'attached',
        timeout: 15000,
      });
      const initial = await page.evaluate((html) => {
        const document = new DOMParser().parseFromString(html, 'text/html');
        const seedPaths = [...document.querySelectorAll('script[data-project-seed]')].flatMap(
          (node) => JSON.parse(node.textContent).paths,
        );
        document.querySelectorAll('script, style, template').forEach((node) => node.remove());
        const skeletons = [...document.querySelectorAll('.dl-skel, .dl-skeleton')].filter(
          (node) => !node.closest('dialog:not([open]), [role="dialog"][aria-hidden="true"]'),
        );
        return { seedPaths: [...new Set(seedPaths)], htmlHasNoSkeleton: skeletons.length === 0 };
      }, html);
      Object.assign(report, initial);
      await page.waitForTimeout(Math.max(0, deadline - Date.now()));
      report.skeletonInBrowser = await page.evaluate(() => window.__dashboardSkeleton);
      await page.screenshot({ path: resolve(output, `${name}.png`) });
    } catch (error) {
      report.pageErrors.push(error.message);
    } finally {
      if (started !== undefined) {
        report.apiFirstTwoSeconds = requests
          .filter((entry) => entry.at <= (deadline ?? started + 2000))
          .map((entry) => ({ ...entry, at: entry.at - started }));
        report.repeatedSeededRequests = report.apiFirstTwoSeconds.filter(
          (entry) => entry.method === 'GET' && report.seedPaths.map(normalize).includes(entry.path),
        );
      }
      reports.push(report);
      console.log(JSON.stringify(report));
      await context.close();
    }
  }
} finally {
  await browser.close();
  const failures = reports.filter(
    (report) =>
      report.status !== 200 ||
      !report.htmlHasNoSkeleton ||
      report.skeletonInBrowser ||
      !report.seedPaths.length ||
      report.hydrationErrors.length ||
      report.pageErrors.length ||
      report.repeatedSeededRequests.length,
  );
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ reports, failures }, null, 2));
  if (failures.length) process.exitCode = 1;
}
