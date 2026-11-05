import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInboxStore } from './inbox-store.ts';
import { dayLabel, readResource, taskState, type SidebarTask } from './sidebar.ts';
import type { InboxItem } from '../../../../../shared/v2/contracts.ts';

const item: InboxItem = {
  id: 'question:releases',
  kind: 'question',
  title: 'Keep 3 or 5 releases?',
  text: 'Choose how many to keep.',
  from: 'scout',
  createdAt: '2026-10-27T12:00:00Z',
  actions: [
    { id: 'three', label: '3' },
    { id: 'five', label: '5' },
  ],
  state: 'waiting',
};
const answered: InboxItem = {
  ...item,
  state: 'answered',
  answer: { actionId: 'five', by: 'gabriel', on: 'iphone', at: '2026-10-27T13:00:00Z' },
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
function pending(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_, reject) =>
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );
}

test('one feed serves multiple hook subscribers, consumes cursor and aborts on unmount', async () => {
  const paths: string[] = [];
  let eventSignal: AbortSignal | null | undefined;
  const request: typeof fetch = async (url, init) => {
    paths.push(String(url));
    if (String(url).includes('state=waiting')) return json({ items: [item] });
    if (String(url).includes('state=answered')) return json({ items: [] });
    if (String(url).includes('after=latest'))
      return json({ events: [], cursor: 7, supportsWait: true });
    if (String(url).includes('after=7&'))
      return json({ events: [{ type: 'inbox', item: answered }], cursor: 42, supportsWait: true });
    eventSignal = init?.signal;
    return pending(init?.signal);
  };
  const store = createInboxStore(request);
  const off = store.subscribe(() => {});
  const off2 = store.subscribe(() => {});
  await tick();
  assert.deepEqual(store.getSnapshot().items, [answered]);
  assert.equal(paths.filter((path) => path.includes('state=waiting')).length, 1);
  // The feed starts at the newest event, never replaying history from 0.
  assert.ok(!paths.some((path) => path.includes('after=0&')));
  assert.ok(paths.includes('/api/v2/events?after=42&waitMs=10000'));
  off();
  assert.equal(eventSignal?.aborted, false);
  off2();
  assert.equal(eventSignal?.aborted, true);
});

for (const status of [200, 409])
  test(`answer ${status} publishes the stored answer to every subscriber and sends web provenance`, async () => {
    let sent: RequestInit | undefined;
    const store = createInboxStore(async (url, init) => {
      if (String(url).includes('after=latest')) return json({ events: [], cursor: 0 });
      if (init?.method === 'POST') {
        sent = init;
        assert.equal(url, '/api/v2/inbox/question%3Areleases/answer');
        return json({ item: answered, answer: answered.answer }, status);
      }
      if (String(url).includes('state='))
        return json({ items: String(url).includes('state=waiting') ? [item] : [] });
      return pending(init?.signal);
    });
    let notifications = 0;
    const off = store.subscribe(() => notifications++);
    await tick();
    const before = notifications;
    const result = await store.answer(item.id, 'three', ' Please keep three ');
    assert.deepEqual(JSON.parse(String(sent?.body)), {
      actionId: 'three',
      on: 'web',
      note: 'Please keep three',
    });
    assert.equal(result?.conflict, status === 409);
    assert.deepEqual(store.getSnapshot().items, [answered]);
    assert.ok(notifications > before);
    off();
  });

test('snapshot answer survives stale waiting events; expired decisions leave the waiting list', async () => {
  const expired = { ...item, id: 'expired', state: 'expired' };
  const store = createInboxStore(async (url, init) => {
    if (String(url).includes('after=latest')) return json({ events: [], cursor: 0 });
    if (String(url).includes('state=waiting')) return json({ items: [{ ...item, id: 'expired' }] });
    if (String(url).includes('state=answered')) return json({ items: [answered] });
    if (String(url).includes('after=0&'))
      return json({
        events: [
          { type: 'inbox', item },
          { type: 'inbox', item: expired },
        ],
        cursor: 3,
      });
    return pending(init?.signal);
  });
  const off = store.subscribe(() => {});
  await tick();
  assert.equal(store.getSnapshot().items.filter((entry) => entry.state === 'waiting').length, 0);
  assert.deepEqual(
    store.getSnapshot().items.find((entry) => entry.id === item.id),
    answered,
  );
  off();
});

test('failed answers preserve waiting and HTTP 409 without an item is not success', async () => {
  let status = 503;
  const store = createInboxStore(async (url, init) => {
    if (String(url).includes('after=latest')) return json({ events: [], cursor: 0 });
    if (init?.method === 'POST') return json({ error: 'Unavailable' }, status);
    if (String(url).includes('state='))
      return json({ items: String(url).includes('state=waiting') ? [item] : [] });
    return pending(init?.signal);
  });
  const off = store.subscribe(() => {});
  await tick();
  await assert.rejects(store.answer(item.id, 'three'), /could not be saved/);
  status = 409;
  await assert.rejects(store.answer(item.id, 'three'), /could not be saved/);
  assert.equal(store.getSnapshot().items[0].state, 'waiting');
  off();
});

test('account reset clears private data and ignores late responses from the old feed', async () => {
  let finish: ((response: Response) => void) | undefined;
  let reset = false;
  const store = createInboxStore(async (url, init) => {
    if (String(url).includes('after=latest')) return json({ events: [], cursor: 0 });
    if (String(url).includes('state='))
      return json({ items: !reset && String(url).includes('state=waiting') ? [item] : [] });
    if (!reset)
      return new Promise((resolve) => {
        finish = resolve;
      });
    return pending(init?.signal);
  });
  const off = store.subscribe(() => {});
  await tick();
  reset = true;
  store.reset();
  finish?.(json({ events: [{ type: 'inbox', item: answered }], cursor: 20 }));
  await tick();
  assert.deepEqual(store.getSnapshot().items, []);
  off();
});

test('resources feature-detect only 404; failures never become healthy zero counts', async () => {
  const signal = new AbortController().signal;
  assert.equal(await readResource(async () => json({}, 404), '/api/v2/live', signal, true), null);
  await assert.rejects(readResource(async () => json({}, 401), '/api/v2/live', signal, true));
  await assert.rejects(readResource(async () => json({}, 503), '/api/nodes', signal));
  assert.deepEqual(
    await readResource(
      async () => json({ summary: { running: 7, failing: 1 } }),
      '/api/v2/live',
      signal,
      true,
    ),
    { summary: { running: 7, failing: 1 } },
  );
});

test('sidebar uses latest run state and calendar days, including a month boundary', () => {
  const task: SidebarTask = {
    id: 'task',
    title: 'Fix sync',
    status: 'running',
    createdAt: '2026-10-31T12:00:00',
  };
  assert.equal(taskState(task, []), 'running');
  assert.equal(
    taskState(task, [{ taskId: 'task', status: 'unknown', createdAt: task.createdAt }]),
    'stalled',
  );
  assert.equal(
    taskState(task, [
      { taskId: 'task', status: 'succeeded', createdAt: '2026-11-01T12:00:00' },
      { taskId: 'task', status: 'running', createdAt: task.createdAt },
    ]),
    'ready',
  );
  assert.equal(dayLabel(task.createdAt, new Date('2026-11-01T12:00:00')), 'Yesterday');
});
