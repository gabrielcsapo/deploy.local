// Capture-only server. No coordinator, health collector, repository worker or mutation APIs.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LiveApp, LiveResponse, Release } from '../../../shared/v2/contracts.ts';

if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
  throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
const port = Number(process.env.PORT ?? 5180);
if (!Number.isInteger(port) || port < 5180 || port > 5189)
  throw new Error('Use only ports 5180–5189');
export const root = mkdtempSync(join(tmpdir(), 'projects-join-fixture-'));
// Set before importing either store. Never inherit the coordinator's data directory.
process.env.DEPLOY_DATA_DIR = root;
const store = await import('../../../server/store.ts');
const workspace = await import('../../../server/workspace/store.ts');
const { projectsForOwner, resolveProject, unlinkedProjectApps } =
  await import('../../../server/v2/projects.ts');
const { compileApplicationManifest } = await import('../../../server/application-spec.ts');
const owner = 'gabriel';
const database = store.getSqlite()!;
export const states = {
  Projects: { route: '/dashboard/projects', height: 1040 },
  Live: { route: '/dashboard/live', height: 1160 },
  LiveDark: { route: '/dashboard/live', height: 1160 },
  AppNoRepository: { route: '/dashboard/projects/app%3Apantry', height: 900 },
  AddRepository: { route: '/dashboard/projects/app%3Apantry', height: 900 },
  NewProjectExistingApp: { route: '/dashboard/projects', height: 900 },
  ProjectEmpty: { route: '/dashboard/projects/recipes', height: 900 },
  AddExistingApp: { route: '/dashboard/projects/recipes', height: 900 },
} as const;
export type State = keyof typeof states;
const isState = (state: string): state is State => Object.hasOwn(states, state);
const nodes = [
  { id: 'coordinator', name: 'SER', online: true, roles: ['coordinator', 'run-apps'] },
  { id: 'imac', name: 'imac', online: true, roles: ['take-tasks', 'run-apps'] },
];
let currentState: State = 'Projects';
let epoch = Date.now();
const ago = (minutes: number) => new Date(epoch - minutes * 60_000).toISOString();
const put = (kind: string, row: any) => workspace.save(kind, owner, row);
const rows = (kind: string) => workspace.list(kind, owner);

