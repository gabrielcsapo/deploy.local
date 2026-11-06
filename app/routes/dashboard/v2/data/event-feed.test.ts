import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { getEventListeners } from 'node:events';
import { createEventFeed } from './event-feed.ts';
import type { V2Event } from '../../../../../shared/v2/api.ts';

const settle = async () => {
  await setImmediate();
  await setImmediate();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const event = (cursor: number): V2Event => ({
  cursor,
  type: 'agent',
  agentId: 'agent',
  taskId: 'task',
  runId: null,
  at: '',
});
const json = (cursor: number, events: V2Event[] = []) =>
  new Response(JSON.stringify({ cursor, events, supportsWait: true }));
function server() {
  const polls: {
    after: number;
    signal: AbortSignal;
    result: ReturnType<typeof deferred<Response>>;
  }[] = [];
  let head = 0;
  let latest: (() => Promise<Response>) | undefined;
  const request: typeof fetch = async (url, init) => {
    const after = new URL(String(url), 'http://test').searchParams.get('after')!;
    if (after === 'latest') return latest ? latest() : json(head);
    const result = deferred<Response>();
    const signal = init!.signal!;
    const abort = () => result.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    polls.push({ after: Number(after), signal, result });
    try {
      return await result.promise;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  };
  return {
    request,
    polls,
    setHead(value: number) {
      head = value;
    },
    setLatest(value?: () => Promise<Response>) {
      latest = value;
    },
  };
}

test('one long poll serves subscribers; snapshot buffers pages and joining mid-poll gets its own boundary', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  const load = deferred<void>();
  const first: number[] = [],
    second: number[] = [];
  const off = feed.subscribe({
    snapshot: () => load.promise,
    events: (events) => {
      first.push(...events.map((e) => e.cursor));
    },
    error: assert.fail,
  });
  await settle();
  assert.equal(backend.polls.length, 1);
  assert.equal(backend.polls[0].after, 0, 'zero is a valid latest position');
  const boundary = deferred<Response>();
  const joinedLoad = deferred<void>();
  backend.setLatest(() => boundary.promise);
  const off2 = feed.subscribe({
    snapshot: () => joinedLoad.promise,
    events: (events) => {
      second.push(...events.map((e) => e.cursor));
    },
    error: assert.fail,
  });
  backend.polls[0].result.resolve(json(3, [event(1), event(2), event(3)]));
  await settle();
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  // Cursor 1 was captured before the joining subscriber's snapshot. Its latest response
  // arrives after the in-flight poll, so filtering must include already-buffered pages.
  boundary.resolve(json(1));
  await settle();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(backend.polls.length, 2, 'joining adds a latest read, never a second long poll');
  backend.polls[1].result.resolve(json(4, [event(4)]));
  await settle();
  load.resolve();
  joinedLoad.resolve();
  await settle();
  assert.deepEqual(first, [1, 2, 3, 4]);
  assert.deepEqual(second, [2, 3, 4]);
  t.mock.timers.tick(0);
  await settle();
  const last = backend.polls.at(-1)!;
  off();
  assert.equal(last.signal.aborted, false);
  off2();
  await settle();
  assert.equal(last.signal.aborted, true);
  assert.equal(getEventListeners(last.signal, 'abort').length, 0);
  const count = backend.polls.length;
  t.mock.timers.tick(100000);
  await settle();
  assert.equal(backend.polls.length, count);
});

test('a failing snapshot or handler cannot block other subscribers; failed batches retry after a snapshot', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  let snapshots = 0,
    attempts = 0;
  const good: number[] = [],
    bad: number[] = [],
    failures: string[] = [];
  const off = feed.subscribe({
    async snapshot() {
      snapshots++;
      if (snapshots === 1) throw new Error('snapshot');
    },
    events(events) {
      attempts++;
      if (attempts === 1) throw new Error('handler');
      bad.push(...events.map((e) => e.cursor));
    },
    error(_error, phase) {
      failures.push(phase);
    },
  });
  const off2 = feed.subscribe({
    snapshot: async () => {},
    events(events) {
      good.push(...events.map((e) => e.cursor));
    },
    error: assert.fail,
  });
  await settle();
  backend.polls[0].result.resolve(json(1, [event(1)]));
  await settle();
  assert.deepEqual(good, [1]);
  assert.deepEqual(bad, []);
  t.mock.timers.tick(250);
  await settle();
  assert.deepEqual(failures, ['snapshot', 'events']);
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(bad, [1]);
  assert.equal(snapshots, 3);
  off();
  off2();
  await settle();
});

