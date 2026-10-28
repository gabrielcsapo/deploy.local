import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { render, escape } from '../../../../desktop/src/views.mjs';

export const now = Date.parse('2026-10-27T18:32:00Z');
export const inbox = [
  {
    id: 'rollback',
    kind: 'rollback',
    title: 'Roll back home-gym?',
    text: 'home-gym sync fails 38% of jobs since 1:58 PM. Both apps go back to 81be0d2 and migration 0042 is undone.',
    from: 'Warden',
    createdAt: new Date(now).toISOString(),
    state: 'waiting',
    actions: [
      { id: 'rollback', label: 'Roll back home-gym', primary: true },
      { id: 'dismiss', label: 'Not now' },
    ],
  },
  {
    id: 'merge',
    kind: 'merge',
    title: 'Merge PR #18',
    text: '4 checks passed',
    from: 'Scout',
    createdAt: new Date(now - 240000).toISOString(),
    state: 'waiting',
    actions: [{ id: 'review', label: 'Review', primary: true }],
  },
  {
    id: 'retention',
    kind: 'question',
    title: 'Keep 3 or 5 releases?',
    text: 'self-release pipeline',
    from: 'Scout',
    createdAt: new Date(now - 720000).toISOString(),
    state: 'waiting',
    actions: [
      { id: 'three', label: '3 releases' },
      { id: 'five', label: '5 releases' },
    ],
  },
];
export const computers = [
  {
    id: 'coordinator',
    name: 'SER',
    workerIds: [],
    roles: ['coordinator', 'run-apps'],
    supportedRoles: ['coordinator', 'run-apps'],
    online: true,
    doing: [],
  },
  {
    id: 'worker:desktop-fixture',
    name: 'MacBook Pro',
    workerIds: ['desktop-fixture'],
    roles: ['take-tasks'],
    supportedRoles: ['take-tasks', 'use-screen'],
    online: true,
    doing: [{ id: 'self-release', kind: 'task', name: 'Self-release pipeline', state: 'running' }],
  },
  {
    id: 'bazzite',
    name: 'bazzite',
    workerIds: [],
    roles: ['run-apps'],
    supportedRoles: ['run-apps'],
    online: true,
    doing: [],
  },
];
export const live = {
  summary: { running: 7, failing: 1, warning: 1, checkedAt: new Date(now).toISOString() },
  computers: [
    {
      id: 'coordinator',
      name: 'SER',
      roles: ['coordinator', 'run-apps'],
      online: true,
      apps: [
        {
          appId: 'home-gym-sync',
          name: 'home-gym sync',
          kind: 'worker',
          state: 'failing',
          summary: '38% of jobs error since 1:58 PM',
        },
        {
          appId: 'immich',
          name: 'Immich',
          kind: 'web',
          state: 'warning',
          summary: 'Memory 92% of 4 GB',
        },
        ...['home-gym', 'Immich machine learning'].map((name) => ({
          appId: name,
          name,
          kind: 'web',
          state: 'healthy',
          summary: 'Healthy',
        })),
      ],
    },
    {
      id: 'bazzite',
      name: 'bazzite',
      roles: ['run-apps'],
      online: true,
      apps: ['Vaultwarden', 'Miniflux', 'Miniflux fetcher'].map((name) => ({
        appId: name,
        name,
        kind: 'web',
        state: 'healthy',
        summary: 'Healthy',
      })),
    },
  ],
};
export const common = {
  origin: 'http://127.0.0.1:5184',
  coordinatorName: 'SER',
  name: 'MacBook Pro',
  hardware: 'Apple M4 Pro · 48 GB · macOS 27',
  platform: 'darwin',
  screenSupported: true,
  roles: { takeTasks: true },
  worker: { state: 'Ready for tasks' },
  workerId: 'desktop-fixture',
  now,
  online: true,
  inbox,
  live,
  summary: live.summary,
  computers,
  lastSeen: now,
};
export const boards = {
  Setup: { page: 'setup' },
  SetupLinux: {
    page: 'setup',
    platform: 'linux',
    name: 'bazzite',
    hardware: 'AMD Ryzen 7 7840HS · 32 GB · Bazzite 42',
    screenSupported: false,
  },
  Permissions: { page: 'permissions' },
  Tray: { page: 'tray' },
  Offline: { page: 'offline', online: false, worker: { state: 'Disconnected' } },
};
export const notification = {
  title: 'Roll back home-gym?',
  subtitle: 'deploy.local · Warden',
  body: 'home-gym sync fails 38% of jobs since 1:58 PM. Both apps go back to 81be0d2 and migration 0042 is undone.',
  actions: [
    { type: 'button', text: 'Review' },
    { type: 'button', text: 'Not now' },
  ],
};
const assets = new URL('../../../../desktop/assets/', import.meta.url);
export async function styles() {
  let css = await readFile(new URL('shell.css', assets), 'utf8');
  for (const weight of [400, 600])
    css = css.replace(
      `url(hanken-${weight}.woff2)`,
      `url(data:font/woff2;base64,${(await readFile(new URL(`hanken-${weight}.woff2`, assets))).toString('base64')})`,
    );
  return `${await readFile(new URL('design-tokens.css', assets), 'utf8')}\n${css}`;
}
export function notificationContent(value) {
  return `<div class="notification"><span class="mark">d</span><div class="copy"><small>${escape(value.subtitle)}</small><div>${escape(value.title)}</div><p>${escape(value.body)}</p><footer>${value.actions.map((action, i) => `<button class="${i ? '' : 'primary'}">${escape(action.text)}</button>`).join('')}</footer></div></div>`;
}
export const notificationCss =
  '.notification{display:flex;gap:12px;padding:12px 14px;background:var(--paper);border-radius:16px}.notification .mark{width:32px;height:32px;font-size:15px}.notification .copy{flex:1;min-width:0}.notification p{margin:2px 0 0;line-height:18px}.notification footer{margin-top:8px;flex-wrap:nowrap}.notification button{flex:1}';
