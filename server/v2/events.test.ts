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

test('every first pass refreshes, while periodic state refresh is shared across requests', async (t) => {
  const owner = randomUUID();
  await waitForV2Events(owner, 0, 0, new AbortController().signal);
  const transactions = t.mock.method(db, 'transaction');
  await Promise.all(
    Array.from({ length: 4 }, () => waitForV2Events(owner, 0, 1100, new AbortController().signal)),
  );
  const count = transactions.mock.callCount();
  assert.ok(count >= 5 && count <= 7, `four initial refreshes plus periodic refreshes: ${count}`);
  await waitForV2Events(owner, 0, 0, new AbortController().signal);
  assert.equal(transactions.mock.callCount(), count + 1);
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
