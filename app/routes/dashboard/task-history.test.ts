import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskHistory, taskHistoryShortcut } from './task-history.ts';

test('select pushes real history entries, back/forward restore them, and a branch truncates forward history', () => {
  const entries = [
    { url: '/dashboard?task=a', state: { key: 'router-key' } as Record<string, unknown> },
  ];
  let at = 0;
  let pushes = 0;
  const browser = {
    get state() {
      return entries[at].state;
    },
    replaceState(state: Record<string, unknown>) {
      entries[at].state = state;
    },
    back() {
      at--;
    },
    forward() {
      at++;
    },
  };
  const history = new TaskHistory(browser);
  const navigate = (url: string) => {
    entries.splice(++at);
    entries.push({ url, state: { key: `router-${++pushes}` } });
  };
  assert.equal(history.canBack, false);
  assert.equal(history.canForward, false);
  history.select('/dashboard?task=b', entries[at].url, navigate);
  assert.equal(pushes, 1);
  assert.equal(browser.state.key, 'router-1');
  history.select('/dashboard?task=b', entries[at].url, navigate);
  assert.equal(pushes, 1);
  history.select('/dashboard?task=c', entries[at].url, navigate);
  history.go(-1);
  history.pop();
  assert.equal(entries[at].url, '/dashboard?task=b');
  assert.equal(history.canBack, true);
  assert.equal(history.canForward, true);
  history.go(1);
  history.pop();
  assert.equal(entries[at].url, '/dashboard?task=c');
  history.go(-1);
  history.pop();
  history.select('/dashboard?task=d', entries[at].url, navigate);
  assert.equal(history.canForward, false);
  assert.deepEqual(
    entries.map((entry) => entry.url),
    ['/dashboard?task=a', '/dashboard?task=b', '/dashboard?task=d'],
  );
});

test('history shortcuts work outside editors and leave typing, composition and other shortcuts alone', () => {
  const base = { metaKey: false, altKey: false, ctrlKey: false, shiftKey: false };
  for (const [key, modifier, direction] of [
    ['[', 'metaKey', -1],
    [']', 'metaKey', 1],
    ['ArrowLeft', 'altKey', -1],
    ['ArrowRight', 'altKey', 1],
  ] as const) {
    const event = { ...base, key, [modifier]: true };
    assert.equal(taskHistoryShortcut(event, false), direction);
    assert.equal(taskHistoryShortcut(event, true), null);
    assert.equal(taskHistoryShortcut({ ...event, isComposing: true }, false), null);
    assert.equal(taskHistoryShortcut({ ...event, shiftKey: true }, false), null);
    assert.equal(taskHistoryShortcut({ ...event, defaultPrevented: true }, false), null);
  }
  assert.equal(taskHistoryShortcut({ ...base, key: 'ArrowLeft' }, false), null);
  assert.equal(taskHistoryShortcut({ ...base, key: '[', ctrlKey: true }, false), null);
});
