/** Run against the production build; this script never starts a server. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
const origin = process.argv[2] || 'http://127.0.0.1:5188';
const fixtureFile = process.argv[3];
if (!fixtureFile)
  throw new Error(
    'Usage: node docs/evidence/project-pages/server-first.mjs ORIGIN seed.json [output-directory]',
  );
const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8'));
const output = resolve(process.argv[4] || 'output/project-pages/server-first');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const reports = [];
const failures = [];
const skeleton = '.dl-skel, .dl-skeleton, [data-rfr-fallback]';
const normalize = (value) => value.replace(/%2e/gi, '.');
async function contextFor(width) {
  // Deliberately differ from the server timezone to expose hydration bugs.
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    ignoreHTTPSErrors: true,
    timezoneId: 'Pacific/Honolulu',
    locale: 'de-DE',
  });
  const signIn = await context.request.post(`${origin}/api/v2/auth/session`, {
    headers: { 'x-deploy-username': fixture.username, 'x-deploy-token': fixture.token },
    data: {},
  });
  if (!signIn.ok())
    throw new Error(`Cookie sign-in failed: ${signIn.status()} ${await signIn.text()}`);
  const auth = (await context.cookies()).find((cookie) => cookie.name === 'deploy-sh-auth');
  if (!auth?.httpOnly || auth.sameSite !== 'Lax' || (origin.startsWith('https:') && !auth.secure))
    throw new Error('Cookie attributes are incorrect');
  await context.addInitScript(
    ({ username, token, skeleton }) => {
      localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
      const proof = (window.__projectProof = {
        skeleton: false,
        firstCompletePaint: null,
        frames: [],
      });
      const inspect = () => {
        if (document.querySelector(skeleton)) proof.skeleton = true;
      };
      const observer = new MutationObserver((changes) => {
        inspect();
        for (const change of changes)
          for (const node of change.addedNodes)
            if (node.nodeType === 1 && (node.matches(skeleton) || node.querySelector(skeleton)))
              proof.skeleton = true;
      });
      observer.observe(document, { childList: true, subtree: true, attributes: true });
      const tick = () => {
        const marker =
          document.querySelector('[data-project-seed="tab"]') ||
          (location.pathname === '/dashboard/projects' &&
            document.querySelector('[data-project-seed="page"]'));
        if (
          proof.firstCompletePaint === null &&
          marker &&
          !marker.closest('[hidden]') &&
          document.querySelector('.v2-project-page') &&
          !document.querySelector(skeleton)
        )
          proof.firstCompletePaint = performance.now();
        if (proof.navigation) {
          const { oldText } = proof.navigation;
          proof.frames.push({
            at: performance.now(),
            oldPresent:
              document.querySelector('.v2-project-page')?.textContent.includes(oldText) ?? false,
            skeleton: !!document.querySelector(skeleton),
            pending: !!document.querySelector('.dl-tabs .loading'),
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { username: fixture.username, token: fixture.token, skeleton },
  );
  return context;
}
const required = [
  '/dashboard/projects',
  '/dashboard/projects/many-tabs',
  ...[
    'code',
    'pulls',
    'pulls/pull-1',
    'issues',
    'pipelines',
    'releases',
    'logs',
    'settings',
    'apps/web',
    'apps/web/settings',
    'apps/web/requests',
    'apps/web/performance',
  ].map((tab) => `/dashboard/projects/many-tabs/${tab}`),
  '/dashboard/projects/many-tabs/releases/many-tabs-release-2',
  '/dashboard/projects/many-tabs?tab=apps',
  '/dashboard/projects/pantry',
  '/dashboard/projects/pantry/requests',
  '/dashboard/projects/pantry/performance',
];
try {
  for (const width of [1440, 700]) {
    const context = await contextFor(width);
    // Each direct load has a new page/cache: a prior navigation cannot conceal a missing seed.
    for (const path of [
      ...new Set([
        ...required,
        ...Object.values(fixture.pages).filter((path) => path.startsWith('/dashboard/projects')),
      ]),
    ]) {
      const page = await context.newPage();
      const api = [],
        errors = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/'))
          api.push({
            path: normalize(url.pathname + url.search),
            at: Date.now(),
            method: request.method(),
          });
      });
      page.on('console', (message) => {
        if (
          message.type() === 'error' &&
          /hydrat|react error #4(18|23|25)|did not match/i.test(message.text())
        )
          errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      const response = await page.goto(origin + path, { waitUntil: 'domcontentloaded' });
      const html = await response.text();
      writeFileSync(resolve(output, `${width}-${path.replace(/[^a-z0-9]/gi, '_')}.html`), html);
      await page
        .waitForFunction(() => window.__projectProof.firstCompletePaint !== null, null, {
          timeout: 15000,
        })
        .catch(() => {});
      const elapsed = await page.evaluate(() => performance.now());
      if (elapsed < 2000) await page.waitForTimeout(2000 - elapsed);
      const result = await page.evaluate(
        ({ html, path }) => {
          const proof = window.__projectProof;
          const parsed = new DOMParser().parseFromString(html, 'text/html');
          parsed.querySelectorAll('script, style, template').forEach((node) => node.remove());
          const arrivedText = [...parsed.querySelectorAll('.v2-project-page')]
            .map((node) => node.textContent)
            .join(' ');
          const name = path.includes('/pantry')
            ? 'pantry'
            : path.includes('/small')
              ? 'Small project'
              : path.includes('/preparing')
                ? 'Preparing repository'
                : path.includes('unmeasured')
                  ? 'unmeasured'
                  : 'deploy.local';
          const seedPaths = [...document.querySelectorAll('[data-project-seed]')].flatMap(
            (node) => JSON.parse(node.textContent).paths,
          );
          const expected = path.includes('/preparing/code')
            ? ['Repository is not ready']
            : path.includes('/code')
              ? ['README.md']
              : path.includes('/pulls')
                ? ['Keep project tabs mounted']
                : path.endsWith('/issues')
                  ? ['Project page display polish']
                  : path.includes('/pipelines')
                    ? ['react-flight-router']
                    : path.includes('/releases')
                      ? ['Project pages evidence']
                      : path.endsWith('/performance')
                        ? ['Nothing to measure yet']
                        : path.endsWith('/requests')
                          ? ['No requests']
                          : path.endsWith('/settings')
                            ? path.includes('/apps/')
                              ? ['Memory limit']
                              : ['Variables and secrets']
                            : path.endsWith('/logs')
                              ? ['No log lines received.']
                              : path.endsWith('/apps/web')
                                ? ['web.local', 'HTTP check']
                                : path === '/dashboard/projects'
                                  ? ['Small project', 'Preparing repository', 'pantry']
                                  : [];
          return {
            htmlHasData:
              (arrivedText.includes(name) || parsed.body.textContent.includes(name)) &&
              expected.every((text) => parsed.body.textContent.includes(text)),
            firstCompletePaint: proof.firstCompletePaint,
            timeOrigin: performance.timeOrigin,
            skeleton: proof.skeleton,
            seedPaths,
          };
        },
        { html, path },
      );
      const firstTwoSeconds = api.filter((entry) => entry.at <= result.timeOrigin + 2000);
      const repeated = firstTwoSeconds.filter(
        (entry) => entry.method === 'GET' && result.seedPaths.map(normalize).includes(entry.path),
      );
      const report = {
        width,
        path,
        status: response.status(),
        htmlHasData: result.htmlHasData,
        firstCompletePaintMs: result.firstCompletePaint,
        apiBeforeComplete: api.filter(
          (entry) => entry.at <= result.timeOrigin + (result.firstCompletePaint ?? Infinity),
        ).length,
        apiFirstTwoSeconds: firstTwoSeconds.length,
        api: firstTwoSeconds,
        skeletonEver: result.skeleton,
        hydrationErrors: errors,
        repeatedSeededRequests: repeated,
      };
      reports.push(report);
      if (
        response.status() !== 200 ||
        !result.htmlHasData ||
        result.firstCompletePaint === null ||
        result.skeleton ||
        errors.length ||
        repeated.length
      )
        failures.push(report);
      console.log(JSON.stringify(report));
      await page.screenshot({
        path: resolve(output, `${width}-${path.replace(/[^a-z0-9]/gi, '_')}.png`),
      });
      await page.close();
    }
    // Bypass intent prefetch for this test so the click must wait for a cold, delayed response.
    const page = await context.newPage();
    await page.goto(`${origin}/dashboard/projects/many-tabs/issues`);
    await page.waitForSelector('[data-project-seed="tab"]', { state: 'attached' });
    const oldText = (await page.locator('.v2-project-page .dl-group').first().innerText())
      .trim()
      .split('\n')
      .find(Boolean);
    if (!oldText) throw new Error('Previous page has no identifiable data');
    await page.route('**/*', async (route) => {
      await new Promise((done) => setTimeout(done, 300));
      await route.continue();
    });
    await page.evaluate((oldText) => {
      window.__projectProof.skeleton = false;
      window.__projectProof.frames = [];
      window.__projectProof.navigation = { oldText };
      document.querySelector('.dl-tabs a[href$="/pipelines"]').click();
    }, oldText);
    await page.waitForSelector('.v2-pipelines', { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.dl-tabs .loading'), null, {
      timeout: 15000,
    });
    const navigation = await page.evaluate(() => {
      const proof = window.__projectProof;
      const pending = proof.frames.filter((frame) => frame.pending);
      return {
        skeletonEver: proof.skeleton,
        pendingFrames: pending.length,
        previousStayedWhilePending:
          pending.length > 0 && pending.every((frame) => frame.oldPresent),
        frames: proof.frames,
      };
    });
    const report = { width, navigation };
    reports.push(report);
    if (navigation.skeletonEver || !navigation.previousStayedWhilePending) failures.push(report);
    console.log(JSON.stringify(report));
    // Intent prefetch must issue exactly one route fetch and supply the subsequent click.
    for (const [source, target, selector] of [
      ['/dashboard/projects/many-tabs/issues', '/dashboard/projects/many-tabs/code', '.dl-tabs'],
      ['/dashboard/projects', '/dashboard/projects/many-tabs', '.v2-project-page'],
    ]) {
      const intentPage = await context.newPage();
      const requests = [];
      intentPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/__rsc' && url.searchParams.get('url') === target)
          requests.push(url.href);
      });
      await intentPage.goto(origin + source);
      await intentPage.waitForSelector('[data-project-seed="page"]', { state: 'attached' });
      await intentPage.waitForTimeout(150);
      const beforeIntent = requests.length;
      const link = intentPage.locator(`${selector} a[href="${target}"]`).first();
      const prefetched = intentPage.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === '/__rsc' && url.searchParams.get('url') === target;
      });
      await link.focus();
      await (await prefetched).finished();
      await link.click();
      await intentPage.waitForURL(origin + target);
      await intentPage.waitForFunction(() => !document.querySelector('.dl-tabs .loading'));
      const intent = { width, source, target, beforeIntent, routeRequests: requests.length };
      reports.push({ intent });
      if (beforeIntent !== 0 || requests.length !== 1) failures.push({ intent });
      console.log(JSON.stringify({ intent }));
      await intentPage.close();
    }
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ reports, failures }, null, 2));
}
if (failures.length) process.exitCode = 1;
