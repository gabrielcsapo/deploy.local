// Fixture for TaskDeploy parity captures: the real v2 API over a temporary data folder, with a
// task whose agent read, edited, ran tests, failed one deploy, shipped the next and checked it.
// Run: VITE_PORT=5193 pnpm dev:ui, then npx tsx docs/evidence/task-deploy-steps/fixture-server.ts
// and open http://127.0.0.1:5192/dashboard/tasks/tally-reset
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'task-deploy-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { save, event, events, list } = await import('../../../server/workspace/store.ts');
const { mapConversationEvent } = await import('../../../server/features/agents/conversation-events.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { workspaceApi } = await import('../../../server/workspace/api.ts');

const owner = 'Gabriel';
const start = Date.parse('2026-11-16T17:00:00Z');
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
save('project', owner, { id: 'tally', name: 'Tally', repositoryStatus: 'ready' });
// Real workers report their platform and what they can run; the iPhone app requires both.
const machine = { platform: 'linux', architecture: 'x64', capabilities: ['claude', 'docker'] };
save('worker', owner, { id: 'w-ser', name: 'SER', status: 'online', ...machine });
save('worker', owner, { id: 'w-bazzite', name: 'bazzite', status: 'online', ...machine });
save('task', owner, {
  id: 'tally-reset',
  projectId: 'tally',
  title: 'Add a reset button to Tally and ship it',
  status: 'review',
  workerId: 'w-ser',
  // Real tasks carry a revision from creation; the iPhone app's Task decoder requires it.
  revision: 2,
  workspacePath: '/w/tally-reset',
  baseRevision: 'c0ffee0',
  createdAt: at(0),
  updatedAt: at(14),
});
save('run', owner, {
  id: 'run',
  taskId: 'tally-reset',
  adapter: 'claude',
  model: 'opus',
  status: 'succeeded',
  workerId: 'w-ser',
  createdAt: at(0),
  updatedAt: at(14),
});
const jobs = [
  { id: 'tests', name: 'Run tests', workerId: 'w-ser', from: 2, seconds: 12 },
  {
    id: 'open',
    name: 'Open tally.local and press reset',
    workerId: 'w-bazzite',
    from: 13,
    seconds: 3,
  },
];
for (const job of jobs)
  save('job', owner, {
    id: job.id,
    taskId: 'tally-reset',
    runId: 'run',
    name: job.name,
    command: 'node --test',
    workerId: job.workerId,
    status: 'succeeded',
    // Fields a real job record carries; the iPhone app's job decoder requires them.
    digest: `sha256:${job.id}`,
    output: '',
    truncated: false,
    exitCode: 0,
    createdAt: at(job.from),
    updatedAt: new Date(Date.parse(at(job.from)) + job.seconds * 1000).toISOString(),
  });

const add = (type: string, payload: object) => event(owner, 'tally-reset', 'run', type, payload);
const tool = (
  id: string,
  minute: number,
  name: string,
  args: object,
  output: unknown,
  seconds = 1,
) => {
  add('item.started', {
    createdAt: at(minute),
    item: { type: 'tool_call', id, name, arguments: args },
  });
  add('item.completed', {
    createdAt: at(minute + seconds / 60),
    item: { type: 'tool_result', id, name, arguments: args, output, startedAt: at(minute) },
  });
};
const text = (value: object) => [{ type: 'text', text: JSON.stringify(value) }];

add('message', {
  id: 'ask',
  role: 'user',
  createdAt: at(0),
  content:
    'In Tally, add a reset button under the count, then deploy it and check tally.local works from another computer',
});
tool('read', 0.5, 'Read', { file_path: '/w/web/server.mjs' }, 'ok');
tool('edit', 1, 'Edit', { file_path: '/w/web/index.html' }, 'ok');
add('job.queued', { id: 'tests', name: 'Run tests', createdAt: at(2) });
add('job.succeeded', { jobId: 'tests', workerId: 'w-ser', exitCode: 0, createdAt: at(2.2) });
tool(
  'deploy-1',
  3,
  'mcp__deploy__deploy_application',
  { operationId: 'deploy-1', checkpointId: 'c1', name: 'tally' },
  text({
    status: 'failed',
    url: 'https://tally.local',
    deploymentId: '1352',
    logTail:
      'Deployment stopped. Check configuration and build logs before retrying.\n[2026-11-16T17:03:01Z] web  Error: EACCES: permission denied, open \'/app/server.mjs\'\n[2026-11-16T17:03:01Z] web  exited with code 1\n[2026-11-16T17:03:02Z] Deployment failed: Component "web" instance "verify/web/1" failed its health gate\n',
  }),
  38,
);
tool(
  'deploy-2',
  12,
  'mcp__deploy__deploy_application',
  { operationId: 'deploy-2', checkpointId: 'c2', name: 'tally' },
  text({ status: 'running', url: 'https://tally.local', deploymentId: '1353' }),
  41,
);
add('job.queued', { id: 'open', name: 'Open tally.local and press reset', createdAt: at(13) });
add('job.succeeded', { jobId: 'open', workerId: 'w-bazzite', exitCode: 0, createdAt: at(13.1) });
add('message', {
  id: 'done',
  role: 'assistant',
  createdAt: at(14),
  content:
    'The reset button is live at [tally.local](https://tally.local). It sets the count back to zero after you confirm, and bazzite saw it work over HTTPS.\n\nThe first deploy failed because the app files were only readable by root, and the app runs as the `node` user. The Dockerfile now makes them readable.',
});

const user = () => ({ username: owner });
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1:5192');
  const path = url.pathname;
  if (process.env.FIXTURE_LOG) res.on('finish', () => console.log(res.statusCode, req.method, req.url));
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  if (path.startsWith('/api/')) {
    // A feed from cursor 0, mapped the way the server maps it: the iPhone app builds a task's
    // conversation from this feed, and the web page reads its snapshot then follows it.
    if (path === '/api/activity-events') {
      if (url.searchParams.get('after') === 'latest')
        return send({ events: [], cursor: 0, supportsWait: true });
      const after = Number(url.searchParams.get('after'));
      const rows = Number.isFinite(after) ? events(owner, after) : [];
      if (!rows.length) {
        const timer = setTimeout(() => send({ events: [], cursor: after || 0, supportsWait: true }), 10000);
        res.on('close', () => clearTimeout(timer));
        return;
      }
      const jobsById = new Map(list('job', owner).map((job: any) => [job.id, job]));
      const names = new Map(list('worker', owner).map((worker: any) => [worker.id, worker.name]));
      const runs = new Map(list('run', owner).map((run: any) => [run.id, run]));
      const context = {
        calls: new Map(),
        job: (id: string) => jobsById.get(id),
        computer: (id: string) => names.get(id),
      };
      const feed = rows.flatMap((row: any) => {
        const mapped = mapConversationEvent(row, runs.get(row.runId), context);
        return mapped
          ? [{ type: 'conversation', cursor: row.cursor, taskId: row.taskId, runId: row.runId, at: row.createdAt, event: mapped }]
          : [];
      });
      return send({ events: feed, cursor: rows.at(-1).cursor, supportsWait: true });
    }
    if (path === '/api/activity-events' || path.endsWith('/stream')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/api/user') return send({ username: owner, role: 'admin' });
    if (path === '/api/auth/account')
      return send({ username: owner, welcomed: true, firstTaskSeen: true, passkeyOffered: true });
    if (path === '/api/nodes')
      return send({ nodes: [{ id: 'coordinator', name: 'SER', online: true }] });
    if (path === '/api/state' && !process.env.FIXTURE_REAL_STATE)
      return send({
        version: 1,
        cursor: 0,
        projects: [{ id: 'tally', name: 'Tally', apps: [] }],
        workers: [
          { id: 'w-ser', name: 'SER', status: 'online' },
          { id: 'w-bazzite', name: 'bazzite', status: 'online' },
        ],
        tasks: [
          {
            id: 'tally-reset',
            projectId: 'tally',
            title: 'Add a reset button to Tally and ship it',
            status: 'review',
            createdAt: at(0),
            updatedAt: at(14),
          },
        ],
        runs: [],
        adapters: [],
      });
    if (path === '/api/agents') return send({ agents: [] });
    if (path === '/api/packages') return send({ packages: [] });
    if (path === '/api/live')
      return send({
        summary: { running: 0, failing: 0, warning: 0, checkedAt: new Date().toISOString() },
        computers: [],
      });
    // The iPhone app reads a task's runs and messages from the workspace API.
    if (path.startsWith('/api/tasks/') || (path === '/api/state' && process.env.FIXTURE_REAL_STATE))
      return void (await workspaceApi(req, res, owner));
    const before = res.writableEnded;
    await v2Api(req, res, user as never);
    if ((res.writableEnded || res.headersSent) && !before) return;
    if (!res.headersSent) send({ error: `Fixture route unavailable: ${req.method} ${path}` }, 404);
    return;
  }
  const proxy = httpRequest(
    { hostname: '127.0.0.1', port: 5193, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    },
  );
  proxy.on('error', () => send({ error: 'Start Vite on 5193' }, 503));
  req.pipe(proxy);
});
server.listen(5192, '127.0.0.1', () =>
  console.log(`TaskDeploy fixture on http://127.0.0.1:5192 (data ${root})`),
);