export function reset(state: State) {
  currentState = state;
  epoch = Date.now();
  workspace.db.exec('DELETE FROM records; DELETE FROM events; DELETE FROM operations;');
  database.exec(
    'DELETE FROM catalog_installations; DELETE FROM project_applications; DELETE FROM application_spec_revisions; DELETE FROM deployments;',
  );
  store._invalidateDeploymentsCache();
  const listState = ['Projects', 'Live', 'LiveDark'].includes(state);
  const repository = (name: string, empty = false, stage = 'active') => {
    // Skip manifest inspection: this is a snapshot, not a Git checkout. Overview below
    // supplies the ready/empty repository response. No Git commands are run, even on reset.
    put('project', { id: name, name, stage, repositoryStatus: 'fixture' });
    put('fixture-repository', {
      id: name,
      status: 'ready',
      defaultBranch: 'main',
      empty,
      head: empty ? null : '9c3e1fa',
      clonePath: `/${name}.git`,
      source: { kind: 'hosted', location: null, syncPolicy: 'none' },
      sync: null,
      operation: null,
    });
  };
  const app = (name: string, project: string, computer: string, extra: Partial<LiveApp> = {}) => {
    const kind = extra.kind ?? 'web';
    const value: LiveApp = {
      appId: name,
      name,
      project,
      kind,
      state: 'healthy',
      summary: 'GET /healthz 200',
      address: `https://${name}.deploy.local`,
      http: { path: '/healthz', status: 200, reqPerMin: 1, p95ms: 25 },
      release: '9c3e1fa',
      releasedAt: ago(34),
      ...extra,
    };
    if (kind === 'worker') {
      delete value.address;
      delete value.http;
    }
    database
      .prepare(`INSERT INTO deployments(name,username,type,status,active_node_id,port,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`)
      .run(
        name,
        owner,
        kind,
        value.state === 'stopped' ? 'stopped' : 'running',
        computer,
        kind === 'web' ? 3000 : null,
        ago(7200),
        ago(0),
      );
    if (kind === 'worker') {
      const { spec } = compileApplicationManifest({
        apiVersion: 'deploy.local/v1',
        kind: 'Application',
        metadata: { name },
        components: { worker: { image: 'fixture/worker:local', role: 'worker' } },
      });
      const digest = `fixture:${name}`;
      database
        .prepare(`INSERT INTO application_spec_revisions(digest,deployment_name,api_version,source,manifest_format,normalized_spec,created_by,created_at)
        VALUES(?,?,?,?,?,?,?,?)`)
        .run(digest, name, spec.apiVersion, 'fixture', 'yaml', JSON.stringify(spec), owner, ago(0));
      database
        .prepare('UPDATE deployments SET active_spec_digest=? WHERE name=?')
        .run(digest, name);
    }
    database
      .prepare('INSERT INTO project_applications(application,owner,project_id) VALUES(?,?,?)')
      .run(name, owner, project);
    if (value.fromDiscover)
      database
        .prepare(`INSERT INTO catalog_installations(id,application_name,blueprint_id,release,blueprint_digest,installed_spec_digest,current_spec_digest,site_id,mode,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(
          name,
          name,
          name,
          value.release,
          'fixture',
          'fixture',
          'fixture',
          computer,
          'local',
          'installed',
          ago(0),
          ago(0),
        );
    put('fixture-live', { id: name, computer, app: value });
  };
  if (listState || state === 'NewProjectExistingApp') {
    repository('home-gym');
    app('home-gym', 'home-gym', 'coordinator', {
      http: { path: '/healthz', status: 200, reqPerMin: 12, p95ms: 38 },
    });
    app('home-gym-sync', 'home-gym', 'coordinator', {
      name: 'home-gym sync',
      kind: 'worker',
      state: listState ? 'failing' : 'healthy',
      summary: listState ? '38% of jobs error since 1:58 PM' : 'Heartbeat 2 s ago',
      jobs: { perMin: 9, failRate: listState ? 0.38 : 0, baselineFailRate: 0.01 },
      queue: { depth: listState ? 1240 : 0, oldestSec: listState ? 840 : 0 },
    });
  }
  if (listState) {
    repository('forma');
    repository('tally');
    repository('deploy.local');
    app('forma', 'forma', 'coordinator', {
      release: 'a1b2c3d',
      releasedAt: ago(720),
      summary: 'GET /health 200',
      http: { path: '/health', status: 200, reqPerMin: 41, p95ms: 64 },
    });
    app('forma-jobs', 'forma', 'imac', {
      name: 'forma jobs',
      kind: 'worker',
      release: 'a1b2c3d',
      releasedAt: ago(720),
      summary: 'Heartbeat 2 s ago',
      jobs: { perMin: 6, failRate: 0, baselineFailRate: 0 },
      queue: { depth: 0, oldestSec: 0 },
    });
    app('tally', 'tally', 'coordinator', {
      state: 'stopped',
      summary: 'stopped by you 3 days ago · would run on SER',
      releasedAt: ago(4320),
    });
    app('groffee', 'app:groffee', 'imac', {
      release: 'e7d41f0',
      releasedAt: '2026-10-12T12:00:00Z',
      summary: 'GET / 200',
      http: { path: '/', status: 200, reqPerMin: 2, p95ms: 120 },
    });
    repository('recipes', true);
    // Discover apps have standalone projects; catalog membership makes them Maintained.
    for (const [name, display, host, computer, release, days, path, rate, p95] of [
      ['immich', 'Immich', 'photos', 'coordinator', 'v1.122.3', 4, '/', 3, 210],
      ['Vaultwarden', 'Vaultwarden', 'vault', 'imac', '1.32.0', 9, '/alive', 1, 25],
      ['Miniflux', 'Miniflux', 'miniflux', 'coordinator', '2.2.1', 12, '/healthcheck', 1, 31],
    ] as const) {
      app(name, `app:${name}`, computer, {
        name: display,
        fromDiscover: true,
        address: `https://${host}.deploy.local`,
        release,
        releasedAt: ago(days * 1440),
        state: name === 'immich' ? 'warning' : 'healthy',
        summary: name === 'immich' ? '92% of 4 GB for 20 min' : `GET ${path} 200`,
        http: { path, status: 200, reqPerMin: rate, p95ms: p95 },
      });
    }
    repository('kettle-timer', false, 'done');
    put('fixture-inbox', {
      id: 'rollback-home-gym',
      kind: 'rollback',
      projectId: 'home-gym',
      title: 'Roll back home-gym to 81be0d2?',
      text: 'home-gym sync fails 38% of jobs with column "started" does not exist since the 1:58 PM release. The web app and the worker ship as one release, so both go back and migration 0042 is undone.',
      from: 'ops-watcher',
      createdAt: ago(0),
      state: 'waiting',
      actions: [
        { id: 'rollback', label: 'Roll back home-gym', primary: true },
        { id: 'later', label: 'Not now' },
      ],
    });
  } else {
    if (state !== 'NewProjectExistingApp') repository('recipes', true);
    app('pantry', 'app:pantry', 'coordinator', {
      release: 'c09ab12',
      releasedAt: ago(4320),
      http: { path: '/healthz', status: 200, reqPerMin: 6, p95ms: 28 },
    });
    for (const [id, minutes, message] of [
      ['c09ab12', 4320, 'Show expiry dates'],
      ['a08bc11', 7200, 'Created from a folder'],
    ] as const) {
      const release: Release = {
        id,
        projectId: 'app:pantry',
        source: { kind: 'cli', ref: '~/code/pantry', message },
        startedBy: 'you',
        apps: [{ appId: 'pantry', to: id }],
        migrations: [],
        state: id === 'c09ab12' ? 'live' : 'superseded',
        steps: (['prepare', 'verify', 'activate', 'watch'] as const).map((name) => ({
          name,
          state: 'done',
          startedAt: ago(minutes),
          endedAt: ago(minutes),
        })),
      };
      put('fixture-release', { id, release });
    }
    // The chooser board has a same-name *standalone* app as well as the empty repository.
    if (state === 'AddExistingApp') app('recipes', 'app:recipes', 'coordinator');
  }
  for (const [id, name, minutes] of [
    ['release-notes-writer', 'Release notes writer', 0],
    ['ops-watcher', 'Ops watcher', 60],
    ['code-reviewer', 'Code reviewer', 1440],
    ['researcher', 'Researcher', 2880],
    ['designer', 'Designer', 4320],
  ] as const)
    put('agent', { id, name, job: '', computers: [], lastMessage: { text: '', at: ago(minutes) } });
}

