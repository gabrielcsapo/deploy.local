import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { navigationHandoffScript } from './otlp.js';

function documentAt(storage, path, options = {}) {
  const scope = options.scope ?? 'owner';
  const origin = 'https://example.test';
  const timeOrigin = options.timeOrigin ?? 1200;
  const location = new URL(path, origin);
  const handlers = new Map();
  const events = {
    addEventListener: (name, callback) => handlers.set(name, callback),
    removeEventListener: (name) => handlers.delete(name),
  };
  const window = { ...events };
  window.top = window;
  const document = {
    ...events,
    currentScript: { dataset: { traceScope: scope, tracePaths: '/books' } },
    referrer: options.referrer ?? origin + '/',
  };
  class Element {
    closest() {
      return this;
    }
    hasAttribute() {
      return false;
    }
  }
  runInNewContext(navigationHandoffScript, {
    window,
    document,
    location,
    setTimeout,
    Element,
    URL,
    performance: {
      timeOrigin,
      now: () => options.now ?? 30,
      getEntriesByType: () => [{ type: options.type ?? 'navigate' }],
    },
    Date: { now: () => timeOrigin + 30 },
    sessionStorage: {
      getItem: (k) => storage.get(k) ?? null,
      removeItem: (k) => storage.delete(k),
      setItem: (k, v) => storage.set(k, v),
    },
  });
  return {
    click(destination, changes = {}) {
      const url = new URL(destination, origin);
      const event = {
        target: Object.assign(new Element(), { pathname: url.pathname, href: url.href }),
        button: 0,
        isTrusted: true,
        timeStamp: 25,
        ...changes,
      };
      handlers.get('click')?.(event);
      return event;
    },
    hide() {
      handlers.get('pagehide')?.();
    },
    take(active = scope) {
      return window[Symbol.for('interaction-tracing.navigation.start')]?.(active);
    },
  };
}

test('a document click is handed to the matching owner and destination once', () => {
  const storage = new Map();
  const from = documentAt(storage, '/', { timeOrigin: 1000 });
  from.click('/books');
  // WebKit can open the destination before changes made during pagehide become visible.
  assert.equal(storage.size, 1);
  const to = documentAt(storage, '/books');
  assert.equal(to.take(), -175);
  assert.equal(to.take(), undefined);
  assert.equal(storage.size, 0);
});

test('direct visits, reloads, history restores, account changes and stale clicks cannot resume', () => {
  for (const options of [
    { type: 'reload' },
    { type: 'back_forward' },
    { scope: 'other' },
    { referrer: '' },
    { now: 31000 },
    { timeOrigin: 900 },
  ]) {
    const storage = new Map();
    const source = documentAt(storage, '/', { timeOrigin: 1000 });
    source.click('/books');
    source.hide();
    assert.equal(documentAt(storage, '/books', options).take(), undefined);
    assert.equal(storage.size, 0);
  }
  const empty = new Map();
  assert.equal(documentAt(empty, '/books').take(), undefined);
  const source = documentAt(empty, '/', { timeOrigin: 1000 });
  source.click('/books');
  source.hide();
  assert.equal(documentAt(empty, '/elsewhere').take(), undefined);
  assert.equal(documentAt(empty, '/books').take(), undefined);
});

test('only an eligible browser navigation can persist a click', () => {
  for (const [path, changes] of [
    ['/books', { ctrlKey: true }],
    ['/books', { button: 1 }],
    ['/books', { isTrusted: false }],
    ['/other', {}],
    ['/books?q=private', {}],
    ['https://external.test/books', {}],
  ]) {
    const storage = new Map();
    const from = documentAt(storage, '/');
    from.click(path, changes);
    from.hide();
    assert.equal(storage.size, 0);
  }
  const storage = new Map();
  const from = documentAt(storage, '/');
  const intercepted = from.click('/books');
  intercepted.defaultPrevented = true;
  from.hide();
  assert.equal(storage.size, 0);
  from.click('/books');
  from.take('changed-owner');
  from.hide();
  assert.equal(storage.size, 0);
});

test('a router that cancels the default link later in dispatch clears the stored click', async () => {
  const storage = new Map();
  const from = documentAt(storage, '/');
  const click = from.click('/books');
  click.defaultPrevented = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(storage.size, 0);
});
