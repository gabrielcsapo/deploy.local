// Isolated API fixtures. No coordinator, worker, database or Docker imports.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { boards, checks, decisions, fixture, patch, pulls, taskDetails } from './fixtures.mjs';
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
  if (path.startsWith('/api/fixture/screenshot/')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    const index = Number(path.match(/(\d+)\.svg$/)?.[1]);
    return res.end(readFileSync(new URL(`./assets/meal-planner-${index}.svg`, import.meta.url)));
  }
  if (path === '/api/user') return send({ username: 'Gabriel' });
  if (path === '/api/nodes')
    return send({ nodes: [{ online: true }, { online: true }, { online: true }] });
  if (path === '/api/v2/agents')
    return send({
      agents: [
        { id: 'scout', name: 'Scout' },
        { id: 'warden', name: 'Warden' },
      ],
    });
  if (path === '/api/v2/live') return send({ summary: { running: 7, failing: 1 } });
  if (path === '/api/workspace/state')
    return send({
      projects: [],
      tasks: boards
        .filter((b) => !['TaskChanges', 'TaskChecks', 'PullRequests', 'ShipDialog'].includes(b))
        .map((b) => fixture(b).task),
      runs: [],
    });
  if (path === '/api/v2/inbox')
    return send({
      items: decisions
        .map((item) => answered.get(item.id) || item)
        .filter((item) => item.state === (url.searchParams.get('state') || 'waiting')),
    });
  const answer = path.match(/^\/api\/v2\/inbox\/([^/]+)\/answer$/);
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
  if (path === '/api/v2/events') {
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
  if (path.match(/^\/api\/v2\/projects\/[^/]+\/releases$/)) {
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
  const task = path.match(/^\/api\/v2\/tasks\/([^/]+)$/);
  if (task) return send(fixture(decodeURIComponent(task[1])));
  if (path.match(/^\/api\/workspace\/tasks\/[^/]+\/diff$/))
    return send({
      ...taskDetails(decodeURIComponent(path.split('/')[4])),
      baseCommit: 'a'.repeat(40),
      headCommit: 'b'.repeat(40),
    });
  if (path.match(/^\/api\/workspace\/projects\/[^/]+\/pulls$/))
    return send({ items: pulls, nextBefore: null });
  if (path.endsWith('/diff'))
    return send({ patch, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40) });
  if (path.includes('/pipelines/')) return send({ jobs: checks });
  if (path.match(/\/pulls\/[^/]+$/))
    return send({ record: pulls[0], checks: [{ id: 'current', commit: 'b'.repeat(40) }] });
  if (req.method === 'POST') return send({ id: 'fixture-operation' });
  send({}, 404);
});
server.listen(5188, '127.0.0.1', () => console.log('Task fixture on 5188'));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections();
    server.close();
  });