test('connection gaps back off, reload snapshots before replay, and reset backoff after recovery', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  const calls: string[] = [];
  const off = feed.subscribe({
    snapshot: async () => {
      calls.push('snapshot');
    },
    events(events) {
      calls.push(`events:${events[0].cursor}`);
    },
    error() {
      calls.push('error');
    },
  });
  await settle();
  backend.polls[0].result.reject(new Error('offline'));
  await settle();
  t.mock.timers.tick(249);
  await settle();
  assert.equal(backend.polls.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(backend.polls.length, 2);
  assert.equal(backend.polls[1].after, 0);
  backend.polls[1].result.reject(new Error('offline'));
  await settle();
  t.mock.timers.tick(499);
  await settle();
  assert.equal(backend.polls.length, 2);
  t.mock.timers.tick(1);
  await settle();
  backend.polls[2].result.resolve(json(1, [event(1)]));
  await settle();
  assert.deepEqual(calls, ['snapshot', 'error', 'snapshot', 'error', 'snapshot', 'events:1']);
  t.mock.timers.tick(0);
  await settle();
  backend.polls[3].result.reject(new Error('offline again'));
  await settle();
  t.mock.timers.tick(250);
  await settle();
  assert.equal(backend.polls.length, 5);
  off();
  await settle();
});

test('reset aborts old snapshots and polls, clears queued events, and captures the new account position', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  const oldLoad = deferred<void>();
  const signals: AbortSignal[] = [];
  const received: number[] = [];
  let resets = 0;
  const off = feed.subscribe({
    snapshot(signal) {
      signals.push(signal);
      return signals.length === 1 ? oldLoad.promise : Promise.resolve();
    },
    events(events) {
      received.push(...events.map((e) => e.cursor));
    },
    error: assert.fail,
    reset() {
      resets++;
    },
  });
  await settle();
  backend.polls[0].result.resolve(json(1, [event(1)]));
  await settle();
  backend.setHead(20);
  feed.reset();
  await settle();
  oldLoad.resolve();
  await settle();
  assert.equal(signals[0].aborted, true);
  assert.equal(backend.polls[0].signal.aborted, true);
  assert.equal(resets, 1);
  assert.equal(backend.polls[1].after, 20);
  backend.polls[1].result.resolve(json(21, [event(21)]));
  await settle();
  assert.deepEqual(received, [21]);
  off();
  await settle();
  assert.equal(signals[1].aborted, true);
});

test('last unsubscribe cancels retry timers, and restart takes a fresh position', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  const subscriber = { snapshot: async () => {}, events() {}, error() {} };
  const off = feed.subscribe(subscriber);
  await settle();
  backend.polls[0].result.reject(new Error('offline'));
  await settle();
  const signal = backend.polls[0].signal;
  off();
  await settle();
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  t.mock.timers.tick(100000);
  await settle();
  assert.equal(backend.polls.length, 1);
  backend.setHead(100);
  const nextOff = feed.subscribe(subscriber);
  await settle();
  assert.equal(backend.polls[1].after, 100);
  nextOff();
  await settle();
});

test('reusing subscriber handlers still creates independent subscriptions and delivers empty pages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const backend = server();
  const feed = createEventFeed(backend.request);
  let deliveries = 0;
  const subscriber = {
    snapshot: async () => {},
    events() {
      deliveries++;
    },
    error: assert.fail,
  };
  const off = feed.subscribe(subscriber);
  const off2 = feed.subscribe(subscriber);
  await settle();
  backend.polls[0].result.resolve(json(0));
  await settle();
  assert.equal(deliveries, 2);
  off();
  t.mock.timers.tick(100);
  await settle();
  assert.equal(backend.polls[1].signal.aborted, false);
  backend.polls[1].result.resolve(json(1, [event(1)]));
  await settle();
  assert.equal(deliveries, 3);
  off2();
  await settle();
});
