#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { chromium, request as playwrightRequest } from 'playwright';
import {
  DASHBOARD_VISUAL_AUDIT_FLOWS,
  PUBLIC_VISUAL_AUDIT_FLOWS,
  VISUAL_AUDIT_VIEWPORTS,
  applicationRouteFlows,
  catalogDetailFlow,
  commandCenterInteractionFlows,
} from './visual-audit.config.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const options = parseArguments(process.argv.slice(2));

if (options.help) {
  printHelp();
  process.exit(0);
}

let demoRuntime;
let browser;

try {
  if (options.demo) demoRuntime = await startDemoRuntime(options);
  const baseUrl = trimTrailingSlash(
    demoRuntime?.baseUrl ||
      options.baseUrl ||
      process.env.DEPLOY_AUDIT_BASE_URL ||
      'https://deploy.local',
  );
  const auth = await resolveAuthentication(baseUrl, demoRuntime?.auth, options);
  if (!auth && !options.publicOnly) {
    throw new Error(
      'Dashboard screenshots require DEPLOY_AUDIT_USERNAME with DEPLOY_AUDIT_TOKEN or DEPLOY_AUDIT_PASSWORD. Use --public-only to capture only public and sign-in flows.',
    );
  }

  browser = await launchAuditBrowser(options.headed);
  const inventory = auth
    ? await discoverInventory(baseUrl, auth)
    : { applications: [], catalogRelease: null };
  const selectedApplications = selectApplications(
    demoRuntime?.auth.applications || inventory.applications,
    options.applications,
  );
  const flows = selectFlows(
    buildFlowList({
      auth,
      applications: selectedApplications,
      catalogRelease: inventory.catalogRelease,
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
  for (const viewportName of viewportNames) {
    const { isMobile = false, ...viewport } = VISUAL_AUDIT_VIEWPORTS[viewportName];
    const anonymousContext = await browser.newContext({
      viewport,
      isMobile,
      ignoreHTTPSErrors: true,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      deviceScaleFactor: 1,
    });
    const authenticatedContext = auth
      ? await browser.newContext({
          viewport,
          isMobile,
          ignoreHTTPSErrors: true,
          colorScheme: 'dark',
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
          outputDirectory,
          strict: options.strict,
        });
        results.push(result);
        const marker = result.status === 'captured' ? '✓' : result.status === 'skipped' ? '–' : '✗';
        console.log(`${marker} ${viewportName.padEnd(7)} ${flow.id}`);
      }
    } finally {
      await anonymousContext.close();
      await authenticatedContext?.close();
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl,
    demo: Boolean(options.demo),
    viewports: viewportNames,
    applications: selectedApplications,
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
  await demoRuntime?.stop();
}

function parseArguments(args) {
  const parsed = {
    applications: [],
    baseUrl: '',
    dashboardOnly: false,
    demo: false,
    flows: [],
    headed: false,
    help: false,
    keepDemoData: false,
    noBuild: false,
    output: '',
    publicOnly: false,
    strict: false,
    viewports: ['desktop', 'mobile'],
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') continue;
    const [name, inlineValue] = argument.split('=', 2);
    const value = () => inlineValue ?? args[++index];
    if (name === '--app') parsed.applications.push(value());
    else if (name === '--flow') parsed.flows.push(value());
    else if (name === '--base-url') parsed.baseUrl = value();
    else if (name === '--output') parsed.output = value();
    else if (name === '--viewports') parsed.viewports = value().split(',').filter(Boolean);
    else if (name === '--dashboard-only') parsed.dashboardOnly = true;
    else if (name === '--demo') parsed.demo = true;
    else if (name === '--headed') parsed.headed = true;
    else if (name === '--help' || name === '-h') parsed.help = true;
    else if (name === '--keep-demo-data') parsed.keepDemoData = true;
    else if (name === '--no-build') parsed.noBuild = true;
    else if (name === '--public-only') parsed.publicOnly = true;
    else if (name === '--strict') parsed.strict = true;
    else throw new Error(`Unknown option ${argument}`);
  }
  if (parsed.publicOnly && parsed.dashboardOnly) {
    throw new Error('--public-only and --dashboard-only cannot be used together');
  }
  return parsed;
}

function printHelp() {
  console.log(`deploy.local visual audit

Usage:
  pnpm audit:visual -- --base-url https://deploy.local
  pnpm audit:visual:demo

Authentication for a real server:
  DEPLOY_AUDIT_USERNAME=admin DEPLOY_AUDIT_TOKEN=... pnpm audit:visual
  DEPLOY_AUDIT_USERNAME=admin DEPLOY_AUDIT_PASSWORD=... pnpm audit:visual

Options:
  --demo                 Build and start an isolated, seeded demo fleet
  --no-build             Reuse the existing dist/ output in demo mode
  --base-url URL         Server to audit (default: https://deploy.local)
  --output PATH          Output folder (default: artifacts/visual-audits/<timestamp>)
  --viewports LIST       desktop,mobile or one named viewport
  --app NAME             Capture app detail flows for NAME; repeatable (default: all)
  --flow ID              Capture one named flow; repeatable (default: all)
  --public-only          Capture public pages and the unauthenticated sign-in flow
  --dashboard-only       Skip public documentation and sign-in flows
  --strict               Treat browser console errors as capture failures
  --headed               Show the audit browser while it runs
  --keep-demo-data       Keep the temporary demo data directory
  --help                 Show this help
`);
}

async function startDemoRuntime(runtimeOptions) {
  if (!runtimeOptions.noBuild) await runCommand(packageManagerCommand(), ['build']);
  const dataDirectory = mkdtempSync(join(tmpdir(), 'deploy-local-visual-audit-'));
  const { seedVisualAuditDemo } = await import('./visual-audit-demo.mjs');
  const auth = await seedVisualAuditDemo(dataDirectory);
  const httpPort = await availablePort();
  let httpsPort = await availablePort();
  while (httpsPort === httpPort) httpsPort = await availablePort();
  const child = spawn(process.execPath, [join(repositoryRoot, 'dist', 'server.js')], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DEPLOY_DATA_DIR: dataDirectory,
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      DEPLOY_NODE_NAME: 'Home gateway',
      PORT: String(httpPort),
      HTTPS_PORT: String(httpsPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-12_000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  await waitForServer(
    child,
    () => output.includes('server running on'),
    90_000,
    () => output,
  );
  console.log(`Demo fleet ready in ${dataDirectory}`);
  return {
    auth,
    baseUrl: `https://127.0.0.1:${httpsPort}`,
    async stop() {
      await stopChild(child);
      if (!runtimeOptions.keepDemoData) rmSync(dataDirectory, { recursive: true, force: true });
      else console.log(`Kept demo data at ${dataDirectory}`);
    },
  };
}

async function resolveAuthentication(baseUrl, demoAuth, runtimeOptions) {
  if (runtimeOptions.publicOnly) return null;
  if (demoAuth) return { username: demoAuth.username, token: demoAuth.token };
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

async function discoverInventory(baseUrl, auth) {
  const api = await playwrightRequest.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true });
  const headers = {
    'x-deploy-username': auth.username,
    'x-deploy-token': auth.token,
  };
  try {
    const [deploymentsResponse, catalogResponse] = await Promise.all([
      api.get('/api/deployments', { headers }),
      api.get('/api/catalog', { headers }),
    ]);
    const deployments = deploymentsResponse.ok() ? await deploymentsResponse.json() : [];
    const catalog = catalogResponse.ok() ? await catalogResponse.json() : { releases: [] };
    return {
      applications: Array.isArray(deployments)
        ? deployments
            .map((deployment) => deployment.name)
            .filter((name) => typeof name === 'string')
        : [],
      catalogRelease: Array.isArray(catalog.releases) ? catalog.releases[0] || null : null,
    };
  } finally {
    await api.dispose();
  }
}

function selectApplications(discovered, requested) {
  const unique = [...new Set(discovered)].sort();
  if (!requested.length) return unique;
  const missing = requested.filter((name) => !unique.includes(name));
  if (missing.length) throw new Error(`Applications not found: ${missing.join(', ')}`);
  return [...new Set(requested)];
}

function buildFlowList({ auth, applications, catalogRelease, publicOnly, dashboardOnly }) {
  const flows = dashboardOnly ? [] : [...PUBLIC_VISUAL_AUDIT_FLOWS];
  if (!publicOnly && auth) {
    flows.push(...DASHBOARD_VISUAL_AUDIT_FLOWS, ...catalogDetailFlow(catalogRelease));
    for (const applicationName of applications) {
      flows.push(
        ...commandCenterInteractionFlows(applicationName),
        ...applicationRouteFlows(applicationName),
      );
    }
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
    const actionResult = await runFlowAction(page, flow);
    if (actionResult === 'skip') {
      return { ...result, status: 'skipped', reason: 'Optional UI state was not present' };
    }
    await settlePage(page);
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

async function runFlowAction(page, flow) {
  if (!flow.action) return 'capture';
  if (flow.action === 'open-home-search') {
    await page.getByRole('button', { name: 'Search your cloud' }).click();
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ state: 'visible' });
    return 'capture';
  }
  if (flow.action === 'select-public-cloud-mode') {
    await page.locator(`[data-audit-cloud-mode="${attributeValue(flow.actionValue)}"]`).click();
    await page
      .locator(`[data-audit-cloud-state="${attributeValue(flow.actionValue)}"]`)
      .waitFor({ state: 'visible' });
    return 'capture';
  }
  if (flow.action === 'open-docs-navigation') {
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('#mobile-docs-navigation').waitFor({ state: 'visible' });
    return 'capture';
  }
  if (flow.action === 'open-command-palette') {
    await page.getByRole('button', { name: 'Navigate or run a command' }).click();
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor();
    return 'capture';
  }
  if (flow.action === 'open-signal-detail') {
    await page.locator(`[data-audit-signal="${attributeValue(flow.actionValue)}"]`).click();
    await page
      .locator(`[data-audit-signal-modal="${attributeValue(flow.actionValue)}"]`)
      .waitFor({ state: 'visible' });
    return 'capture';
  }
  if (flow.action === 'zoom-topology') {
    const viewport = page.locator('[data-audit-topology-viewport]');
    const zoom = page.locator('.cloud-zoom-value');
    const before = await zoom.textContent();
    const pageBefore = await page.evaluate(() => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    const bounds = await viewport.boundingBox();
    if (!bounds) throw new Error('Topology viewport is not visible');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(120);
    const after = await zoom.textContent();
    const pageAfter = await page.evaluate(() => ({
      scale: window.visualViewport?.scale ?? 1,
      width: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio,
    }));
    if (!before || !after || before === after) {
      throw new Error(`Topology trackpad zoom did not change (${before || 'unknown'})`);
    }
    if (JSON.stringify(pageBefore) !== JSON.stringify(pageAfter)) {
      throw new Error('Topology gesture changed the browser page zoom');
    }
    return 'capture';
  }
  const openInspector = page.locator('[data-audit-inspector]:visible');
  if ((await openInspector.count()) > 0) {
    await openInspector.getByRole('button', { name: 'Close details' }).click({ timeout: 3_000 });
    await openInspector.waitFor({ state: 'hidden', timeout: 3_000 });
  }
  const app = page.locator(`[data-audit-app="${attributeValue(flow.applicationName)}"]`);
  await app.waitFor({ state: 'visible', timeout: 20_000 });
  if (
    flow.action === 'select-application' ||
    flow.action === 'select-application-traffic' ||
    flow.action === 'select-application-configuration'
  ) {
    await app.locator('[data-audit-target="application"]').click();
    await page.locator('[data-audit-inspector]').waitFor({ state: 'visible' });
    if (flow.action === 'select-application-traffic') {
      await page.getByRole('tab', { name: 'traffic', exact: true }).click();
    }
    if (flow.action === 'select-application-configuration') {
      await page.getByRole('tab', { name: 'config', exact: true }).click();
    }
    return 'capture';
  }
  const selector =
    flow.action === 'select-component'
      ? '[data-audit-target="component"]'
      : '[data-audit-target="resource"]';
  const target = app.locator(selector).first();
  if ((await target.count()) === 0) return 'skip';
  await target.click();
  await page.locator('[data-audit-inspector]').waitFor({ state: 'visible' });
  return 'capture';
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
        <header><span>${escapeHtml(result.viewport)}</span><b>${escapeHtml(result.flowTitle)}</b></header>
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
    .viewport-mobile img { width: 390px; max-width: 390px; }
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

function packageManagerCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

async function runCommand(command, args) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit' });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function availablePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createNetServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('Could not allocate an audit port'));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
    server.on('error', rejectPromise);
  });
}

function waitForServer(child, ready, timeoutMs, output) {
  return new Promise((resolvePromise, rejectPromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        rejectPromise(
          new Error(`Demo server did not start within ${timeoutMs / 1000}s\n${output()}`),
        );
      }
    }, 100);
    child.once('exit', (code) => {
      clearInterval(timer);
      rejectPromise(new Error(`Demo server exited with code ${code}\n${output()}`));
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolvePromise) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

function auditTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function attributeValue(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
