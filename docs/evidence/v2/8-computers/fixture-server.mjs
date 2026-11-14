// UI fixtures only: no coordinator, worker, Docker or enrolled computer is contacted.
import { createServer, request } from 'node:http';
import { restartingHtml } from '../../../../server/edge/restarting.ts';
const gb = 1024 ** 3;
const computers = [
  {
    id: 'coordinator',
    name: 'SER',
    nodeId: 'coordinator',
    workerIds: [],
    roles: ['coordinator', 'run-apps', 'serve-models'],
    supportedRoles: ['coordinator', 'run-apps', 'serve-models'],
    online: true,
    platform: 'Linux',
    version: '2a91c0e',
    cpu: 14,
    cpuModel: 'Ryzen AI 9 HX 470 · Radeon 890M',
    memory: { used: 17 * gb, total: 45 * gb },
    disk: { used: 580 * gb, total: 950 * gb },
    doing: [
      { id: 'deploy.local', name: 'deploy.local', kind: 'app', state: 'Healthy' },
      { id: 'home-gym', name: 'home-gym', kind: 'app', state: '1 of 2 failing' },
      { id: 'recipes', name: 'recipes', kind: 'app', state: 'Stopped' },
      { id: 'lemonade', name: 'Lemonade', kind: 'model', state: 'Serving' },
    ],
  },
  {
    id: 'macbook',
    name: 'MacBook Pro',
    workerIds: ['macbook'],
    roles: ['take-tasks', 'use-screen'],
    supportedRoles: ['take-tasks', 'use-screen'],
    online: true,
    version: '2a91c0e',
    doing: [{ id: 'self', name: 'Self-release pipeline', kind: 'task', state: 'running' }],
  },
  {
    id: 'bazzite',
    name: 'bazzite',
    nodeId: 'bazzite',
    workerIds: ['bazzite'],
    roles: ['take-tasks', 'run-apps'],
    supportedRoles: ['take-tasks', 'run-apps'],
    online: true,
    cpuModel: 'AMD Ryzen 7 7840HS',
    memory: { total: 32 * gb },
    version: '2a91c0e',
    doing: [
      { id: 'Vaultwarden', name: 'Vaultwarden', kind: 'app', state: 'Healthy' },
      { id: 'Miniflux', name: 'Miniflux', kind: 'app', state: 'Healthy' },
      { id: 'sync', name: 'Fix the sync migration', kind: 'task', state: 'running' },
    ],
  },
];
const models = {
  choices: [
    { id: 'claude:opus', name: 'Opus', provider: 'claude', model: 'opus' },
    { id: 'codex:gpt-6.1-sol', name: 'GPT-6.1-Sol', provider: 'codex', model: 'gpt-6.1-sol' },
    { id: 'compatible:qwen', name: 'Qwen3-8B', provider: 'compatible', model: 'qwen' },
  ],
  defaults: {
    'writing-code': 'claude:opus',
    reviewing: 'codex:gpt-6.1-sol',
    'answering-questions': 'compatible:qwen',
  },
  providers: [
    { id: 'claude', name: 'Claude', computers: ['MacBook Pro'], weekly: { usedPercent: 42 } },
    { id: 'codex', name: 'Codex', computers: ['bazzite'], weekly: { usedPercent: 18 } },
  ],
  local: ['Qwen3-8B', 'Whisper Large v3 Turbo', 'Kokoro', 'Flux'].map((name, i) => ({
    id: String(i),
    name,
    computer: 'SER',
    loaded: i !== 3,
  })),
};
const updates = {
  automatic: false,
  currentVersion: '7f3b2d4',
  projectId: 'deploy-project',
  latestRelease: {
    id: '7f3b2d4',
    projectId: 'deploy-project',
    state: 'live',
    apps: [{ appId: 'deploy.local', to: '7f3b2d4' }],
    migrations: [],
    steps: [],
  },
  computers: [
    { id: 'coordinator', version: '7f3b2d4', state: 'current' },
    { id: 'macbook', version: '7f3b2d4', state: 'current' },
    { id: 'bazzite', version: '2a91c0e', state: 'waiting' },
  ],
};
const setup = `
const board = new URL(location.href).searchParams.get('board');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<60;i++) {
 if(board==='RemoveComputer'){ const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Remove computer'); if(b){b.click();break;} }
 else if(board==='AddComputer'){ const input=document.querySelector('dialog input'); if(input){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'bazzite');input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(100);[...document.querySelectorAll('button')].find(b=>b.textContent==='Create join code')?.click();break;} }
 else break;
 await sleep(50);
}`;
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:5190');
  const board = new URL(req.headers.referer || url.href).searchParams.get('board');
  const path = url.pathname;
  const send = (body, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (path === '/restarting') {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    return res.end(restartingHtml('SER', '7f3b2d4'));
  }
  if (path === '/fixture-setup.js') {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(setup);
  }
  if (path.startsWith('/api/')) {
    let body = {};
    if (req.method !== 'GET') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try {
        body = JSON.parse(Buffer.concat(chunks).toString());
      } catch {}
    }
    if (path === '/api/computers')
      return send({
        computers:
          board === 'SelfUpdate'
            ? computers.map((c, i) => ({
                ...c,
                version: i < 2 ? '7f3b2d4' : c.version,
                doing: i === 1 ? [] : c.doing,
              }))
            : computers,
      });
    if (path === '/api/model-settings') {
      if (req.method === 'PUT') models.defaults = body.defaults;
      return send(models);
    }
    if (path === '/api/updates') return send(updates);
    if (path === '/api/computers/enrollment')
      return send({ code: '7KQ2-M9XD', name: body.name, expiresAt: Date.now() + 600000 });
    if (path.endsWith('/removal'))
      return send({
        computerId: 'bazzite',
        allowed: false,
        reasons: [
          'Move these apps and their data through their project releases before removing this computer.',
          'Wait for the active tasks and jobs to finish. They will not be interrupted.',
        ],
        apps: ['Vaultwarden', 'Miniflux'].map((id) => ({
          id,
          name: id,
          destinations: [{ id: 'coordinator', name: 'SER' }],
        })),
        tasks: [{ id: 'sync', name: 'Fix the sync migration' }],
      });
    if (path.startsWith('/api/computers/')) {
      const computer = computers.find((c) => c.id === decodeURIComponent(path.split('/')[4]));
      if (computer) {
        if (req.method === 'PATCH') computer.roles = body.roles;
        return send({ computer });
      }
    }
    if (path === '/api/agents')
      return send({
        agents: [
          { id: 'scout', name: 'Scout' },
          { id: 'warden', name: 'Warden' },
        ],
      });
    if (path === '/api/inbox')
      return send({
        items:
          url.searchParams.get('state') === 'answered'
            ? []
            : ['Roll back home-gym?', 'Merge PR #18', 'Keep 3 or 5 releases?'].map((title, i) => ({
                id: String(i),
                title,
                text: title,
                kind: 'question',
                from: 'scout',
                state: 'waiting',
                createdAt: new Date().toISOString(),
                actions: [],
              })),
      });
    if (path === '/api/activity-events')
      return setTimeout(() => send({ events: [], cursor: 0, supportsWait: true }), 10000);
    if (path === '/api/live') return send({ summary: { running: 7, failing: 1 }, computers: [] });
    if (path === '/api/user') return send({ user: { username: 'Gabriel' } });
    if (path === '/api/nodes') return send({ nodes: computers });
    if (path === '/api/state')
      return send({
        tasks: [
          { id: 'self', title: 'Self-release pipeline', updatedAt: new Date().toISOString() },
          { id: 'sync', title: 'Fix the sync migration', updatedAt: new Date().toISOString() },
        ],
        runs: [],
        projects: [],
      });
    return send({ error: 'No fixture for this route' }, 404);
  }
  const proxy = request(
    { hostname: '127.0.0.1', port: 5191, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      if (response.headers['content-type']?.includes('text/html')) {
        const chunks = [];
        response.on('data', (c) => chunks.push(c));
        response.on('end', () => {
          res.writeHead(response.statusCode, { 'Content-Type': 'text/html' });
          res.end(
            Buffer.concat(chunks)
              .toString()
              .replace('</body>', '<script type="module" src="/fixture-setup.js"></script></body>'),
          );
        });
      } else {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    },
  );
  proxy.on('error', () => send({ error: 'Start fixture Vite on 5191' }, 503));
  req.pipe(proxy);
}).listen(5190, '127.0.0.1', () => console.log('Computers fixture on 5190; Vite assets on 5191'));
