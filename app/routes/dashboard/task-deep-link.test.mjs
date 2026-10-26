import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Isolated fixtures served to the browser; no coordinator, account or task data is touched.
const task = {
  id: 'deep-link-task',
  title: 'Deep linked task',
  projectId: null,
  status: 'review',
  workerId: 'local',
  revision: 0,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};
const state = {
  cursor: 1,
  projects: [],
  tasks: [task],
  workers: [{ id: 'local', name: 'This computer', status: 'online', capabilities: ['codex'] }],
  adapters: [{ id: 'codex', name: 'Codex', available: true, capabilities: {} }],
};
const detail = {
  task,
  runs: [],
  messages: [
    {
      id: 'm1',
      taskId: task.id,
      role: 'assistant',
      content: 'Deployed the fix.',
      createdAt: task.createdAt,
    },
  ],
  jobs: [],
  activity: [],
  attachments: [],
  pullRequests: [],
  questions: [],
};
const diff = {
  baseRevision: 'a'.repeat(40),
  headRevision: 'a'.repeat(40),
  patch: '',
  status: '',
  files: [],
  excluded: [],
  checks: [],
};

// The real client router pulls in the RSC runtime, which cannot evaluate in a bare page.
// The dashboard only needs these four hooks plus Link, over the browser's own history.
const router = `
import React, {useCallback, useEffect, useState} from 'react';
const path = () => location.pathname + location.search;
const CHANGED = 'deploy:test-navigated';
function go(to, options = {}) {
  history[options.replace ? 'replaceState' : 'pushState'](history.state, '', to);
  window.dispatchEvent(new Event(CHANGED));
}
function useUrl() {
  const [url, setUrl] = useState(path);
  useEffect(() => {
    const sync = () => setUrl(path());
    window.addEventListener('popstate', sync);
    window.addEventListener(CHANGED, sync);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener(CHANGED, sync); };
  }, []);
  return url;
}
export function useRouter() {
  return { url: useUrl(), navigate: go, refresh: async () => {}, params: {}, segments: {} };
}
export function useLocation() { return { pathname: new URL(useUrl(), location.origin).pathname }; }
export function useNavigation() { return { state: 'idle' }; }
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

/** The reads the workspace makes on first paint, with the shapes the client expects. */
const fixture = (path) =>
  path.startsWith('/state')
    ? state
    : path.startsWith('/events')
      ? { events: [], cursor: 1 }
      : path.startsWith('/transcription')
        ? { available: false }
        : path === `/tasks/${task.id}`
          ? detail
          : path.startsWith(`/tasks/${task.id}/diff`)
            ? diff
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

/** Which pane the phone layout is actually showing, from computed styles. */
const showing = (page) =>
  page.evaluate(() => {
    const visible = (selector) => {
      const element = document.querySelector(selector);
      return Boolean(element) && getComputedStyle(element).display !== 'none';
    };
    return {
      conversation: visible('.pw-chat'),
      list: visible('.pw-sidebar.task-navigation'),
    };
  });

test('a phone-width deep link to /dashboard?task=<id> opens the task, and Back returns to the list', async () => {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'task-deep-link-test',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'task-deep-link-test') return resolve('task-deep-link-test.tsx');
          if (id === 'react-flight-router/client') return resolve('test-router.tsx');
          const action = id.match(actionModule);
          if (action) return resolve(`test-action-${action[1]}.tsx`);
        },
        load(id) {
          if (id === resolve('task-deep-link-test.tsx')) return entry;
          if (id === resolve('test-router.tsx')) return router;
          const stub = id.match(/test-action-([\w-]+)\.tsx$/);
          if (stub) return stubActions(stub[1]);
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: 'task-deep-link-test', output: { inlineDynamicImports: true } },
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/workspace/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fixture(path)),
      });
    });
    await page.route(/^https:\/\/deep-link\.test\/dashboard/, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );

    // A notification link lands straight on the task: one tap, no task list in between.
    await page.goto(`https://deep-link.test/dashboard?task=${task.id}`);
    // The task's own transcript is on screen, not the list of tasks.
    await page.getByText('Deployed the fix.', { exact: true }).waitFor();
    assert.deepEqual(await showing(page), { conversation: true, list: false });

    // Back returns to the list, which is the phone entry point.
    await page.getByRole('button', { name: 'Back to tasks', exact: true }).click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.pw-sidebar.task-navigation')).display !== 'none',
    );
    assert.deepEqual(await showing(page), { conversation: false, list: true });

    // Without a deep link the list still opens first.
    await page.goto('https://deep-link.test/dashboard');
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('.pw-sidebar.task-navigation')).display !== 'none',
    );
    assert.deepEqual(await showing(page), { conversation: false, list: true });

    // Desktop widths are unaffected: the deep link opens the task alongside the list.
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    desktop.on('pageerror', (error) => errors.push(error.message));
    await desktop.route('**/api/workspace/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(fixture(path)),
      });
    });
    await desktop.route(/^https:\/\/deep-link\.test\/dashboard/, (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    await desktop.goto(`https://deep-link.test/dashboard?task=${task.id}`);
    await desktop.getByText('Deployed the fix.', { exact: true }).waitFor();
    assert.deepEqual(await showing(desktop), { conversation: true, list: true });
    assert.deepEqual(errors, []);
    await desktop.close();
    await page.close();
  } finally {
    await browser.close();
  }
});
