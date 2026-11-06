import test from 'node:test';
import assert from 'node:assert/strict';
import { eventSnapshotCursor } from './event-snapshot.ts';

test('starts at latest before the list and retains events arriving during the load', async () => {
  const calls: string[] = [];
  let head = 42;
  const signal = new AbortController().signal;
  const cursor = await eventSnapshotCursor(
    async () => {
      calls.push('latest');
      return { cursor: head };
    },
    async () => {
      calls.push('list');
      head++;
      return true;
    },
    signal,
  );
  assert.deepEqual(calls, ['latest', 'list']);
  assert.equal(cursor, 42);
  assert.ok(head > cursor, 'the event during the list is included by the next poll');
});

test('failed bootstrap never returns a usable cursor; zero is a valid latest cursor', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    eventSnapshotCursor(
      async () => ({ cursor: 42 }),
      async () => false,
      signal,
    ),
  );
  let loaded = false;
  await assert.rejects(
    eventSnapshotCursor(
      async () => {
        throw new Error('offline');
      },
      async () => {
        loaded = true;
        return true;
      },
      signal,
    ),
  );
  assert.equal(loaded, false);
  assert.equal(
    await eventSnapshotCursor(
      async () => ({ cursor: 0 }),
      async () => true,
      signal,
    ),
    0,
  );
});

test('unmounted consumers cannot load or publish a stale bootstrap', async () => {
  const controller = new AbortController();
  let loaded = false;
  await assert.rejects(
    eventSnapshotCursor(
      async () => {
        controller.abort();
        return { cursor: 42 };
      },
      async () => {
        loaded = true;
        return true;
      },
      controller.signal,
    ),
    { name: 'AbortError' },
  );
  assert.equal(loaded, false);
  const next = new AbortController();
  await assert.rejects(
    eventSnapshotCursor(
      async () => ({ cursor: 42 }),
      async () => {
        next.abort();
        return true;
      },
      next.signal,
    ),
    { name: 'AbortError' },
  );
});
