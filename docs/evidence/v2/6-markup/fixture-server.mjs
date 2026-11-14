// Isolated API fixtures. No coordinator, worker, database or Docker imports.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  boards,
  checks,
  decisions,
  fixture as taskFixture,
  patch,
  pulls,
  taskDetails,
} from '../3-task/fixtures.mjs';
const marks = {
  strokes: [
    {
      tool: 'pen',
      color: 0,
      points: Array.from({ length: 81 }, (_, i) => [
        190 + 184 * Math.cos((i * Math.PI) / 40),
        252 + 34 * Math.sin((i * Math.PI) / 40),
      ]),
    },
    {
      tool: 'pen',
      color: 0,
      points: [
        [60, 452],
        [130, 449],
        [240, 450],
        [330, 454],
      ],
    },
    {
      tool: 'arrow',
      color: 0,
      points: [
        [250, 520],
        [210, 470],
      ],
    },
  ],
  texts: [
    { x: 168, y: 314, text: 'pick-up night!', color: 0 },
    { x: 70, y: 570, text: 'show the count first', color: 0 },
  ],
};
function fixture(board) {
  const value = taskFixture(board);
  if (board === 'NewProduct') value.screenshots[0].markup = marks;
  return value;
}
let released;
let cursor = 1;
const answered = new Map();
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const send = (value, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (path === '/api/model-settings')
    return send({
      choices: [
        { id: 'claude:opus', name: 'Opus', provider: 'claude', model: 'opus' },
        { id: 'codex:sol', name: 'GPT-6.1-Sol', provider: 'codex', model: 'sol' },
      ],
      defaults: {
        'writing-code': 'claude:opus',
        reviewing: 'codex:sol',
        'answering-questions': 'claude:opus',
      },
      local: [],
      providers: [],
    });
  if (path === '/api/auth/welcome') return send({ seen: true });
  if (path === '/api/auth/account')
    return send({
      username: 'Gabriel',
      passkeys: [],
      preferences: { welcomeSeen: true, firstTaskSeen: true },
    });
  if (path.startsWith('/api/screenshots/'))
    return send({
      screenshot: fixture('NewProduct').screenshots.find(
        (shot) => shot.id === path.split('/').at(-1),
      ),
    });
  if (path.startsWith('/api/fixture/screenshot/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    const index = Number(path.match(/(\d+)\.svg$/)?.[1]);
    return res.end(
      readFileSync(new URL(`../3-task/assets/meal-planner-${index}.svg`, import.meta.url)),
    );
  }
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/nodes')
    return send({ nodes: [{ online: true }, { online: true }, { online: true }] });
  if (path === '/api/agents')
    return send({
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    });
  if (path === '/api/live') return send({ summary: { running: 7, failing: 1 } });
  if (path === '/api/state')
    return send({
      projects: [],
      tasks: boards
        .filter((b) => !['TaskChanges', 'TaskChecks', 'PullRequests', 'ShipDialog'].includes(b))
        .map((b) => fixture(b).task),
      runs: [],
    });
  if (path === '/api/inbox')
    return send({
      items: decisions
        .map((item) => answered.get(item.id) || item)
        .filter((item) => item.state === (url.searchParams.get('state') || 'waiting')),
    });
  const answer = path.match(/^\/api\/inbox\/([^/]+)\/answer$/);
  if (answer && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const old = decisions.find((item) => item.id === answer[1]);
    const item = {
      ...old,
      state: 'answered',
      answer: {
        actionId: body.actionId,
        by: 'Gabriel',
        on: 'web',
        at: new Date().toISOString(),
        note: body.note,
      },
    };
    answered.set(item.id, item);
    return send({ item });
  }
  if (path === '/api/activity-events') {
    const timer = setTimeout(() => {
      if (released)
        released = {
          ...released,
          state: 'live',
          steps: released.steps.map((step) => ({ ...step, state: 'done' })),
        };
      send({
        cursor: ++cursor,
        supportsWait: true,
        events: [...answered.values()]
          .map((item) => ({ type: 'inbox', item, cursor }))
          .concat(released ? [{ type: 'release', release: released, cursor }] : []),
      });
    }, 1000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  if (path.match(/^\/api\/projects\/[^/]+\/releases$/)) {
    if (req.method === 'POST') {
      if (process.env.TASK_SHIP_UNSUPPORTED === '1') return send({ error: 'Not found' }, 404);
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      released = {
        id: '9c3e1fa',
        projectId: path.split('/')[4],
        source: body.source,
        startedBy: 'Gabriel',
        apps: [],
        migrations: [],
        state: 'running',
        steps: ['prepare', 'verify', 'activate', 'watch'].map((name, i) => ({
          name,
          state: i ? 'waiting' : 'running',
        })),
      };
      return send({ release: released });
    }
    return send({ releases: released ? [released] : [] });
  }
  const task = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (task) return send(fixture(decodeURIComponent(task[1])));
  if (path.match(/^\/api\/tasks\/[^/]+\/diff$/))
    return send({
      ...taskDetails(decodeURIComponent(path.split('/')[4])),
      baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
    });
  if (path.match(/^\/api\/projects\/[^/]+\/pulls$/))
    return send({ items: pulls, nextBefore: null });
  if (path.endsWith('/diff'))
    return send({ patch, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) });
  if (path.includes('/pipelines/')) return send({ jobs: checks });
  if (path.match(/\/pulls\/[^/]+$/))
    return send({ record: pulls[0], checks: [{ id: 'current', commit: 'b'.repeat(40) }] });
  if (req.method === 'POST') return send({ id: 'fixture-operation' });
  send({}, 404);
});
server.listen(5193, '127.0.0.1', () => console.log('Task fixture on 5193'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
