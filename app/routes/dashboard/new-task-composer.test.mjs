import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Isolated fixtures served to the browser; no coordinator, account or repository is touched.
const project = { id: 'p1', name: 'Tally', status: 'ready' };
const state = {
  cursor: 1,
  projects: [project],
  tasks: [],
  workers: [
    {
      id: 'local',
      name: 'This computer',
      status: 'online',
      platform: 'darwin',
      capabilities: ['codex'],
      roles: { tasks: { state: 'ready', reason: 'A task worker is available.' } },
    },
  ],
  adapters: [{ id: 'codex', name: 'Codex', available: true, capabilities: {} }],
};
const repository = {
  status: 'ready',
  defaultBranch: 'main',
  head: 'b'.repeat(40),
  refs: [{ name: 'refs/heads/main', oid: 'b'.repeat(40) }],
  clonePath: '/git/test/tally.git',
};
const tree = {
  commit: 'b'.repeat(40),
  entries: [{ name: 'server.ts', path: 'server.ts', type: 'blob', size: 120 }],
};

/**
 * The real client router pushes the new URL at once and renders the route when its payload
 * arrives. That payload is the second this change is about, so this stub reports the new
 * pathname only after `DELAY`, and counts the navigations still in flight.
 */
const DELAY = 1500;
const router = `
import React, {useCallback, useEffect, useState} from 'react';
const CHANGED = 'deploy:test-navigated';
const DELAY = ${DELAY};
window.pendingRoutes = 0;
let committed = location.pathname + location.search;
const path = () => committed;
function commit(to) {
  committed = to;
  window.dispatchEvent(new Event(CHANGED));
}
function go(to, options = {}) {
  history[options.replace ? 'replaceState' : 'pushState'](history.state, '', to);
  if (options.replace) return commit(to);
  window.pendingRoutes++;
  setTimeout(() => { window.pendingRoutes--; commit(to); }, DELAY);
}
function useUrl() {
  const [url, setUrl] = useState(path);
  useEffect(() => {
    const sync = () => setUrl(path());
    const pop = () => commit(location.pathname + location.search);
    window.addEventListener('popstate', pop);
    window.addEventListener(CHANGED, sync);
    return () => { window.removeEventListener('popstate', pop); window.removeEventListener(CHANGED, sync); };
  }, []);
  return url;
}
export function useRouter() {
  return { url: useUrl(), navigate: go, refresh: async () => {}, params: {}, segments: {} };
}
export function useLocation() { return { pathname: new URL(useUrl(), location.origin).pathname }; }
export function useNavigation() { return { state: window.pendingRoutes ? 'loading' : 'idle' }; }
export function useParams() { return {}; }
export function useCloseSlot() { return () => {}; }
export function useSearchParams() {
  const url = useUrl();
  return [new URL(url, location.origin).searchParams, (next) => {
    const current = new URL(path(), location.origin).searchParams;
    const value = typeof next === 'function' ? next(current) : next;
    go(location.pathname + (String(value) ? '?' + String(value) : ''));
  }];
}
export function Link({to, children, replace, preventScrollReset, ...rest}) {
  const click = useCallback((event) => { event.preventDefault(); go(to, {replace}); }, [to, replace]);
  return React.createElement('a', {href: to, ...rest, onClick: click}, children);
}
export const Outlet = () => null;
export const SegmentRoot = ({children}) => children;
export const Loading = ({children}) => children;
export const ErrorBoundary = ({children}) => children;
export const ScrollRestoration = () => null;
`;

/**
 * `'use server'` modules become client proxies in a real build. Here each one is replaced by a
 * stub with the same export names, so the bundle stays a browser bundle instead of pulling the
 * coordinator's server modules into the page.
 */
function stubActions(name) {
  const source = readFileSync(resolve('app/actions', `${name}.ts`), 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm))
    names.add(match[1]);
  for (const match of source.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) names.add(match[1]);
  if (!names.size) throw new Error(`No exports found in app/actions/${name}.ts`);
  return [...names].map((exported) => `export const ${exported} = async () => null;`).join('\n');
}
const actionModule = /(?:^|\/)(?:\.\.\/)+actions\/([\w-]+)$/;