async function live(): Promise<LiveResponse> {
  const apps = rows('fixture-live');
  return {
    summary: {
      running: apps.filter(({ app }) => app.state !== 'stopped').length,
      failing: apps.filter(({ app }) => app.state === 'failing').length,
      warning: apps.filter(({ app }) => app.state === 'warning').length,
      checkedAt: ago(1 / 3),
    },
    computers: nodes.map((node) => ({
      ...node,
      roles: node.roles as LiveResponse['computers'][number]['roles'],
      cpu: node.id === 'coordinator' ? 14 : 22,
      memory: node.id === 'coordinator' ? 38 : 51,
      ...(node.id === 'coordinator' ? { disk: 61 } : {}),
      apps: apps.filter((row) => row.computer === node.id).map((row) => row.app),
    })),
  };
}
const send = (res: ServerResponse, value: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
};
export async function handleJson(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url!, 'http://127.0.0.1');
  const path = decodeURIComponent(url.pathname);
  if (path !== '/__fixture' && !path.startsWith('/api/')) return false;
  if (req.method !== 'GET') {
    send(res, { error: 'Capture fixture: mutations are disabled' }, 405);
    return true;
  }
  try {
    if (path === '/__fixture') {
      const state = url.searchParams.get('state') ?? 'Projects';
      if (!isState(state)) {
        send(res, { error: 'Unknown state', states: Object.keys(states) }, 400);
        return true;
      }
      reset(state);
      res.writeHead(302, {
        location: `${states[state].route}?fixtureState=${state}`,
        'cache-control': 'no-store',
      });
      res.end();
      return true;
    }
    if (path === '/api/projects') send(res, { projects: await projectsForOwner(owner) });
    else if (path === '/api/projects/unlinked-apps')
      send(res, { apps: await unlinkedProjectApps(owner) });
    else if (path === '/api/live') send(res, await live());
    else if (path.startsWith('/api/live/')) {
      const app = rows('fixture-live').find(
        (row) => row.id === path.slice('/api/live/'.length),
      )?.app;
      send(res, app ? { app, history: [] } : { error: 'App not found' }, app ? 200 : 404);
    } else if (path === '/api/user' || path === '/api/auth/account')
      send(res, {
        username: owner,
        role: 'admin',
        welcomed: true,
        firstTaskSeen: true,
        passkeyOffered: true,
      });
    else if (path === '/api/nodes') send(res, { nodes });
    else if (path === '/api/state')
      send(res, {
        version: 1,
        cursor: 0,
        projects: await projectsForOwner(owner),
        tasks: [],
        runs: [],
        workers: [],
        adapters: [],
      });
    else if (path === '/api/agents') send(res, { agents: rows('agent') });
    else if (path === '/api/inbox')
      send(res, {
        items: url.searchParams.get('state') === 'answered' ? [] : rows('fixture-inbox'),
        cursor: 0,
      });
    else if (path === '/api/packages')
      send(res, { packages: [], served: false, usingCopies: false });
    else if (path === '/api/model-settings') send(res, { choices: [], defaults: {} });
    else if (path === '/api/activity-events') {
      if (url.searchParams.get('after') === 'latest')
        send(res, { events: [], cursor: 0, supportsWait: true });
      else {
        const timer = setTimeout(
          () => send(res, { events: [], cursor: 0, supportsWait: true }),
          10000,
        );
        res.on('close', () => clearTimeout(timer));
      }
    } else if (/^\/api\/projects\/[^/]+\/pulls$/.test(path)) send(res, { items: [] });
    else {
      const match = path.match(/^\/api\/projects\/([^/]+)\/(overview|releases)$/);
      if (!match) send(res, { error: `Unimplemented capture route: ${path}` }, 404);
      else {
        const project = await resolveProject(owner, match[1]);
        if (match[2] === 'releases')
          send(res, {
            releases: rows('fixture-release')
              .map((row) => row.release)
              .filter((release) => release.projectId === project.id),
          });
        else
          send(res, {
            project,
            repository: rows('fixture-repository').find((row) => row.id === project.id) ?? null,
            repositoryError: false,
            tasks: [],
            issues: [],
            pulls: [],
            apps: project.apps.map((app) => ({
              ...app,
              computer: nodes.find(
                (node) =>
                  node.id === rows('fixture-live').find((row) => row.id === app.id)?.computer,
              )?.name,
              memoryLimit: '1 GB',
            })),
          });
      }
    }
  } catch (error: any) {
    send(res, { error: error.message }, error.status ?? 500);
  }
  return true;
}
export function closeFixture() {
  store._resetDb();
  workspace.db.close();
  rmSync(root, { recursive: true, force: true });
}
reset('Projects');

