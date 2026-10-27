import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Isolated fixtures served to the browser; no coordinator, account or task data is touched.
const workerRoot =
  '/Users/someone/Library/Application Support/deploy.local/worker/tasks/first-load-task';
const task = {
  id: 'first-load-task',
  title: 'Slow first load',
  projectId: 'project-1',
  status: 'review',
  workerId: 'mac-worker',
  revision: 0,
  workspacePath: '/var/lib/deploy/workspace/tasks/first-load-task',
  remoteWorkspacePath: workerRoot,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
};
const state = {
  cursor: 1,
  projects: [{ id: 'project-1', name: 'Pilot repository' }],
  tasks: [task],
  workers: [
    {
      id: 'mac-worker',
      name: 'MacBook Pro',
      status: 'online',
      capabilities: ['codex'],
      modelOptions: [{ id: 'codex', models: [], efforts: [] }],
    },
  ],
  adapters: [{ id: 'codex', name: 'Codex', available: true, capabilities: {} }],
};
const detail = {
  task,
  runs: [{ id: 'run-1', taskId: task.id, status: 'succeeded', adapter: 'codex' }],
  messages: [
    {
      id: 'm1',
      taskId: task.id,
      runId: 'run-1',
      role: 'assistant',
      content: `Published from ${workerRoot}/server/workspace/checkpoint-publish.ts today.`,
      createdAt: task.createdAt,
    },
  ],
  jobs: [],
  activity: [
    {
      id: 'run-1',
      status: 'succeeded',
      summary: 'Read 1 file',
      items: [
        {
          id: 'run-1:i1',
          kind: 'read',
          title: 'Read checkpoint-publish.ts',
          status: 'completed',
          detail: `${workerRoot}/server/workspace/checkpoint-publish.ts`,
          source: `${workerRoot}/server/workspace/checkpoint-publish.ts`,
        },
      ],
    },
  ],
  attachments: [],
  pullRequests: [],
  questions: [],
  events: [],
};
const diff = {
  baseRevision: 'a'.repeat(40),
  headRevision: 'b'.repeat(40),
  patch: [
    'diff --git a/server/workspace/checkpoint-publish.ts b/server/workspace/checkpoint-publish.ts',
    'index 1111111..2222222 100644',
    '--- a/server/workspace/checkpoint-publish.ts',
    '+++ b/server/workspace/checkpoint-publish.ts',
    '@@ -1,1 +1,1 @@',
    '-const published = false;',
    '+const published = true;',
    '',
  ].join('\n'),
  status: ' M server/workspace/checkpoint-publish.ts',
  files: [{ status: 'M ', path: 'server/workspace/checkpoint-publish.ts' }],
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

/** How long a cold `/state` is made to take; the task must not wait for it. */
const stateDelay = 3000;

async function bundleWorkspace() {
  const bundle = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@': resolve('app') } },
    plugins: [
      react(),
      {
        name: 'task-first-load-test',
        enforce: 'pre',
        resolveId(id) {
          if (id === 'task-first-load-test') return resolve('task-first-load-test.tsx');
          if (id === 'react-flight-router/client') return resolve('test-router.tsx');
          const action = id.match(actionModule);
          if (action) return resolve(`test-action-${action[1]}.tsx`);
        },
        load(id) {
          if (id === resolve('task-first-load-test.tsx')) return entry;
          if (id === resolve('test-router.tsx')) return router;
          const stub = id.match(/test-action-([\w-]+)\.tsx$/);
          if (stub) return stubActions(stub[1]);
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: { input: 'task-first-load-test', output: { inlineDynamicImports: true } },
    },
  });
  const script = bundle.output.find((item) => item.type === 'chunk').code;
  const css = bundle.output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) => item.source)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script type="module">${script.replaceAll('</script', '<\\/script')}</script></body></html>`;
}

test('a task renders from its own detail while the computer inventory is still loading', async (t) => {
  const html = await bundleWorkspace();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // A coordinator that has just restarted answers the task quickly and the inventory slowly.
  await page.route('**/api/workspace/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
    if (path.startsWith('/state')) await new Promise((done) => setTimeout(done, stateDelay));
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture(path)),
    });
  });
  await page.route(/^https:\/\/first-load\.test\/dashboard/, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );

  const started = Date.now();
  await page.goto(`https://first-load.test/dashboard?task=${task.id}`, {
    waitUntil: 'commit',
  });
  await page.getByText('Published from', { exact: false }).waitFor();
  const painted = Date.now() - started;
  t.diagnostic(`task painted ${painted}ms into a ${stateDelay}ms inventory read`);
  assert.ok(
    painted < stateDelay,
    `the task painted after ${painted}ms, which did not beat the ${stateDelay}ms inventory`,
  );

  // Nothing about the computer or the repository is known yet, so nothing is asserted about them.
  const waiting = await page.locator('body').innerText();
  assert.doesNotMatch(waiting, /Loading task…/);
  assert.doesNotMatch(waiting, /Task computer offline/);
  assert.doesNotMatch(waiting, /Computer unavailable/);
  assert.doesNotMatch(waiting, /No project/);
  assert.match(waiting, /Reconnecting to the task computer…/);

  // Once the inventory lands the computer and repository are named, and no notice remains.
  await page.locator('.pw-composer-context-tray').getByText('MacBook Pro').waitFor();
  const loaded = await page.locator('body').innerText();
  assert.match(loaded, /Pilot repository/);
  assert.doesNotMatch(loaded, /Task computer offline/);
  assert.doesNotMatch(loaded, /Reconnecting to the task computer…/);
  assert.deepEqual(errors, []);
});

test('an offline computer is still reported as offline once the inventory has arrived', async (t) => {
  const html = await bundleWorkspace();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/workspace/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
    const body = path.startsWith('/state')
      ? { ...state, workers: [{ ...state.workers[0], status: 'offline', reconnecting: false }] }
      : fixture(path);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route(/^https:\/\/first-load\.test\/dashboard/, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(`https://first-load.test/dashboard?task=${task.id}`);
  await page.getByText('Task computer offline', { exact: false }).waitFor();
  assert.deepEqual(errors, []);
});

test('task views name files by their repository path, never the task computer’s own', async (t) => {
  const html = await bundleWorkspace();
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/workspace/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/workspace', '');
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(fixture(path)),
    });
  });
  await page.route(/^https:\/\/first-load\.test\/dashboard/, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto(`https://first-load.test/dashboard?task=${task.id}`);
  await page.getByRole('button', { name: 'Changes', exact: true }).first().click();

  // Every changed-file row names the repository path, in its text and in its tooltip.
  const row = page.locator('.pw-files > div').first();
  await row.waitFor();
  assert.equal(await row.getAttribute('title'), 'server/workspace/checkpoint-publish.ts');
  assert.match(await row.innerText(), /^server\/workspace\/checkpoint-publish\.ts/);

  // No tooltip, link or visible text anywhere in the task hands out a worker-local path.
  const leaks = await page.evaluate(
    (root) =>
      [...document.querySelectorAll('[title]')]
        .map((element) => element.getAttribute('title'))
        .filter((value) => value.includes(root)),
    workerRoot,
  );
  assert.deepEqual(leaks, []);
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /Library\/Application Support\/deploy\.local\/worker/);
  assert.match(text, /server\/workspace\/checkpoint-publish\.ts/);
  assert.deepEqual(errors, []);
});