/** The reads the workspace and the repository page make, with the shapes the client expects. */
const fixture = (path) =>
  path.startsWith('/state')
    ? state
    : path.startsWith('/events')
      ? { events: [], cursor: 1 }
      : path.startsWith('/transcription')
        ? { available: false }
        : path === `/projects/${project.id}/repository`
          ? repository
          : path.startsWith(`/projects/${project.id}/repository/history`)
            ? { commits: [] }
            : path.startsWith(`/projects/${project.id}/repository/tree`)
              ? tree
              : path.endsWith('/controls')
                ? { requests: [], sessions: [], commands: [], targets: [] }
                : {};

const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ProjectsClient from './app/routes/dashboard/projects.client.tsx';
import './app/design-tokens.css';
import './app/motion.css';
import './app/components/ui/ui.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({username:'test', token:'fixture'}));
createRoot(document.getElementById('root')).render(<ProjectsClient/>);
`;

async function workspacePage(browser, viewport, html) {
  const page = await browser.newPage({ viewport });
  await page.route('**/api/workspace/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(fixture(path)) });
  });
  // Every page route but the workspace API, which the handler above answers.
  await page.route(/^https:\/\/composer\.test\/(?!api\/)/, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  return page;
}

/** Set DEPLOY_UI_SHOTS=<directory> to keep the captures this test takes. */
const shots = process.env.DEPLOY_UI_SHOTS;
async function capture(page, name) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: join(shots, `${name}.png`) });
}

test('New task on a repository page opens the composer before its route loads, and the project reads as part of the heading', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'new-task-composer-test',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'new-task-composer-test') return resolve('new-task-composer-test.tsx');
          if (id === 'react-flight-router/client') return resolve('test-router.tsx');
          const action = id.match(actionModule);
          if (action) return resolve(`test-action-${action[1]}.tsx`);
        },
        load(id) {
          if (id === resolve('new-task-composer-test.tsx')) return entry;
          if (id === resolve('test-router.tsx')) return router;
          const stub = id.match(/test-action-([\w-]+)\.tsx$/);
          if (stub) return stubActions(stub[1]);
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: 'new-task-composer-test', output: { inlineDynamicImports: true } },
    },
  });
  const script = bundle.output.find((item) => item.type === 'chunk').code;
  const css = bundle.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    for (const [label, viewport] of [
      ['phone', { width: 375, height: 812 }],
      ['desktop', { width: 1440, height: 900 }],
    ]) {
      const page = await workspacePage(browser, viewport, html);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`https://composer.test/${project.name}`);
      await page.getByRole('button', { name: 'server.ts' }).waitFor();
      await capture(page, `repository-${label}`);

      // One click, no waiting: the composer is on screen while `/dashboard` is still loading.
      await page.getByRole('button', { name: 'New task', exact: true }).click();
      const heading = page.getByRole('heading', { level: 1 });
      await heading.waitFor({ timeout: DELAY / 3 });
      assert.equal(await heading.textContent(), `What should we build in ${project.name}?`);
      assert.ok(
        await page.evaluate(() => window.pendingRoutes > 0),
        'the composer must not wait for the route payload',
      );
      // The project is preset, so the first message starts in this repository.
      await page
        .locator('.pw-composer-context-tray, .pw-phone-context-chip')
        .first()
        .getByText(project.name, { exact: false })
        .first()
        .waitFor();
      await capture(page, `composer-${label}`);

      // The project is one word of the question: the heading's own size and weight.
      const type = await page.evaluate(() => {
        const title = document.querySelector('.pw-new-task-prompt h1');
        const name = title.querySelector('.pw-new-task-project');
        const style = (element) => {
          const computed = getComputedStyle(element);
          return {
            size: computed.fontSize,
            weight: computed.fontWeight,
            family: computed.fontFamily,
          };
        };
        return { title: style(title), name: style(name), text: name.textContent };
      });
      assert.equal(type.text, project.name);
      assert.deepEqual(type.name, type.title, `${label}: project name matches the heading`);
      assert.ok(parseFloat(type.name.size) >= 24, `${label}: ${type.name.size} is display type`);

      // The route lands on /dashboard without taking the composer away again.
      await page.waitForFunction(() => window.pendingRoutes === 0);
      assert.equal(new URL(page.url()).pathname, '/dashboard');
      assert.equal(await heading.textContent(), `What should we build in ${project.name}?`);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