const entry = '/__projects-fixture.tsx';
const fontCss = [400, 500, 600, 700]
  .map(
    (weight) =>
      `@font-face{font-family:'Hanken Grotesk';font-weight:${weight};src:url('/app/routes/v2-public/about/hanken-${weight}.ttf') format('truetype');font-display:block}`,
  )
  .join('');
async function createFixtureVite(check = false) {
  const { createServer: createVite } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const vite = await createVite({
    configFile: false,
    cacheDir: join(root, 'vite'),
    ...(check ? { optimizeDeps: { noDiscovery: true, include: [] } } : {}),
    plugins: [
      {
        name: 'projects-capture-entry',
        enforce: 'pre',
        // The real layout links Google Fonts. Serve the same family locally for offline capture.
        transform(code, id) {
          if (id === resolve('app/routes/dashboard/v2-layout.client.tsx'))
            return {
              code: code.replace(
                'https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap',
                '/__fixture-fonts.css',
              ),
              map: null,
            };
        },
        resolveId(id) {
          if (id === entry) return entry;
        },
        load(id) {
          if (id !== entry) return;
          return `import React from 'react';
import { createRoot } from 'react-dom/client';
import { V2Layout } from '/app/routes/dashboard/v2-layout.client';
import Projects from '/app/routes/dashboard/v2/projects/page.client';
import Live from '/app/routes/dashboard/v2/live/page.client';
import { setContent } from '/docs/evidence/board-parity/fixture-router';
import '/app/design-tokens.css';
localStorage.setItem('deploy-sh-auth', JSON.stringify({ username: 'gabriel', token: 'fixture' }));
setContent(location.pathname.startsWith('/dashboard/live') ? <Live /> : <Projects />);
createRoot(document.getElementById('root')).render(<V2Layout />);`;
        },
      },
      react(),
    ],
    resolve: {
      alias: {
        '@': resolve('app'),
        'react-flight-router/client': resolve('docs/evidence/board-parity/fixture-router.tsx'),
      },
    },
    server: { middlewareMode: true, hmr: false, ws: false, preTransformRequests: false },
    appType: 'custom',
  });
  return vite;
}
async function start() {
  const vite = await createFixtureVite();
  const server = createServer(async (req, res) => {
    try {
      if (await handleJson(req, res)) return;
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);
      if (url.pathname === '/__fixture-fonts.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(fontCss);
        return;
      }
      if (url.pathname.startsWith('/dashboard')) {
        const state = url.searchParams.get('fixtureState') ?? currentState;
        const theme = state === 'LiveDark' ? 'dark' : 'light';
        // All assets, including Hanken, are local. CSP prevents outside fetches in manual captures.
        res.writeHead(200, {
          'content-type': 'text/html',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'",
        });
        res.end(
          await vite.transformIndexHtml(
            url.pathname,
            `<!doctype html><html data-ds-theme="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Projects capture fixture</title><style>${fontCss}body{margin:0;font-family:'Hanken Grotesk',sans-serif;font-size:13px;color:var(--ink)}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
          ),
        );
        return;
      }
      vite.middlewares(req, res, () => {
        res.writeHead(404);
        res.end();
      });
    } catch (error) {
      if (!res.headersSent) send(res, { error: String(error) }, 500);
      else res.end();
    }
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    server.closeAllConnections();
    server.close();
    await vite.close();
    closeFixture();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stop());
  server.once('error', (error) => {
    console.error(error);
    process.exitCode = 1;
    void stop();
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Fixture: http://127.0.0.1:${port}/__fixture?state=Projects\nTemporary data: ${root}`,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) {
    const assert: typeof import('node:assert/strict') = (await import('node:assert/strict'))
      .default;
    const { routeFetch } = await import('../../../server/v2/test-request.ts');
    const fetch = routeFetch(handleJson);
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, path);
      return response.json();
    };
    try {
      for (const state of Object.keys(states) as State[]) {
        const response = await fetch(`http://127.0.0.1:${port}/__fixture?state=${state}`);
        assert.equal(response.status, 302);
        assert.equal(
          response.headers.get('location'),
          `${states[state].route}?fixtureState=${state}`,
        );
        const { projects } = await get('/api/projects');
        const health = await get('/api/live');
        const available = await get('/api/projects/unlinked-apps');
        if (['Projects', 'Live', 'LiveDark'].includes(state)) {
          assert.equal(projects.length, 10);
          assert.equal(projects.find((p: any) => p.id === 'home-gym').apps.length, 2);
          assert.equal(projects.find((p: any) => p.id === 'forma').apps.length, 2);
          assert.equal(projects.find((p: any) => p.id === 'kettle-timer').stage, 'done');
          assert.equal(projects.filter((p: any) => p.fromDiscover).length, 3);
          assert.deepEqual(
            available.apps.map((a: any) => a.name),
            ['groffee'],
          );
          assert.equal(health.summary.running, 8);
          assert.equal(health.summary.failing, 1);
          assert.equal(health.summary.warning, 1);
          assert.equal(projects.find((p: any) => p.id === 'deploy.local').apps.length, 0);
          assert.equal(projects.find((p: any) => p.id === 'recipes').apps.length, 0);
          const computers = health.computers;
          assert.deepEqual(
            computers.map((c: any) => c.name),
            ['SER', 'imac'],
          );
          assert.equal(
            computers[0].apps.find((a: any) => a.appId === 'home-gym-sync').kind,
            'worker',
          );
          assert.equal(
            computers[0].apps.find((a: any) => a.appId === 'home-gym-sync').address,
            undefined,
          );
          assert.equal(
            computers[1].apps.find((a: any) => a.appId === 'forma-jobs').project,
            'forma',
          );
          assert.equal(computers[0].apps.find((a: any) => a.appId === 'tally').state, 'stopped');
        } else {
          const pantry = await get('/api/projects/app%3Apantry/overview');
          assert.equal(pantry.repository, null);
          assert.equal(pantry.project.apps[0].name, 'pantry');
          assert.equal((await get('/api/live/pantry')).app.state, 'healthy');
          assert.equal((await get('/api/projects/app%3Apantry/releases')).releases.length, 2);
          if (state !== 'NewProjectExistingApp') {
            const recipes = await get('/api/projects/recipes/overview');
            assert.equal(recipes.repository.empty, true);
            assert.equal(recipes.project.apps.length, 0);
          }
          assert.deepEqual(
            available.apps.map((a: any) => a.name).sort(),
            state === 'AddExistingApp' ? ['pantry', 'recipes'] : ['pantry'],
          );
        }
        for (const path of [
          '/api/user',
          '/api/nodes',
          '/api/state',
          '/api/agents',
          '/api/inbox?state=waiting',
          '/api/auth/account',
          '/api/packages?sidebar=1',
          '/api/activity-events?after=latest',
          '/api/model-settings',
        ])
          await get(path);
        console.log(`OK ${state}`);
      }
      assert.equal((await fetch('http://127.0.0.1/__fixture?state=bad')).status, 400);
      assert.equal(
        (await fetch('http://127.0.0.1/api/projects', { method: 'POST', body: '{}' })).status,
        405,
      );
      assert.equal((await fetch('http://127.0.0.1/api/missing')).status, 404);
      assert.equal(rows('repository-operation').length, 0);
      reset('Projects');
      assert.equal((await get('/api/projects/unlinked-apps')).apps[0].name, 'groffee');
      console.log('JSON checks passed; no listener or browser started.');
      const vite = await createFixtureVite(true);
      try {
        for (const path of [
          entry,
          '/app/routes/dashboard/v2-layout.client.tsx',
          '/app/routes/dashboard/v2/projects/page.client.tsx',
          '/app/routes/dashboard/v2/live/page.client.tsx',
          '/app/routes/dashboard/v2/projects/repository-connect.client.tsx',
          '/app/routes/dashboard/v2/projects/new-project.client.tsx',
        ]) {
          const transformed = (await vite.transformRequest(path))?.code;
          assert.ok(transformed, path);
          if (path.includes('v2-layout')) {
            assert.ok(transformed.includes('/__fixture-fonts.css'));
            assert.ok(!transformed.includes('fonts.googleapis.com'));
          }
        }
        console.log('Vite entry and real page modules transformed without a browser.');
      } finally {
        await vite.close();
      }
    } finally {
      closeFixture();
    }
  } else await start();
}