export async function preview(board) {
  if (!(board in boards) && board !== 'Notification') throw new Error('Unknown board');
  const width =
    board === 'Tray' ? 340 : board === 'Notification' ? 368 : board === 'Offline' ? 880 : 720;
  return `<!doctype html><html data-ds-theme="light"><meta charset="utf-8"><title>${board}</title><style>${await styles()}${notificationCss}
body{background:#d2d6df;min-height:900px}.stage{padding:64px 16px;min-height:900px}.frame{width:${width}px;max-width:100%;margin:auto;background:var(--paper);border-radius:12px;box-shadow:0 24px 64px -16px #14121a59;overflow:hidden}.titlebar{height:40px;padding:14px 18px;display:flex;gap:8px}.titlebar i{height:12px;width:12px;border-radius:50%;background:#ff5f57}.titlebar i:nth-child(2){background:#febc2e}.titlebar i:nth-child(3){background:#28c840}.evidence-label{position:fixed;bottom:10px;left:16px;color:#444;font-size:12px}</style><body><div class="stage"><div class="frame">${['Tray', 'Notification'].includes(board) ? '' : '<div class="titlebar"><i></i><i></i><i></i></div>'}${board === 'Notification' ? notificationContent(notification) : render({ ...common, ...boards[board] })}</div></div><small class="evidence-label">Renderer fixture · ${board} · native captures are separate</small></body></html>`;
}
export async function startFixture({ previews = false } = {}) {
  const state = { offline: false, requests: [], computers: structuredClone(computers) };
  const api = http.createServer(async (req, res) => {
    const url = new URL(req.url, common.origin);
    state.requests.push({ method: req.method, path: url.pathname });
    const send = (value, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (state.offline) return send({ error: 'Fixture coordinator offline' }, 503);
    if (url.pathname === '/api/login' && req.method === 'POST')
      return send({ token: 'fixture-session-only' });
    if (req.headers['x-deploy-token'] !== 'fixture-session-only')
      return send({ error: 'Sign in' }, 401);
    if (url.pathname === '/api/v2/inbox') return send({ items: inbox });
    if (url.pathname === '/api/v2/live') return send(live);
    if (url.pathname === '/api/v2/events') {
      const timer = setTimeout(
        () => send({ events: [], cursor: Number(url.searchParams.get('after') || 0) }),
        1000,
      );
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname === '/api/v2/computers') return send({ computers: state.computers });
    if (url.pathname === '/api/v2/computers/worker%3Adesktop-fixture' && req.method === 'PATCH') {
      let data = '';
      for await (const chunk of req) data += chunk;
      state.computers[1].roles = JSON.parse(data).roles;
      return send({ computer: state.computers[1] });
    }
    // No enrollment, task dispatch, shell execution or external proxy exists in this fixture.
    return send({ error: 'Fixture route unavailable' }, 404);
  });
  const listen = (server, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  await listen(api, 5184);
  let pages;
  try {
    if (previews) {
      pages = http.createServer(async (req, res) => {
        try {
          res.setHeader('Content-Type', 'text/html');
          res.end(await preview(new URL(req.url, 'http://127.0.0.1:5185').pathname.slice(1)));
        } catch {
          res.writeHead(404);
          res.end('Unknown board');
        }
      });
      await listen(pages, 5185);
    }
  } catch (error) {
    api.close();
    throw error;
  }
  return {
    state,
    close: async () => {
      for (const server of [api, pages].filter(Boolean)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await startFixture({ previews: true });
  console.log(
    'Fixture coordinator: http://127.0.0.1:5184; renderer previews: http://127.0.0.1:5185/Tray',
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, async () => {
      await fixture.close();
      process.exit();
    });
}
