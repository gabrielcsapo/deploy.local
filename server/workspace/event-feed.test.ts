import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
const root = mkdtempSync(join(tmpdir(), 'deploy-feed-'));
process.env.DEPLOY_DATA_DIR = root;
const { db, event, cursor } = await import('./store.ts');
const { waitForEvents } = await import('./event-feed.ts');
const { workspaceApi } = await import('./api.ts');
const server = createServer((req, res) => {
  void workspaceApi(req, res, 'owner', req.headers['x-worker'] ? 'worker' : undefined);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}/api/workspace/events`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('waiting feed observes independent worker commits and preserves cursor replay', async () => {
  const pending = fetch(origin + '?after=0&waitMs=10000');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {event, db} from './server/workspace/store.ts';
     event('owner', 'task', null, 'message.delta', {text:'hello'}); db.close();`,
    ],
    { env: process.env, stdio: 'ignore' },
  );
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
  const page: any = await (await pending).json();
  assert.equal(page.supportsWait, true);
  assert.equal(page.events[0].payload.text, 'hello');
  assert.equal(page.cursor, cursor('owner'));
  const replay: any = await (await fetch(origin + '?after=0')).json();
  assert.deepEqual(replay, page);
});

test('other owners and tasks cannot wake a filtered waiter; timeout keeps cursor', async () => {
  const afterCursor = cursor('owner');
  const started = Date.now();
  const pending = waitForEvents('owner', afterCursor, 'target', 150, new AbortController().signal);
  event('private-owner', 'target', null, 'private', {});
  event('owner', 'different-task', null, 'unrelated', {});
  const page = await pending;
  assert.deepEqual(page.events, []);
  assert.equal(page.cursor, afterCursor);
  assert.ok(Date.now() - started >= 140);
});

test('disconnect aborts waiting without leaving a timer running', async () => {
  const controller = new AbortController();
  const pending = waitForEvents('owner', cursor('owner'), undefined, 10000, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  const request = fetch(origin + '?after=' + cursor('owner') + '&waitMs=10000', {
    signal: AbortSignal.timeout(50),
  });
  await assert.rejects(request);
  await delay(75);
  assert.equal((await fetch(origin)).status, 200);
});

test('invalid cursors/durations and worker credentials are rejected before waiting', async () => {
  for (const query of ['after=-1', 'after=NaN', 'after=1.5', 'waitMs=Infinity', 'waitMs=-1'])
    assert.equal((await fetch(origin + '?' + query)).status, 400);
  assert.equal(
    (await fetch(origin + '?waitMs=10000', { headers: { 'x-worker': 'yes' } })).status,
    403,
  );
});
