// Synthetic data only. No coordinator data, worker loop, credentials or origin connection.
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
if (process.env.DEPLOY_MDNS_ADDRESS !== '127.0.0.1')
  throw new Error('Set DEPLOY_MDNS_ADDRESS=127.0.0.1');
const port = Number(process.env.PORT ?? 5181);
// Any port in the range set aside for fixtures, so two sessions can capture at once.
if (!(port >= 5180 && port <= 5199)) throw new Error('Use a port from 5180 to 5199');
const root = mkdtempSync(join(tmpdir(), 'design-build-check-fixture-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, save, get, list, remove } = await import('../../../server/workspace/store.ts');
const { v2Api } = await import('../../../server/v2/api.ts');
const { designTool, renderBoard } = await import('../../../server/v2/design.ts');
const { taskSnapshot } = await import('../../../server/v2/tasks.ts');
const { queueScreenshots, screenshotWorker } = await import('../../../server/v2/screenshots.ts');
const { answerInbox } = await import('../../../server/v2/inbox.ts');
const owner = 'design-build-fixture';
const repo = join(root, 'repository');
const projectId = 'tally';
const taskId = 'tally-build';
const reviewId = 'design:tally:header';
mkdirSync(join(repo, 'design/boards'), { recursive: true });
cpSync(resolve('design/ds'), join(repo, 'design/ds'), { recursive: true });
const git = (...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
git('init', '-q', '--initial-branch=main');
git('config', 'user.name', 'Design build fixture');
git('config', 'user.email', 'fixture@example.invalid');
const html = (wrap = false) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="design-board" content="width=1440,height=192"><link rel="stylesheet" href="../ds/deploy-local/tokens.css"><link rel="stylesheet" href="../ds/deploy-local/components/bundle.css"><style>body{margin:0;padding:16px;background:var(--paper);font-family:Arial,sans-serif}.header{display:flex;justify-content:space-between;gap:16px;padding:16px;border:1px solid var(--line);border-radius:var(--radius-card)}${wrap ? '@media(max-width:700px){.header{flex-wrap:wrap}.history{flex-basis:100%}}' : ''}</style></head><body><div data-layer="header" class="header"><span data-layer="title">Tally</span><span data-layer="count">12</span><span data-layer="history" class="history">History</span></div></body></html>`;
writeFileSync(join(repo, 'design/boards/TallyHeader.html'), html());
writeFileSync(join(repo, 'design/boards/App.html'), html(true));
writeFileSync(
  join(repo, 'design/canvas.json'),
  JSON.stringify({
    title: 'Tally',
    boards: {
      'TallyHeader.html': { x: 0, y: 0, w: 1440, h: 192, title: 'Tally header' },
      // The stand-in for the running app: rendered like a board, so it must be on the canvas.
      'App.html': { x: 1520, y: 0, w: 1440, h: 192, title: 'The app' },
    },
    order: ['TallyHeader.html'],
    notes: {},
  }),
);
git('add', '.');
git('commit', '-qm', 'Approve the Tally header');
const main = git('rev-parse', 'HEAD');
git('checkout', '-qb', 'task/last-updated-24h');
writeFileSync(join(repo, 'app.txt'), 'Build the approved Tally header.');
git('add', '.');
git('commit', '-qm', 'Build the Tally header');
const head = git('rev-parse', 'HEAD');
save('project', owner, {
  id: projectId,
  name: 'Tally',
  repositoryPath: repo,
  repositoryStatus: 'ready',
  defaultBranch: 'main',
});
save('agent', owner, {
  id: 'designer',
  name: 'Designer',
  job: 'Design Tally',
  computers: [],
  avatar: { glyph: 'variant03', color: 'e66bb8' },
});
save('worker', owner, {
  id: 'local',
  name: 'SER',
  modelOptions: [{ id: 'claude', models: [{ id: 'opus', name: 'Opus' }] }],
});
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const latest = () =>
  taskSnapshot(owner, taskId)
    .checkpoints.at(-1)!
    .checks.map((check) => ({ ...check, commit: head }));
let decisionId: string | undefined;
async function seed(state: string, noCapture = false) {
  for (const kind of [
    'v2-inbox-native',
    'v2-inbox-answer',
    'design-review-built',
    'design-review-landing',
    'queued-message',
    'screenshot',
    'screenshot-request',
    'checkpoint',
    'job',
    'check',
  ]) {
    for (const row of list(kind, owner)) remove(kind, owner, row.id);
  }
  db.prepare('DELETE FROM events WHERE owner=?').run(owner);
  decisionId = undefined;
  save('task', owner, {
    id: taskId,
    title: 'Build: A calmer Tally header',
    projectId,
    agentId: 'designer',
    workerId: 'local',
    status: 'ready',
    revision: 1,
    baseRevision: main,
    sourceRef: 'main',
    publishedBranch: 'task/last-updated-24h',
    publishedCommit: head,
    publishedCheckpointId: 'cp6',
    createdAt: ago(40),
    updatedAt: ago(2),
    startedBy: 'you',
    startedFrom: 'New task',
  });
  // Keep answers queued locally; this fixture never runs an agent.
  save('run', owner, {
    id: 'builder',
    taskId,
    agentId: 'designer',
    workerId: 'local',
    adapter: 'claude',
    model: 'opus',
    status: 'running',
    updatedAt: ago(2),
  });
  for (let n = 1; n <= 6; n++) {
    save('checkpoint', owner, {
      id: `cp${n}`,
      taskId,
      createdAt: ago([40, 36, 28, 22, 14, 2][n - 1]),
      snapshot: { digest: `digest${n}` },
    });
    if (n < 3) continue;
    for (const [i, [name, command, output, duration]] of [
      ['Unit tests', 'node --test web', '12 passed', 3000],
      ['Starts', 'node web/server.mjs', 'Answered in 0.4 s', 2000],
      ['Format', 'prettier --check web', 'Passed', 1000],
    ].entries()) {
      if (n === 3 && i === 2) continue;
      save('job', owner, {
        id: `cp${n}-${i}`,
        taskId,
        checkpointId: `cp${n}`,
        digest: `digest${n}`,
        name,
        label: name,
        command,
        output: n === 4 && i === 0 ? 'Unit tests failed: midnight read 24:00:00' : output,
        status: n === 4 && i === 0 ? 'failed' : 'succeeded',
        durationMs: duration,
        createdAt: ago([40, 36, 28, 22, 14, 2][n - 1]),
        finishedAt: ago([40, 36, 28, 22, 14, 2][n - 1]),
      });
    }
  }
  save('pull-request', owner, {
    id: 'pull5',
    number: 5,
    projectId,
    taskIds: [taskId],
    title: 'A calmer Tally header',
    body: 'Build the approved header.',
    status: 'open',
    revision: 1,
    sourceBranch: 'task/last-updated-24h',
    targetBranch: 'main',
    createdAt: ago(34),
    updatedAt: ago(2),
  });
  const approved = new Date();
  approved.setHours(14, 14, 0, 0);
  save('v2-inbox-native', owner, {
    id: reviewId,
    item: {
      id: reviewId,
      kind: 'other',
      title: 'A calmer Tally header',
      text: 'Keep Tally, the count and History together.',
      from: 'designer',
      projectId,
      taskId,
      createdAt: ago(50),
      state: 'answered',
      actions: [{ id: 'approve', label: 'Approve design' }],
      answer: { actionId: 'approve', by: owner, on: 'web', at: approved.toISOString() },
    },
    context: {
      source: 'design',
      projectId,
      taskId,
      branch: 'design/tally-header',
      main: 'main',
      base: main,
      commit: main,
      paths: ['design/boards/TallyHeader.html'],
      checkBoards: [
        { file: 'TallyHeader.html', title: 'Tally header', widths: [1440, 700], height: 192 },
      ],
    },
  });
  save('design-review-landing', owner, {
    id: reviewId,
    state: 'landed',
    commit: main,
    at: approved.toISOString(),
    build: { taskId, at: approved.toISOString() },
  });
  if (state === 'TaskNeedsComputer') {
    // A build that said it needs Xcode: the coordinator and bazzite answered no, the Mac is offline.
    save('task', owner, {
      ...get('task', owner, taskId),
      status: 'queued',
      needs: { tools: ['xcodebuild'], why: 'the approved design changes 4 iPhone screens' },
      pendingPlacement: {},
    });
    const beat = new Date().toISOString();
    save('worker', owner, { id: 'bazzite', name: 'bazzite', heartbeat: beat, status: 'online' });
    save('worker', owner, {
      id: 'mbp',
      name: 'MacBook Pro',
      heartbeat: ago(90),
      status: 'offline',
    });
    for (const [workerId, has] of [
      ['local', false],
      ['bazzite', false],
      ['mbp', true],
    ] as const)
      save('tool-probe', owner, {
        id: `${workerId}:xcodebuild`,
        workerId,
        tool: 'xcodebuild',
        has,
        answeredAt: beat,
      });
    return;
  }
  if (state === 'TaskDesignCheck') return;
  const differs = state !== 'TaskDesignChecked';
  const comparisons: { board: string; width: number; screenshotId: string }[] = [];
  if (!noCapture && process.env.DEPLOY_TEST_NO_BROWSER !== '1') {
    const request = queueScreenshots(owner, taskId, {
      target: { kind: 'web', url: `http://127.0.0.1:${port}/__fixture/tally` },
      widths: [1440, 700],
    });
    const leased = screenshotWorker(owner, 'local', 'poll', {}).request;
    const images = [];
    for (const width of [1440, 700]) {
      // Render the fixture app, then ingest through the existing screenshot worker mechanism.
      const png = await renderBoard(
        repo,
        main,
        differs ? 'App.html' : 'TallyHeader.html',
        width,
        192,
      );
      images.push({ type: 'image/png', width, height: 192, data: png.toString('base64') });
    }
    const result = screenshotWorker(owner, 'local', 'complete', {
      id: request.id,
      lease: leased.lease,
      images,
    });
    for (const shot of result.screenshots ?? [])
      comparisons.push({ board: 'TallyHeader.html', width: shot.width, screenshotId: shot.id });
  }
  await designTool(
    { owner, taskId },
    differs
      ? {
          action: 'built',
          state: 'differs',
          differences: 1,
          text: 'History sits on its own line below the count at 700 px. The board keeps all three on one line.',
          why: 'The count grows to five digits on busy days, and at 700 px the three no longer fit on one line without shrinking the type.',
          board: 'TallyHeader.html',
          width: 700,
          screenshotId: comparisons.find((pair) => pair.width === 700)?.screenshotId,
          comparisons,
        }
      : { action: 'built', state: 'matches', captures: 2, comparisons },
  );
  const built = get('design-review-built', owner, reviewId);
  save('design-review-built', owner, { ...built, at: ago(2) });
  decisionId = built.decisionId;
  if (state === 'fixed' || state === 'kept')
    answerInbox(owner, decisionId!, {
      actionId: state === 'kept' ? 'keep-design' : 'fix-app',
      on: 'web',
    });
}
await seed('TaskDesignCheck');
const vite = await createVite({
  configFile: false,
  cacheDir: join(root, 'vite'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve('app'),
      'react-flight-router/client': resolve('docs/evidence/board-parity/fixture-router.tsx'),
    },
  },
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
});
const handler: import('node:http').RequestListener = async (req, res) => {
  const url = new URL(req.url!, `http://127.0.0.1:${port}`);
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  try {
    if (url.pathname === '/__fixture') {
      const state = url.searchParams.get('state') ?? 'TaskDesignCheck';
      if (
        ![
          'TaskDesignCheck',
          'TaskNeedsComputer',
          'TaskDesignChecked',
          'DesignBuiltDiffers',
          'fixed',
          'kept',
        ].includes(state)
      )
        return send({ error: 'Unknown state' }, 400);
      await seed(state, url.searchParams.has('noCapture'));
      res.writeHead(302, {
        location: state.startsWith('Task')
          ? `/dashboard/tasks/${taskId}/checks`
          : `/dashboard/inbox?item=${encodeURIComponent(decisionId!)}`,
      });
      res.end();
      return;
    }
    if (url.pathname === '/__fixture/tally') {
      res.setHeader('Content-Type', 'text/html');
      res.end(html(true));
      return;
    }
    if (url.pathname === '/api/state')
      return send({
        version: 1,
        cursor: 1,
        projects: list('project', owner),
        tasks: list('task', owner),
        workers: list('worker', owner),
        runs: list('run', owner),
        adapters: [],
      });
    if (url.pathname === '/api/user') return send({ username: 'Gabriel', role: 'admin' });
    if (url.pathname === '/api/nodes')
      return send({ nodes: [{ id: 'local', name: 'SER', online: true }] });
    if (url.pathname === '/api/auth/account')
      return send({ username: owner, welcomed: true, firstTaskSeen: true, passkeyOffered: true });
    if (url.pathname === '/api/projects/tally/pulls/pull5/diff')
      return send({
        patch: git('diff', main, head),
        baseCommit: main,
        headCommit: head,
        mergeable: true,
        conflicts: [],
      });
    if (url.pathname === '/api/projects/tally/pulls/pull5')
      return send({ record: get('pull-request', owner, 'pull5'), checks: latest() });
    if (req.method === 'POST' && url.pathname.startsWith('/api/'))
      return send({ error: 'This capture fixture does not merge or release.' }, 409);
    if (url.pathname === '/api/activity-events' && url.searchParams.get('after') === 'latest')
      return send({ events: [], cursor: 0, supportsWait: true });
    if (url.pathname === '/api/activity-events' || url.pathname.endsWith('/stream')) {
      const timer = setTimeout(() => send({ events: [], cursor: 1, supportsWait: true }), 15000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await v2Api(req, res, () => ({ username: owner }));
      if (res.writableEnded || res.headersSent) return;
    }
    if (url.pathname.startsWith('/api/')) return send({});
    if (url.pathname.startsWith('/dashboard')) {
      res.setHeader('Content-Type', 'text/html');
      res.end(
        await vite.transformIndexHtml(
          url.pathname,
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&amp;display=swap"></head><body><div id="root"></div><script type="module" src="/docs/evidence/design-build-check/fixture.client.tsx"></script></body></html>',
        ),
      );
      return;
    }
    vite.middlewares(req, res, () => {
      res.writeHead(404);
      res.end();
    });
  } catch (error) {
    if (!res.headersSent) send({ error: String(error) }, 500);
    else res.end();
  }
};
const server = createServer(handler);
if (process.env.DEPLOY_TEST_NO_LISTEN !== '1')
  server.listen(port, '127.0.0.1', () =>
    console.log(
      `Fixture: http://127.0.0.1:${port}/__fixture?state=TaskDesignCheck\nTest data: ${root}`,
    ),
  );
process.on('SIGINT', () => {
  server.close();
  void vite.close().then(() => process.exit());
});

if (process.env.DEPLOY_TEST_NO_LISTEN === '1') {
  for (const [state, expected] of [
    ['TaskDesignCheck', 'waiting'],
    ['TaskDesignChecked', 'matches'],
    ['DesignBuiltDiffers', 'differs'],
    ['fixed', 'waiting'],
    ['kept', 'kept'],
  ]) {
    await seed(state, true);
    assert.equal(taskSnapshot(owner, taskId).designCheck?.state, expected);
    assert.equal(latest().length, 3);
    if (state === 'DesignBuiltDiffers')
      assert.equal(get('v2-inbox-native', owner, decisionId!).item.actions.length, 2);
  }
  const { Readable } = await import('node:stream');
  for (const state of ['TaskDesignCheck', 'TaskDesignChecked', 'DesignBuiltDiffers']) {
    let status = 0;
    let location = '';
    const request = Object.assign(Readable.from([]), {
      url: `/__fixture?state=${state}&noCapture=1`,
      method: 'GET',
      headers: {},
    });
    const response = {
      writeHead(code: number, headers: Record<string, string>) {
        status = code;
        location = headers.location;
      },
      end() {},
    };
    await handler(
      request as unknown as import('node:http').IncomingMessage,
      response as unknown as import('node:http').ServerResponse,
    );
    assert.equal(status, 302);
    assert.ok(location.startsWith('/dashboard/'));
  }
  await vite.transformRequest('/docs/evidence/design-build-check/fixture.client.tsx');
  console.log(
    'Fixture self-test: 5 seeded states, 3 real-route redirects, and client transform passed.',
  );
  await vite.close();
  db.close();
}
