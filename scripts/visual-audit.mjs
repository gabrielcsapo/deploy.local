#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';
import {
  DASHBOARD_VISUAL_AUDIT_FLOWS,
  PUBLIC_VISUAL_AUDIT_FLOWS,
  VISUAL_AUDIT_VIEWPORTS,
} from './visual-audit.config.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

let browser;

try {
  const baseUrl = trimTrailingSlash(
    options.baseUrl || process.env.DEPLOY_AUDIT_BASE_URL || 'https://deploy.local',
  );
  const auth = await resolveAuthentication(baseUrl, options);
  if (!auth && !options.publicOnly) {
    throw new Error(
      'Dashboard screenshots require DEPLOY_AUDIT_USERNAME with DEPLOY_AUDIT_TOKEN or DEPLOY_AUDIT_PASSWORD. Use --public-only to capture only public and sign-in flows.',
    );
  }

  browser = await launchAuditBrowser(options.headed);
  const flows = selectFlows(
    buildFlowList({
      auth,
      publicOnly: options.publicOnly,
      dashboardOnly: options.dashboardOnly,
    }),
    options.flows,
  );
  const viewportNames = resolveViewports(options.viewports);
  const outputDirectory = resolve(
    repositoryRoot,
    options.output || join('artifacts', 'visual-audits', auditTimestamp()),
  );
  mkdirSync(outputDirectory, { recursive: true });

  const results = [];
  for (const colorScheme of options.colorSchemes) {
    for (const viewportName of viewportNames) {
      const {
        isMobile = false,
        hasTouch = false,
        ...viewport
      } = VISUAL_AUDIT_VIEWPORTS[viewportName];
      const anonymousContext = await browser.newContext({
        viewport,
        isMobile,
        hasTouch,
        ignoreHTTPSErrors: true,
        colorScheme,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      });
      const authenticatedContext = auth
        ? await browser.newContext({
            viewport,
            isMobile,
            hasTouch,
            ignoreHTTPSErrors: true,
            colorScheme,
            reducedMotion: 'reduce',
            deviceScaleFactor: 1,
          })
        : null;
      if (authenticatedContext) {
        await authenticatedContext.addInitScript(({ username, token }) => {
          localStorage.setItem('deploy-sh-auth', JSON.stringify({ username, token }));
        }, auth);
      }

      try {
        for (const flow of flows) {
          if (flow.viewports && !flow.viewports.includes(viewportName)) continue;
          const context = flow.session === 'anonymous' ? anonymousContext : authenticatedContext;
          if (!context) {
            results.push({
              ...publicResultFields(flow, viewportName, baseUrl),
              status: 'skipped',
              reason: 'Authentication was not supplied',
            });
            continue;
          }
          const result = await captureFlow({
            context,
            flow,
            viewportName,
            baseUrl,
            outputDirectory: join(outputDirectory, colorScheme),
            strict: options.strict,
          });
          result.image = result.image ? `${colorScheme}/${result.image}` : undefined;
          result.colorScheme = colorScheme;
          results.push(result);
          const marker =
            result.status === 'captured' ? '✓' : result.status === 'skipped' ? '–' : '✗';
          console.log(`${marker} ${viewportName.padEnd(7)} ${flow.id}`);
        }
      } finally {
        await anonymousContext.close();
        await authenticatedContext?.close();
      }
    }
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl,
    viewports: viewportNames,
    colorSchemes: options.colorSchemes,
    totals: summarize(results),
    results,
  };
  writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outputDirectory, 'index.html'), renderContactSheet(report));

  const relativeOutput = relative(repositoryRoot, outputDirectory) || '.';
  console.log(`\nVisual audit: ${relativeOutput}/index.html`);
  console.log(
    `${report.totals.captured} captured · ${report.totals.skipped} skipped · ${report.totals.failed} failed · ${report.totals.browserErrors} browser errors`,
  );
  if (report.totals.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error(`Visual audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}

function parseArguments(args) {
  const parsed = {
    baseUrl: '',
    dashboardOnly: false,
    flows: [],
    headed: false,
    help: false,
    output: '',
    publicOnly: false,
    strict: false,
    viewports: ['desktop', 'mobile'],
    colorSchemes: ['dark'],
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    const [name, inlineValue] = argument.split('=', 2);
    const value = () => inlineValue ?? args[++index];
    if (name === '--flow') parsed.flows.push(value());
    else if (name === '--base-url') parsed.baseUrl = value();
    else if (name === '--output') parsed.output = value();
    else if (name === '--viewports') parsed.viewports = value().split(',').filter(Boolean);
    else if (name === '--color-schemes') parsed.colorSchemes = value().split(',').filter(Boolean);
    else if (name === '--dashboard-only') parsed.dashboardOnly = true;
    else if (name === '--headed') parsed.headed = true;
    else if (name === '--help' || name === '-h') parsed.help = true;
    else if (name === '--public-only') parsed.publicOnly = true;
    else if (name === '--strict') parsed.strict = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (parsed.publicOnly && parsed.dashboardOnly) {
    throw new Error('--public-only and --dashboard-only cannot be used together');
  }
  if (parsed.colorSchemes.some((scheme) => !['light', 'dark'].includes(scheme)))
    throw new Error('Color schemes must be light or dark');
  return parsed;
}

function printHelp() {
  console.log(`deploy.local visual audit

Usage:
  pnpm audit:visual -- --base-url https://deploy.local

Authentication for a real server:
  DEPLOY_AUDIT_USERNAME=admin DEPLOY_AUDIT_TOKEN=... pnpm audit:visual
  DEPLOY_AUDIT_USERNAME=admin DEPLOY_AUDIT_PASSWORD=... pnpm audit:visual

Options:
  --base-url URL         Server to audit (default: https://deploy.local)
  --output PATH          Output folder (default: artifacts/visual-audits/<timestamp>)
  --color-schemes LIST   dark,light (default: dark)
  --viewports LIST       desktop,mobile or one named viewport
  --flow ID              Capture one named flow; repeatable (default: all)
  --public-only          Capture public pages and the unauthenticated sign-in flow
  --dashboard-only       Skip public documentation and sign-in flows
  --strict               Treat browser console errors as capture failures
  --headed               Show the audit browser while it runs
  --help                 Show this help
`);
}

async function resolveAuthentication(baseUrl, runtimeOptions) {
  if (runtimeOptions.publicOnly) return null;
  const username = process.env.DEPLOY_AUDIT_USERNAME;
  const token = process.env.DEPLOY_AUDIT_TOKEN;
  if (username && token) return { username, token };
  const password = process.env.DEPLOY_AUDIT_PASSWORD;
  if (!username || !password) return null;
  const api = await playwrightRequest.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true });
  try {
    const response = await api.post('/api/login', { data: { username, password } });
    if (!response.ok()) throw new Error(`Login returned HTTP ${response.status()}`);
    const body = await response.json();
    if (typeof body.token !== 'string') throw new Error('Login response did not include a token');
    return { username, token: body.token };
  } finally {
    await api.dispose();
  }
}

function buildFlowList({ auth, publicOnly, dashboardOnly }) {
  const flows = dashboardOnly ? [] : [...PUBLIC_VISUAL_AUDIT_FLOWS];
  if (!publicOnly && auth) {
    flows.push(...DASHBOARD_VISUAL_AUDIT_FLOWS);
  }
  return flows;
}

function selectFlows(available, requested) {
  if (!requested.length) return available;
  const requestedIds = new Set(requested);
  const selected = available.filter((flow) => requestedIds.has(flow.id));
  const found = new Set(selected.map((flow) => flow.id));
  const missing = requested.filter((id) => !found.has(id));
  if (missing.length) throw new Error(`Visual audit flows not found: ${missing.join(', ')}`);
  return selected;
}

async function verifyListLayout(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  if (overflow) throw new Error('The page overflows its viewport horizontally');
  const search = page.locator('.ui-search-field input').first();
  if (!(await search.count())) return { horizontalOverflow: false };
  const height = await search
    .locator('..')
    .evaluate((field) => field.getBoundingClientRect().height);
  if (Math.abs(height - 36) > 1)
    throw new Error(`List search draws at ${height}px instead of 36px`);
  await search.focus();
  if (!(await search.evaluate((input) => input === document.activeElement)))
    throw new Error('List search did not receive keyboard focus');
  const rows = page.locator('.ui-list-row, .ds-catalog-row');
  const initialRows = await rows.count();
  if (initialRows) {
    await search.fill('visual-audit-no-matching-resource');
    await page.waitForFunction(() => !document.querySelector('.ui-list-row, .ds-catalog-row'));
    await search.fill('');
    await page.waitForFunction(
      (count) => document.querySelectorAll('.ui-list-row, .ds-catalog-row').length === count,
      initialRows,
    );
  }
  await search.press('Tab');
  if (await search.evaluate((input) => input === document.activeElement))
    throw new Error('List search traps keyboard focus');
  await page.evaluate(
    () => document.activeElement instanceof HTMLElement && document.activeElement.blur(),
  );
  return {
    horizontalOverflow: false,
    searchHeight: height,
    keyboardFocus: true,
    filterRestoredRows: initialRows,
  };
}

async function captureFlow({ context, flow, viewportName, baseUrl, outputDirectory, strict }) {
  const result = publicResultFields(flow, viewportName, baseUrl);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const location = message.location();
    const source = location.url
      ? ` (${location.url}${location.lineNumber ? `:${location.lineNumber + 1}` : ''})`
      : '';
    consoleErrors.push(`${message.text()}${source}`);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    const response = await page.goto(result.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    await settlePage(page);
    const checks = strict ? await verifyListLayout(page) : undefined;
    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-delay: 0s !important;
          animation-duration: 0s !important;
          caret-color: transparent !important;
          scroll-behavior: auto !important;
          transition-duration: 0s !important;
        }
      `,
    });
    const relativeImage = `${viewportName}/${flow.id}.png`;
    const imagePath = join(outputDirectory, relativeImage);
    mkdirSync(dirname(imagePath), { recursive: true });
    await page.screenshot({ path: imagePath, fullPage: flow.fullPage !== false });
    const errors = [...consoleErrors, ...pageErrors];
    if (strict && errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);
    return {
      ...result,
      status: 'captured',
      checks,
      image: relativeImage,
      title: await page.title(),
      consoleErrors: errors,
    };
  } catch (error) {
    if (flow.optional && /Optional UI state/.test(String(error))) {
      return { ...result, status: 'skipped', reason: String(error) };
    }
    const relativeImage = `${viewportName}/${flow.id}.error.png`;
    const imagePath = join(outputDirectory, relativeImage);
    mkdirSync(dirname(imagePath), { recursive: true });
    await page.screenshot({ path: imagePath, fullPage: true }).catch(() => {});
    return {
      ...result,
      status: 'failed',
      image: relativeImage,
      error: error instanceof Error ? error.message : String(error),
      consoleErrors: [...consoleErrors, ...pageErrors],
    };
  } finally {
    await page.close();
  }
}

