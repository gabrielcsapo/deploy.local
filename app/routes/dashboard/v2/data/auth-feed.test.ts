import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';

test('shared authentication reports 401s for Live/computers, and one storage reset clears caches and restarts the feed', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const browser = Object.assign(new EventTarget(), { location: { pathname: '/dashboard/live' } });
  let auth = { username: 'first', token: 'first-token' };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: () => JSON.stringify(auth) },
  });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  });
  let expired = 0;
  browser.addEventListener('deploy:session-expired', () => expired++);
  const { authenticatedFetch, eventFeed, remember, remembered, onAuthReset } =
    await import('./hooks.tsx');
  const { liveRequest } = await import('../live/data.ts');
  const { computerRequest } = await import('../computers/data.ts');
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('x-deploy-username'), auth.username);
    assert.equal(new Headers(init?.headers).get('x-deploy-token'), auth.token);
    assert.equal(init?.credentials, 'same-origin');
    const response = Response.json({ error: 'expired' }, { status: 401 });
    Object.defineProperty(response, 'url', { value: `http://test${url}` });
    return response;
  });
  await assert.rejects(liveRequest('/live'), /Sign in again to see Live/);
  await assert.rejects(computerRequest('/computers'), /Sign in again to see your computers/);
  assert.equal(expired, 2);
  await authenticatedFetch('/api/v2/auth/account');
  assert.equal(expired, 2);
  const cancelled = new AbortController();
  cancelled.abort();
  await authenticatedFetch('/api/v2/live', { signal: cancelled.signal });
  assert.equal(expired, 2, 'a late 401 from an aborted old session cannot expire the new session');

  const polls: { signal: AbortSignal; username: string }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('after=latest'))
      return Response.json({ cursor: auth.username === 'first' ? 1 : 20, events: [] });
    const signal = init!.signal!;
    polls.push({ signal, username: new Headers(init?.headers).get('x-deploy-username')! });
    return new Promise<Response>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
  });
  let resets = 0,
    otherResets = 0,
    snapshots = 0;
  const off = eventFeed.subscribe({
    snapshot: async () => {
      snapshots++;
    },
    events() {},
    error: assert.fail,
    reset() {
      resets++;
    },
  });
  const offReset = onAuthReset(() => otherResets++);
  t.after(() => {
    off();
    offReset();
  });
  await setImmediate();
  remember('/private', 'first-account');
  const storage = (key: string | null) =>
    browser.dispatchEvent(Object.assign(new Event('storage'), { key }));
  storage('unrelated');
  assert.equal(resets, 0);
  auth = { username: 'second', token: 'second-token' };
  storage('deploy-sh-auth');
  await setImmediate();
  assert.equal(remembered('/private'), undefined);
  assert.equal(polls[0].signal.aborted, true);
  assert.equal(polls[1].username, 'second');
  assert.equal(resets, 1);
  assert.equal(otherResets, 1);
  assert.equal(snapshots, 2);
  storage(null);
  await setImmediate();
  assert.equal(resets, 2);
  assert.equal(otherResets, 2);
  off();
  offReset();
  await setImmediate();
  assert.equal(polls.at(-1)!.signal.aborted, true);
});
