// Fixture for the task panes parity captures (TaskBrowser, TaskBrowserYours, TaskChangesPane,
// TaskChecksPane): the real v2 and workspace APIs over a temporary data folder, with a running
// task whose agent is using the task browser on bazzite.
// Run: VITE_PORT=5187 DEPLOY_MDNS_ADDRESS=127.0.0.1 pnpm dev:ui, then
// npx tsx docs/evidence/task-panes/fixture-server.ts and open
// http://127.0.0.1:5186/dashboard/tasks/tally-reset/browser
// Add ?yours to the fixture's start (FIXTURE_YOURS=1) to hand the browser to this window's client.
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = mkdtempSync(join(tmpdir(), 'task-panes-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { save, event, events, list } = await import('../../../server/workspace/store.ts');
const { mapConversationEvent } =
  await import('../../../server/features/agents/conversation-events.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { workspaceApi } = await import('../../../server/workspace/api.ts');

const owner = 'Gabriel';
const start = Date.now() - 6 * 60_000;
const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
save('project', owner, { id: 'tally', name: 'Tally', repositoryStatus: 'ready' });
const machine = { platform: 'linux', architecture: 'x64', capabilities: ['claude', 'docker'] };
save('worker', owner, { id: 'w-ser', name: 'SER', status: 'online', ...machine });
save('worker', owner, {
  id: 'w-bazzite',
  name: 'bazzite',
  status: 'online',
  instanceId: 'bazzite-1',
  ...machine,
});
save('task', owner, {
  id: 'tally-reset',
  projectId: 'tally',
  title: 'Add a reset button to Tally',
  status: 'running',
  workerId: 'w-bazzite',
  revision: 2,
  branch: 'task/tally-reset',
  workspacePath: '/w/tally-reset',
  baseRevision: 'c0ffee0',
  createdAt: at(0),
  updatedAt: at(5),
});
save('run', owner, {
  id: 'run',
  taskId: 'tally-reset',
  adapter: 'claude',
  model: 'opus',
  status: 'running',
  workerId: 'w-bazzite',
  createdAt: at(0),
  updatedAt: at(5),
});
save('job', owner, {
  id: 'tests',
  taskId: 'tally-reset',
  runId: 'run',
  name: 'Unit tests',
  command: 'node --test web',
  workerId: 'w-ser',
  status: 'succeeded',
  digest: 'sha256:tests',
  output: '',
  truncated: false,
  exitCode: 0,
  createdAt: at(3),
  updatedAt: at(3.05),
});

const add = (type: string, payload: object) => event(owner, 'tally-reset', 'run', type, payload);
const tool = (id: string, minute: number, name: string, args: object, output: unknown) => {
  add('item.started', {
    createdAt: at(minute),
    item: { type: 'tool_call', id, name, arguments: args },
  });
  add('item.completed', {
    createdAt: at(minute + 0.02),
    item: { type: 'tool_result', id, name, arguments: args, output, startedAt: at(minute) },
  });
};
add('message', {
  id: 'ask',
  role: 'user',
  createdAt: at(0),
  content:
    'In Tally, add a reset button under the count, then deploy it and check tally.local works from another computer',
});
tool('read', 0.5, 'Read', { file_path: '/w/web/server.mjs' }, 'ok');
tool(
  'edit',
  1,
  'Edit',
  {
    file_path: '/w/web/store.mjs',
    old_string: '  }\n',
    new_string: '  }\n  reset() {\n    this.count = 0;\n    this.save();\n  }\n',
  },
  'ok',
);
tool('typecheck', 2, 'Bash', { command: 'npx tsc --noEmit -p web' }, 'ok');
add('checkpoint.created', {
  checkpointId: 'c1',
  digest: '39bd298647bb1d1ec42a42ece7d4c7f9',
  createdAt: at(2.5),
});
add('job.queued', { id: 'tests', name: 'Unit tests', createdAt: at(3) });
add('job.succeeded', { jobId: 'tests', workerId: 'w-ser', exitCode: 0, createdAt: at(3.05) });

// The task browser: bazzite's worker offers it, the agent was granted it and clicked Reset.
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.setContent(`<body style="margin:0;font-family:-apple-system,system-ui,sans-serif;color:#1d1d1f">
<div style="height:56px;display:flex;align-items:center;padding:0 24px;font-weight:600;border-bottom:1px solid #eee">Tally</div>
<div style="height:744px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
<div style="font-size:120px;font-weight:600;line-height:1">0</div><div style="color:#86868b">Count since Monday</div>
<div style="display:flex;gap:8px"><button style="height:40px;padding:0 20px;border:0;border-radius:8px;background:#f2f2f4">−</button><button style="height:40px;padding:0 20px;border:0;border-radius:8px;background:#1d1d1f;color:#fff">+</button><button style="height:40px;padding:0 20px;border:0;border-radius:8px;background:#f2f2f4">Reset</button></div></div></body>`);
const image = (await page.screenshot({ type: 'jpeg', quality: 70 })).toString('base64');
await browser.close();
save('interactive-worker', owner, {
  id: 'w-bazzite',
  instanceId: 'bazzite-1',
  heartbeat: new Date(Date.now() + 365 * 86400_000).toISOString(),
  targets: [{ id: 'managed-browser', kind: 'browser', label: 'Task browser', available: true }],
});
const yours = process.env.FIXTURE_CLIENT;
save('interactive-session', owner, {
  id: 'browser-1',
  taskId: 'tally-reset',
  runId: 'run',
  workerId: 'w-bazzite',
  instanceId: 'bazzite-1',
  targetId: 'managed-browser',
  targetLabel: 'Task browser',
  kind: 'browser',
  record: false,
  status: 'active',
  controlOwner: yours ? `user:${yours}` : 'agent',
  generation: 'g1',
  createdAt: new Date(Date.now() - 72_000).toISOString(),
  updatedAt: at(5),
  heartbeat: new Date(Date.now() + 365 * 86400_000).toISOString(),
  expiresAt: Date.now() + 365 * 86400_000,
});
save('interactive-command', owner, {
  id: 'cmd-1',
  taskId: 'tally-reset',
  sessionId: 'browser-1',
  generation: 'g1',
  runId: 'run',
  controller: 'agent',
  args: { type: 'click', selector: 'text=Reset' },
  status: 'succeeded',
  createdAt: at(5),
  completedAt: at(5),
});
save('interactive-snapshot', owner, {
  id: 'browser-1',
  url: 'https://tally.local/',
  title: 'Tally',
  text: '',
  image,
  mimeType: 'image/jpeg',
  width: 1280,
  height: 800,
  log: [],
  capturedAt: at(5),
  commandId: 'cmd-1',
});
add('message', {
  id: 'note',
  role: 'assistant',
  createdAt: at(4),
  content: 'Opened tally.local in the browser on bazzite to check the reset button.',
});

const patch = `diff --git a/web/store.mjs b/web/store.mjs
--- a/web/store.mjs
+++ b/web/store.mjs
@@ -18,6 +18,10 @@ export class Store
   increment() {
     this.count += 1;
   }
+  reset() {
+    this.count = 0;
+    this.save();
+  }
 }
diff --git a/web/server.mjs b/web/server.mjs
--- a/web/server.mjs
+++ b/web/server.mjs
@@ -40,2 +40,8 @@
   if (url.pathname === '/increment') return json(res, store.increment());
+  if (url.pathname === '/reset' && req.method === 'POST') {
+    store.reset();
+    return json(res, { count: 0 });
+  }
+
+  // Reset asks first in the page; the server only does it.
   return notFound(res);
diff --git a/web/index.html b/web/index.html
--- a/web/index.html
+++ b/web/index.html
@@ -12,3 +12,11 @@
     <button id="minus">−</button>
-    <button id="plus">+</button>
+    <button id="plus">+</button>
+    <button id="reset">Reset</button>
+    <script>
+      reset.onclick = async () => {
+        if (!confirm('Set the count back to zero?')) return;
+        await fetch('/reset', { method: 'POST' });
+        location.reload();
+      };
+    </script>
   </div>
`;

// A stand-in for bazzite's worker: it acknowledges control changes and answers each step with a
// picture, so Take over, the address, Back, Forward and clicks run through the real API.
const { interactiveWorker } = await import('../../../server/features/tasks/interactive.ts');
const history = ['https://tally.local/'];
let place = 0;
const workerBody = { instanceId: 'bazzite-1' };
const browserTargets = [
  { id: 'managed-browser', kind: 'browser', label: 'Task browser', available: true },
];
setInterval(() => {
  try {
    const live = list('interactive-session', owner).filter((s: any) =>
      ['opening', 'transferring', 'active'].includes(s.status),
    );
    const polled = interactiveWorker(owner, 'w-bazzite', 'poll', {
      ...workerBody,
      targets: browserTargets,
      ready: live.map((s: any) => ({ id: s.id, generation: s.generation })),
    });
    for (const entry of polled.commands) {
      const identity = {
        ...workerBody,
        sessionId: entry.sessionId,
        commandId: entry.id,
        generation: entry.generation,
      };
      const claim = interactiveWorker(owner, 'w-bazzite', 'claim', identity);
      if (claim.status !== 'running') continue;
      const action = entry.args;
      if (action.type === 'navigate') {
        history.splice(place + 1);
        history.push(action.url);
        place = history.length - 1;
      } else if (action.type === 'back') place = Math.max(0, place - 1);
      else if (action.type === 'forward') place = Math.min(history.length - 1, place + 1);
      if (process.env.FIXTURE_LOG) console.log('step', JSON.stringify(action));
      interactiveWorker(owner, 'w-bazzite', 'complete', {
        ...identity,
        snapshot: {
          url: history[place],
          title: 'Tally',
          text: '',
          image,
          mimeType: 'image/jpeg',
          width: 1280,
          height: 800,
          log: [],
        },
      });
    }
  } catch (error: any) {
    console.error('worker', error.message);
  }
}, 700);

const user = () => ({ username: owner });
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1:5186');
  const path = url.pathname;
  if (process.env.FIXTURE_LOG)
    res.on('finish', () => console.log(res.statusCode, req.method, req.url));
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
        const timer = setTimeout(
          () => send({ events: [], cursor: after || 0, supportsWait: true }),
          10000,
        );
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
          ? [
              {
                type: 'conversation',
                cursor: row.cursor,
                taskId: row.taskId,
                runId: row.runId,
                at: row.createdAt,
                event: mapped,
              },
            ]
          : [];
      });
      return send({ events: feed, cursor: rows.at(-1).cursor, supportsWait: true });
    }
    if (path === '/api/activity-events' || path.endsWith('/stream')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (path === '/api/tasks/tally-reset/diff')
      return send({ patch, baseCommit: 'c0ffee0', headCommit: 'beefcafe', status: '' });
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
            title: 'Add a reset button to Tally',
            status: 'running',
            createdAt: at(0),
            updatedAt: at(5),
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
    { hostname: '127.0.0.1', port: 5187, path: req.url, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    },
  );
  proxy.on('error', () => send({ error: 'Start Vite on 5187' }, 503));
  req.pipe(proxy);
});
server.listen(5186, '127.0.0.1', () =>
  console.log(`Task panes fixture on http://127.0.0.1:5186 (data ${root})`),
);
