import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskCache } from './task-cache.ts';

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

test('hover, focus, warm and select share in-flight reads; cached prefetch makes no new requests', async () => {
  const cache = new TaskCache<string, string>('account');
  const detail = deferred<string>(),
    diff = deferred<string>();
  let details = 0,
    diffs = 0;
  const readDetail = () => {
    details++;
    return detail.promise;
  };
  const readDiff = () => {
    diffs++;
    return diff.promise;
  };
  const first = cache.prefetch('task', readDetail, readDiff);
  const second = cache.prefetch('task', readDetail, readDiff);
  const selection = cache.read('task', 'detail', readDetail);
  assert.equal(details, 1);
  assert.equal(diffs, 1);
  detail.resolve('conversation');
  diff.resolve('diff');
  await Promise.all([first, second, selection]);
  await cache.prefetch('task', readDetail, readDiff);
  assert.equal(details, 1);
  assert.equal(diffs, 1);
});

test('only six recent tasks warm once per connection and opening retains the last 24 tasks', () => {
  const cache = new TaskCache<string, string>('account');
  const tasks = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    updatedAt: String(i).padStart(2, '0'),
  }));
  const warmed: string[] = [];
  cache.warm(tasks, (id) => warmed.push(id));
  cache.warm(tasks, (id) => warmed.push(id));
  assert.deepEqual(warmed, ['29', '28', '27', '26', '25', '24']);
  for (let i = 0; i < 24; i++) cache.remember(String(i), { detail: String(i), diff: String(i) });
  cache.open('0');
  cache.remember('24', { detail: '24' });
  assert.equal(cache.open('1'), undefined);
  assert.deepEqual(cache.open('0'), { detail: '0', diff: '0' });
  cache.reset('next-account');
  cache.warm(tasks, (id) => warmed.push(id));
  assert.equal(warmed.length, 12);
});

test('failed prefetch is retryable and diff failure does not discard conversation', async () => {
  const cache = new TaskCache<string, string>('account');
  await cache.prefetch(
    'task',
    async () => 'detail',
    async () => {
      throw new Error('offline');
    },
  );
  assert.deepEqual(cache.open('task'), { detail: 'detail' });
  await cache.prefetch(
    'task',
    async () => assert.fail('detail already cached'),
    async () => 'recovered',
  );
  assert.equal(cache.open('task')?.diff, 'recovered');
});
