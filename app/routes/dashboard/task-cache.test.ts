import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskCache, isTaskSurface } from './task-cache.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('select exposes cached conversation, diff and pulls synchronously, then accepts fresh detail', async () => {
  const cache = new TaskCache<{ messages: string[]; pullRequests: string[] }, string>('account-a');
  cache.remember('task', {
    detail: { messages: ['cached'], pullRequests: ['pull'] },
    diff: 'cached diff',
  });
  const selected = cache.open('task');
  const fetch = deferred<{ messages: string[]; pullRequests: string[] }>();
  const refreshing = cache.read('task', 'detail', () => fetch.promise);
  assert.deepEqual(selected, {
    detail: { messages: ['cached'], pullRequests: ['pull'] },
    diff: 'cached diff',
  });
  fetch.resolve({ messages: ['fresh'], pullRequests: ['merged pull'] });
  await refreshing;
  assert.deepEqual(cache.open('task'), {
    detail: { messages: ['fresh'], pullRequests: ['merged pull'] },
    diff: 'cached diff',
  });
});

test('account, sign-out and coordinator changes discard data and fence late responses', async () => {
  for (const scope of ['account-b', 'signed-out', 'coordinator-b/account-a']) {
    const cache = new TaskCache<string, string>('coordinator-a/account-a');
    cache.remember('task', { detail: 'private conversation', diff: 'private diff' });
    const fetch = deferred<string>();
    let signal!: AbortSignal;
    const pending = cache.read('task', 'detail', (next) => {
      signal = next;
      return fetch.promise;
    });
    cache.reset(scope);
    assert.equal(signal.aborted, true);
    assert.equal(cache.open('task'), undefined);
    fetch.resolve('late private conversation');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cache.open('task'), undefined);
    await cache.read('task', 'detail', async () => 'new account');
    assert.equal(cache.open('task')?.detail, 'new account');
  }
});

test('hover, focus and selection share detail IO; completed prefetch opens synchronously and refreshes', async () => {
  const cache = new TaskCache<string, string>('account');
  const detail = deferred<string>();
  let reads = 0;
  const fetch = () => {
    reads++;
    return detail.promise;
  };
  const first = cache.prefetch('task', fetch);
  const second = cache.prefetch('task', fetch);
  cache.open('task');
  const selection = cache.read('task', 'detail', fetch);
  assert.equal(reads, 1);
  detail.resolve('conversation');
  await Promise.all([first, second, selection]);
  await cache.prefetch('task', fetch);
  assert.equal(reads, 1);
  assert.deepEqual(cache.open('task'), { detail: 'conversation' });
  await cache.read('task', 'detail', async () => 'fresh');
  assert.equal(cache.open('task')?.detail, 'fresh');
});

test('idle warms only three recent unselected details once per connection; LRU retains 24', () => {
  const cache = new TaskCache<string, string>('account');
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    updatedAt: String(i).padStart(2, '0'),
  }));
  const warmed: string[] = [];
  cache.warm(tasks, (id) => warmed.push(id), '29');
  cache.warm(tasks, (id) => warmed.push(id));
  assert.deepEqual(warmed, ['28', '27', '26']);
  for (let i = 0; i < 24; i++) cache.remember(String(i), { detail: String(i), diff: String(i) });
  cache.open('0');
  cache.remember('24', { detail: '24' });
  assert.equal(cache.open('1'), undefined);
  assert.deepEqual(cache.open('0'), { detail: '0', diff: '0' });
  cache.reset('next-account');
  cache.warm(tasks, (id) => warmed.push(id));
  assert.equal(warmed.length, 6);
});

test('all non-task surfaces reject speculative IO by route policy, including unknown routes', () => {
  for (const path of [
    'computers',
    'apps',
    'repositories',
    'settings',
    'catalog',
    'logs',
    'activity',
    'discover',
    'design-system',
    'apps/family-hub',
  ])
    assert.equal(isTaskSurface('/dashboard/' + path), false);
  for (const path of ['/dashboard', '/dashboard/', '/dashboard/projects'])
    assert.equal(isTaskSurface(path), true);
});

test('prefetch queue caps concurrency at two, deduplicates intent and fetches detail only', async () => {
  const cache = new TaskCache<string, string>('account');
  let active = 0,
    maximum = 0;
  const waiting: (() => void)[] = [];
  const fetch = () => {
    active++;
    maximum = Math.max(maximum, active);
    return new Promise<string>((resolve) =>
      waiting.push(() => {
        active--;
        resolve('detail');
      }),
    );
  };
  const pending = Array.from({ length: 8 }, (_, i) => cache.prefetch(String(i), fetch));
  void cache.prefetch('0', fetch);
  assert.equal(active, 2);
  for (let i = 0; i < 8; i++) {
    waiting.shift()!();
    await new Promise((resolve) => setImmediate(resolve));
  }
  await Promise.all(pending);
  assert.equal(maximum, 2);
  for (let i = 0; i < 8; i++) assert.deepEqual(cache.peek(String(i)), { detail: 'detail' });
});

test('navigation aborts active prefetches and clears queue; late aborted responses cannot populate cache', async () => {
  const cache = new TaskCache<string, string>('account');
  const signals: AbortSignal[] = [];
  const values = [deferred<string>(), deferred<string>()];
  const pending = ['a', 'b', 'queued'].map((id) =>
    cache.prefetch(id, (signal) => {
      signals.push(signal);
      return values[signals.length - 1].promise;
    }),
  );
  cache.cancelPrefetches();
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  values.forEach((value) => value.resolve('late'));
  await Promise.all(pending);
  assert.equal(signals.length, 2);
  assert.equal(cache.peek('a'), undefined);
  await cache.prefetch('a', async () => 'retry');
  assert.equal(cache.peek('a')?.detail, 'retry');
});

test('opening a task promotes its pending detail and aborts competitors without waiting for a queue slot', async () => {
  const cache = new TaskCache<string, string>('account');
  const selected = deferred<string>(),
    other = deferred<string>();
  let selectedSignal!: AbortSignal, otherSignal!: AbortSignal;
  const a = cache.prefetch('a', (signal) => {
    selectedSignal = signal;
    return selected.promise;
  });
  const b = cache.prefetch('b', (signal) => {
    otherSignal = signal;
    return other.promise;
  });
  const queued = cache.prefetch('queued', async () => assert.fail('queue was cleared'));
  cache.open('a');
  assert.equal(selectedSignal.aborted, false);
  assert.equal(otherSignal.aborted, true);
  const foreground = cache.read('a', 'detail', async () => assert.fail('must share selected IO'));
  // A different foreground request bypasses even non-cooperative aborted fetches.
  await cache.read('c', 'detail', async () => 'foreground');
  selected.resolve('selected');
  other.resolve('aborted');
  await Promise.all([a, b, queued]);
  assert.equal(await foreground, 'selected');
  assert.equal(cache.peek('b'), undefined);
});

test('failed detail prefetch can retry, and a foreground abort does not erase cached data', async () => {
  const cache = new TaskCache<string, string>('account');
  await cache.prefetch('task', async () => {
    throw new Error('offline');
  });
  await cache.prefetch('task', async () => 'recovered');
  const controller = new AbortController();
  const late = deferred<string>();
  const read = cache.read('task', 'detail', () => late.promise, controller.signal);
  controller.abort();
  late.resolve('late');
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(cache.peek('task')?.detail, 'recovered');
});
