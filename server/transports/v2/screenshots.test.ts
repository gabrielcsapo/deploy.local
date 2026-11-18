import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
const root = mkdtempSync(join(tmpdir(), 'v2-screenshots-'));
process.env.DEPLOY_DATA_DIR = root;
process.env.DEPLOY_CODEX_BIN = '/usr/bin/false';
const store = await import('../../store.ts');
const { db, get, save, events, list } = await import('../../workspace/store.ts');
const { v2Api } = await import('../../v2/api.ts');
const {
  queueScreenshots,
  screenshotWorker,
  patchScreenshot,
  validateMarkup,
  validateTarget,
  sendTaskMessage,
} = await import('./screenshots.ts');
const { storeAttachment, attachmentRecord, mapMediaEvent } =
  await import('../../v2/attachments.ts');
const { enrollWorker } = await import('../../workspace/credentials.ts');
const server = createServer(
  (req, res) =>
    void v2Api(req, res, () => ({ username: String(req.headers['x-test-owner'] || 'owner') })),
);
// Port 0 lets the OS pick a free port, so test files can run in parallel.
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
const base = `${origin}/api`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  store._resetDb();
  rmSync(root, { recursive: true, force: true });
});
const image = {
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO9sAAAAASUVORK5CYII=',
  type: 'image/png',
  width: 390,
  height: 780,
};
const target = { kind: 'web', url: 'http://127.0.0.1:5193/' };
const enrollment = enrollWorker('owner', { workerId: 'mac' });
const workerHeaders = {
  'Content-Type': 'application/json',
  'x-deploy-worker-id': 'mac',
  'x-deploy-worker-token': enrollment.workerToken,
};
save('worker', 'owner', {
  id: 'mac',
  name: 'MacBook Pro',
  heartbeat: new Date().toISOString(),
  modelOptions: [
    {
      id: 'codex',
      models: [
        { id: 'one', name: 'One' },
        { id: 'two', name: 'Two' },
      ],
    },
  ],
});
function task(id: string) {
  save('task', 'owner', {
    id,
    workerId: 'mac',
    title: 'Meal planner',
    revision: 0,
    workspaceStatus: 'ready',
  });
}
test('HTTP screenshot request is captured by its assigned worker and emits a typed event', async () => {
  task('meal');
  const response = fetch(base + '/tasks/meal/screenshots', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, widths: [390, 1440] }),
  });
  let request: any;
  for (let i = 0; i < 30 && !request; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    request = screenshotWorker('owner', 'mac', 'poll', {}).request;
  }
  assert.ok(request);
  assert.equal(screenshotWorker('owner', 'other-computer', 'poll', {}).request, null);
  assert.throws(
    () => screenshotWorker('owner', 'other-computer', 'complete', { ...request, images: [image] }),
    /another worker/,
  );
  const complete = await fetch(base + '/screenshots/worker/complete', {
    method: 'POST',
    headers: workerHeaders,
    body: JSON.stringify({
      id: request.id,
      lease: request.lease,
      images: [image, { ...image, width: 1440, height: 900 }],
    }),
  });
  assert.equal(complete.status, 200, await complete.text());
  const result = await response;
  assert.equal(result.status, 200);
  const { screenshots } = await result.json();
  assert.equal(screenshots.length, 2);
  assert.equal(screenshots[0].workerId, 'mac');
  const rows = events('owner', 0, 'meal').filter((row) => row.type === 'v2.conversation');
  assert.equal(rows.length, 2);
  assert.deepEqual(mapMediaEvent(rows[0]), {
    kind: 'screenshot',
    id: `screenshot:${screenshots[0].id}`,
    at: screenshots[0].takenAt,
    screenshotId: screenshots[0].id,
  });
  assert.equal(
    (
      await fetch(base + '/screenshots/' + screenshots[0].id, {
        headers: { 'x-test-owner': 'other' },
      })
    ).status,
    404,
  );
  assert.equal(
    (await fetch(base + '/tasks/meal/screenshots', { headers: { 'x-test-owner': 'other' } }))
      .status,
    404,
  );
});
test('markup round trip retains source, flattened image and structured marks with owner checks', async () => {
  const shot = list('screenshot', 'owner')[0];
  const rendered = storeAttachment(
    'owner',
    Buffer.from(image.data, 'base64'),
    'image/png',
    'marked.png',
  );
  const markup = {
    strokes: [
      {
        tool: 'pen',
        color: 0,
        points: [
          [20, 30],
          [40, 50],
        ],
      },
      {
        tool: 'arrow',
        color: 1,
        points: [
          [5, 6],
          [7, 8],
        ],
      },
    ],
    texts: [{ x: 90, y: 100, text: 'pick-up night!', color: 2 }],
  };
  const response = await fetch(base + '/screenshots/' + shot.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markup, renderedImage: rendered.ref }),
  });
  assert.equal(response.status, 200);
  const updated = (await response.json()).screenshot;
  assert.deepEqual(updated.markup, markup);
  assert.equal(updated.image, shot.image);
  assert.equal(updated.renderedImage, rendered.ref);
  assert.deepEqual(attachmentRecord('owner', rendered.ref).markup, markup);
  assert.throws(() => patchScreenshot('other', shot.id, { markup }), /Not found/);
  const alien = storeAttachment(
    'other',
    Buffer.from(image.data, 'base64'),
    'image/png',
    'other.png',
  );
  assert.throws(
    () => patchScreenshot('owner', shot.id, { markup, renderedImage: alien.ref }),
    /Not found/,
  );
  assert.throws(
    () => validateMarkup({ ...markup, texts: [{ x: Infinity, y: 2, color: 0, text: 'bad' }] }),
    /Invalid/,
  );
  assert.throws(
    () =>
      validateMarkup({
        strokes: [
          {
            tool: 'box',
            color: 0,
            points: [
              [1, 2],
              [3, 4],
            ],
          },
        ],
        texts: [],
      }),
    /stroke/,
  );
});
test('desktop captures require the current task, exact window, role, and a live approval', () => {
  task('desktop');
  const body = { target: { kind: 'desktop', device: 'window-1-2' }, widths: [390] };
  assert.throws(() => queueScreenshots('owner', 'desktop', body), /Approve Use the screen/);
  save('interactive-session', 'owner', {
    id: 'session',
    taskId: 'desktop',
    workerId: 'mac',
    targetId: 'window-1-2',
    kind: 'computer',
    status: 'active',
    heartbeat: new Date().toISOString(),
    expiresAt: Date.now() + 10000,
  });
  save('v2-computer-roles', 'owner', { id: 'mac', workerIds: ['mac'], roles: ['take-tasks'] });
  assert.throws(() => queueScreenshots('owner', 'desktop', body), /permission/);
  save('v2-computer-roles', 'owner', {
    id: 'mac',
    workerIds: ['mac'],
    roles: ['take-tasks', 'use-screen'],
  });
  queueScreenshots('owner', 'desktop', body);
  const request = screenshotWorker('owner', 'mac', 'poll', {}).request;
  save('interactive-session', 'owner', {
    ...get('interactive-session', 'owner', 'session'),
    status: 'stopped',
  });
  assert.throws(
    () => screenshotWorker('owner', 'mac', 'complete', { ...request, images: [image] }),
    /Approve/,
  );
  assert.throws(
    () => validateTarget({ kind: 'ios-simulator', device: 'physical-phone' }),
    /simulator UUID/,
  );
  assert.throws(() => validateTarget({ kind: 'web', url: 'file:///etc/passwd' }), /address/);
});
test('message submission binds owner attachments to the run and overrides only this chat', async () => {
  task('chat');
  const defaults = { 'writing-code': 'codex:one', reviewing: null, 'answering-questions': null };
  save('v2-model-defaults', 'owner', { id: 'defaults', defaults });
  const attachment = storeAttachment('owner', Buffer.from('hello'), 'text/plain', 'notes.txt');
  const result = sendTaskMessage('owner', 'chat', {
    text: 'Read my notes',
    attachments: [attachment],
    model: 'codex:two',
  });
  const run = get('run', 'owner', result.runId);
  assert.equal(run.model, 'two');
  assert.deepEqual(run.attachments, [attachment]);
  assert.deepEqual(get('v2-model-defaults', 'owner', 'defaults').defaults, defaults);
  const message = events('owner', 0, 'chat').find((row) => row.type === 'message')!;
  assert.deepEqual(message.payload.attachments, [attachment]);
  assert.throws(
    () => sendTaskMessage('other', 'chat', { text: 'steal', attachments: [attachment] }),
    /Not found/,
  );
  assert.equal(
    (
      await fetch(base + '/screenshots/worker/attachments', {
        method: 'POST',
        headers: workerHeaders,
        body: JSON.stringify({ runId: run.id }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(base + '/conversation-attachments', {
        method: 'POST',
        headers: workerHeaders,
        body: 'no',
      })
    ).status,
    403,
  );
});

test('a first message can start its task on a branch of the chosen project', async () => {
  const { git } = await import('../../workspace/service.ts');
  const { createProject } = await import('../../workspace/test-repository.ts');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const source = join(root, 'branch-source');
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.invalid']);
  writeFileSync(join(source, 'a.txt'), 'main\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'Main']);
  const main = git(source, ['rev-parse', 'HEAD']);
  git(source, ['checkout', '-b', 'build/project-work']);
  writeFileSync(join(source, 'a.txt'), 'branch\n');
  git(source, ['commit', '-am', 'Branch']);
  const branch = git(source, ['rev-parse', 'HEAD']);
  git(source, ['checkout', 'main']);
  const project = createProject('owner', { name: 'Branches', sourcePath: source });
  const onBranch = sendTaskMessage('owner', undefined, {
    text: 'Merge main into build/project-work',
    projectId: project.id,
    ref: 'refs/heads/build/project-work',
  });
  assert.equal(get('task', 'owner', onBranch.taskId).baseRevision, branch);
  const onMain = sendTaskMessage('owner', undefined, { text: 'Tidy up', projectId: project.id });
  assert.equal(get('task', 'owner', onMain.taskId).baseRevision, main);
  assert.throws(
    () =>
      sendTaskMessage('owner', undefined, {
        text: 'Nowhere',
        projectId: project.id,
        ref: 'refs/heads/missing',
      }),
    /./,
  );
});