async function settlePage(page) {
  await page.locator('body').waitFor({ state: 'visible', timeout: 20_000 });
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {});
  await page.waitForTimeout(350);
}

async function launchAuditBrowser(headed) {
  try {
    return await chromium.launch({ headless: !headed });
  } catch (error) {
    try {
      return await chromium.launch({ headless: !headed, channel: 'chrome' });
    } catch {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nInstall the audit browser with: pnpm audit:visual:install`,
      );
    }
  }
}

function renderContactSheet(report) {
  const viewportSummary = report.viewports
    .map((name) => {
      const viewport = VISUAL_AUDIT_VIEWPORTS[name];
      return `${name} ${viewport.width}×${viewport.height}`;
    })
    .join(' · ');
  const cards = report.results
    .map((result) => {
      const image = result.image
        ? `<a class="shot" href="${escapeHtml(result.image)}" title="Open full-resolution screenshot"><img loading="lazy" src="${escapeHtml(result.image)}" alt="${escapeHtml(result.flowTitle)}"></a>`
        : '<div class="empty">No image</div>';
      const browserErrorCount = result.consoleErrors?.length || 0;
      const issue =
        result.error ||
        result.reason ||
        (browserErrorCount
          ? `${browserErrorCount} browser error${browserErrorCount === 1 ? '' : 's'} recorded in manifest.json`
          : '');
      return `<article class="card viewport-${result.viewport} status-${result.status}${browserErrorCount ? ' has-browser-errors' : ''}">
        <header><span>${escapeHtml(result.viewport)} · ${escapeHtml(result.colorScheme || 'dark')}</span><b>${escapeHtml(result.flowTitle)}</b></header>
        ${image}
        <footer><code>${escapeHtml(result.path)}</code>${issue ? `<p>${escapeHtml(issue)}</p>` : ''}</footer>
      </article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>deploy.local visual audit</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080b10; color: #edf2ff; }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 1072px; padding: 24px; }
    .summary { display: flex; flex-wrap: wrap; gap: 18px; align-items: end; margin-bottom: 28px; }
    .summary h1 { font-size: 24px; margin: 0 18px 0 0; }
    .summary p { color: #94a1b8; margin: 0; }
    main { display: grid; gap: 28px; min-width: 1024px; }
    .card { overflow: hidden; border: 1px solid #273042; border-radius: 12px; background: #10151e; box-shadow: 0 14px 42px rgb(0 0 0 / .25); }
    .card header, .card footer { padding: 12px 14px; }
    .card header { display: flex; gap: 10px; border-bottom: 1px solid #273042; }
    .card header span { color: #7c9cff; font: 11px ui-monospace, monospace; text-transform: uppercase; }
    .card header b { font-size: 13px; }
    .shot { display: flex; min-height: 700px; align-items: flex-start; justify-content: center; background: #080b10; }
    .card img { display: block; width: 100%; height: auto; }
    .viewport-mobile .shot { align-items: flex-start; padding: 28px; }
    .viewport-mobile img { width: 375px; max-width: 375px; }
    .card footer { border-top: 1px solid #273042; color: #94a1b8; }
    .card footer code { font-size: 11px; }
    .card footer p { color: #ffb86c; font-size: 12px; margin: 8px 0 0; }
    .status-failed { border-color: #ff637d; }
    .status-skipped { opacity: .65; }
    .has-browser-errors { border-color: #b47b35; }
    .empty { min-height: 160px; display: grid; place-items: center; color: #69758a; }
  </style>
</head>
<body>
  <section class="summary">
    <h1>deploy.local visual audit</h1>
    <p>${escapeHtml(report.generatedAt)}</p>
    <p>${escapeHtml(viewportSummary)} · 1024×700 minimum review surface</p>
    <p>${report.totals.captured} captured · ${report.totals.skipped} skipped · ${report.totals.failed} failed · ${report.totals.browserErrors} browser errors</p>
  </section>
  <main>${cards}</main>
</body>
</html>\n`;
}

function publicResultFields(flow, viewport, baseUrl) {
  return {
    flowId: flow.id,
    flowTitle: flow.title,
    path: flow.path,
    viewport,
    url: `${baseUrl}${flow.path}`,
  };
}

function summarize(results) {
  return {
    captured: results.filter((result) => result.status === 'captured').length,
    skipped: results.filter((result) => result.status === 'skipped').length,
    failed: results.filter((result) => result.status === 'failed').length,
    browserErrors: results.reduce(
      (total, result) => total + (result.consoleErrors?.length || 0),
      0,
    ),
  };
}

function resolveViewports(requested) {
  const unknown = requested.filter((name) => !VISUAL_AUDIT_VIEWPORTS[name]);
  if (unknown.length) throw new Error(`Unknown viewports: ${unknown.join(', ')}`);
  return [...new Set(requested)];
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function auditTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
