import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getEventListeners } from 'node:events';

const root = mkdtempSync(join(tmpdir(), 'deploy-events-'));
process.env.DEPLOY_DATA_DIR = root;
await import('../test-ports.ts');
const { db, event, cursor } = await import('../workspace/store.ts');
const { waitForV2Events } = await import('./events.ts');
after(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

test('real SQLite waiters share idle head checks and deliver the same event to all requests', async (t) => {
  const owner = randomUUID();
  await waitForV2Events(owner, 0, 0, new AbortController().signal);
  const prepare = t.mock.method(db, 'prepare');
  const pending = Array.from({ length: 27 }, () =>
    waitForV2Events(owner, 0, 1000, new AbortController().signal),
  );
  await delay(220);
  const heads = () =>
    prepare.mock.calls.filter((call) => String(call.arguments[0]).includes('MAX(cursor)')).length;
  const pages = () =>
    prepare.mock.calls.filter((call) =>
      String(call.arguments[0]).startsWith('SELECT * FROM events WHERE owner=? AND cursor>?'),
    ).length;
  assert.ok(heads() >= 2 && heads() <= 5, `${heads()} shared checks over 220ms`);
  assert.equal(pages(), 27, 'idle requests read their initial page only');
  event(owner, 'task', null, 'message', { role: 'user', content: 'wake everyone' });
  const responses = await Promise.all(pending);
  assert.ok(responses.every((response) => response.events.length === 1));
  assert.ok(responses.every((response) => response.cursor === cursor(owner)));
  assert.equal(pages(), 54);
  const count = heads();
  await delay(100);
  assert.equal(heads(), count, 'no SQLite checks after the last waiter leaves');
});

test('refresh is shared across sequential and concurrent long polls for the cadence', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const owner = randomUUID();
  const transactions = t.mock.method(db, 'transaction');
  const read = () => waitForV2Events(owner, 0, 0, new AbortController().signal);
  await Promise.all(Array.from({ length: 30 }, read));
  const count = transactions.mock.callCount();
  assert.equal(count, 1);
  for (let i = 0; i < 10; i++) await read();
  assert.equal(transactions.mock.callCount(), count);
  t.mock.timers.tick(1999);
  await read();
  assert.equal(transactions.mock.callCount(), count);
  t.mock.timers.tick(1);
  await Promise.all(Array.from({ length: 30 }, read));
  assert.equal(transactions.mock.callCount(), count + 1);
});

test('an inbox answer emits immediately and invalidates a warm refresh', async (t) => {
  const { save } = await import('../workspace/store.ts');
  const { syncInbox, answerInbox } = await import('./inbox.ts');
  const owner = randomUUID();
  const item = {
    id: 'update:test',
    kind: 'update',
    state: 'waiting',
    title: 'Update',
    createdAt: new Date().toISOString(),
    actions: [{ id: 'dismiss', label: 'Dismiss' }],
  };
  save('v2-inbox-native', owner, { id: item.id, item });
  syncInbox(owner);
  await waitForV2Events(owner, 0, 0, new AbortController().signal);
  const before = cursor(owner);
  const answered = answerInbox(owner, item.id, { actionId: 'dismiss', on: 'web' });
  assert.equal(answered.state, 'answered');
  const transactions = t.mock.method(db, 'transaction');
  const response = await waitForV2Events(owner, before, 0, new AbortController().signal);
  assert.equal(transactions.mock.callCount(), 1, 'answer invalidated the refresh');
  assert.ok(
    response.events.some((entry) => entry.type === 'inbox' && entry.item.state === 'answered'),
  );
});

test('drains full ignored pages at the deadline, advances ignored tails, and aborts cleanly', async () => {
  const owner = randomUUID();
  for (let i = 0; i < 2000; i++) event(owner, 'task', null, 'ignored', {});
  event(owner, 'task', null, 'message', { role: 'user', content: 'after full pages' });
  const page = await waitForV2Events(owner, 0, 0, new AbortController().signal);
  assert.equal(page.events.length, 1);
  assert.equal(page.cursor, cursor(owner));
  event(owner, 'task', null, 'ignored', {});
  const tail = await waitForV2Events(owner, page.cursor, 0, new AbortController().signal);
  assert.deepEqual(tail, { events: [], cursor: cursor(owner), supportsWait: true });
  const controller = new AbortController();
  const pending = waitForV2Events(owner, tail.cursor, 10000, controller.signal);
  await delay(10);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('waitMs is capped at ten seconds without opening sockets', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const owner = randomUUID();
  let finished = false;
  const pending = waitForV2Events(owner, 0, 100000, new AbortController().signal).then(
    (response) => {
      finished = true;
      return response;
    },
  );
  // Let the first-pass refresh finish before advancing the shared timer.
  for (let i = 0; i < 30; i++) await Promise.resolve();
  t.mock.timers.tick(9999);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(finished, true);
  assert.deepEqual(await pending, { events: [], cursor: 0, supportsWait: true });
});

test('pruned cursor gaps still drain full ignored pages and preserve an all-health owner head', async () => {
  const { pruneHealthEvents } = await import('../workspace/health-event-retention.ts');
  const owner = randomUUID();
  const quiet = randomUUID();
  event(quiet, '', null, 'v2.health', { app: { appId: 'quiet' } });
  const head = cursor(quiet);
  for (let i = 0; i < 2000; i++) {
    event(owner, '', null, 'v2.health', {});
    event(owner, '', null, 'ignored', {});
  }
  event(owner, 'task', null, 'message', { role: 'user', content: 'after pruning and full pages' });
  db.prepare("UPDATE events SET createdAt='2020-01-01' WHERE type='v2.health'").run();
  await pruneHealthEvents(db);
  assert.equal(cursor(quiet), head);
  const page = await waitForV2Events(owner, head + 1, 0, new AbortController().signal);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, 'conversation');
  assert.equal(page.cursor, cursor(owner));
  const empty = await waitForV2Events(quiet, head, 0, new AbortController().signal);
  assert.deepEqual(empty, { events: [], cursor: head, supportsWait: true });
  event(quiet, 'task', null, 'message', { role: 'user', content: 'new' });
  assert.equal(
    (await waitForV2Events(quiet, head, 0, new AbortController().signal)).events.length,
    1,
  );
});
