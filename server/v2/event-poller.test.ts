import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createOwnerEventPoller } from './event-poller.ts';

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
async function advance(t: TestContext, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 50) {
    t.mock.timers.tick(Math.min(50, ms - elapsed));
    await settle();
  }
}

for (const count of [1, 27])
  test(`${count} waiters use one head check every 50 ms and all receive the wakeup`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let head = 0;
    let checks = 0;
    const feed = createOwnerEventPoller({
      head: () => {
        checks++;
        return head;
      },
      refresh: async () => {},
    });
    const controllers = Array.from({ length: count }, () => new AbortController());
    let delivered = 0;
    const pending = controllers.map((controller) =>
      feed.wait('owner', 0, 1000, controller.signal).then(() => delivered++),
    );
    await advance(t, 200);
    assert.equal(checks, 4);
    assert.equal(delivered, 0);
    head = 1;
    await advance(t, 50);
    await Promise.all(pending);
    assert.equal(delivered, count);
    assert.equal(checks, 5);
    for (const controller of controllers)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await advance(t, 1000);
    assert.equal(checks, 5, 'the last waiter stops and removes the poller');
  });

test('abort removes its listener; the last abort stops checks and a later waiter restarts them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let checks = 0;
  const feed = createOwnerEventPoller({
    head: () => {
      checks++;
      return 0;
    },
    refresh: async () => {},
  });
  const first = new AbortController(),
    last = new AbortController();
  const a = assert.rejects(feed.wait('owner', 0, 10000, first.signal), { name: 'AbortError' });
  const b = assert.rejects(feed.wait('owner', 0, 10000, last.signal), { name: 'AbortError' });
  await advance(t, 50);
  first.abort();
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  await advance(t, 50);
  assert.equal(checks, 2);
  last.abort();
  await Promise.all([a, b]);
  assert.equal(getEventListeners(last.signal, 'abort').length, 0);
  await advance(t, 1000);
  assert.equal(checks, 2);
  const next = feed.wait('owner', 0, Date.now() + 50, new AbortController().signal);
  await advance(t, 50);
  await next;
  assert.equal(checks, 3);
});

for (const failure of ['head', 'refresh'])
  test(`${failure} failure rejects all waiters promptly and a later poll recovers`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let fail = true;
    const feed = createOwnerEventPoller({
      head: () => {
        if (fail && failure === 'head') throw new Error('busy');
        return 1;
      },
      refresh: async () => {
        if (fail && failure === 'refresh') throw new Error('busy');
      },
    });
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      assert.rejects(feed.wait('owner', 0, 10000, controller.signal), /busy/),
    );
    await advance(t, 50);
    await Promise.all(pending);
    for (const controller of controllers)
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    fail = false;
    const recovered = feed.wait('owner', 0, 10000, new AbortController().signal);
    await advance(t, 50);
    await recovered;
  });

test('owners, cursors and deadlines are independent; new arrivals do not postpone a check', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const checked: string[] = [];
  const feed = createOwnerEventPoller({
    head: (owner) => {
      checked.push(owner);
      return owner === 'a' ? 2 : 0;
    },
    refresh: async () => {},
  });
  const a = feed.wait('a', 0, 1000, new AbortController().signal);
  let newerDone = false,
    bDone = false;
  const b = feed.wait('b', 0, 120, new AbortController().signal).then(() => {
    bDone = true;
  });
  t.mock.timers.tick(25);
  const newer = feed.wait('a', 2, 100, new AbortController().signal).then(() => {
    newerDone = true;
  });
  t.mock.timers.tick(25);
  await settle();
  await a;
  assert.deepEqual(checked.sort(), ['a', 'b']);
  assert.equal(newerDone, false);
  assert.equal(bDone, false);
  await advance(t, 50);
  await newer;
  assert.equal(bDone, false);
  t.mock.timers.tick(20);
  await settle();
  await b;
});

test('abort during a refresh cannot revive an old owner timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let finish!: () => void;
  let checks = 0;
  const feed = createOwnerEventPoller({
    head: () => {
      checks++;
      return 1;
    },
    refresh: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  });
  const controller = new AbortController();
  const pending = assert.rejects(feed.wait('owner', 0, 10000, controller.signal), {
    name: 'AbortError',
  });
  await advance(t, 50);
  controller.abort();
  await pending;
  finish();
  await settle();
  await advance(t, 1000);
  assert.equal(checks, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
