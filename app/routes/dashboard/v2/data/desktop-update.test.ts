import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopUpdateIcon, DesktopUpdateRow } from '../DesktopUpdate';
import {
  changeDesktopUpdateNavigation,
  desktopUpdate,
  listenForUpdateDismissal,
  updateLabel,
  type DesktopUpdateApi,
  type DesktopUpdateStatus,
} from './desktop-update';
import { sidebarCollapsed, sidebarPreferenceKey } from './sidebar-preference';

const api: DesktopUpdateApi = {
  status: async () => ({ phase: 'idle' }),
  onChange: () => () => {},
  start: async () => {},
  cancel: async () => {},
  restart: async () => {},
};
const render = (status: DesktopUpdateStatus, open = false) =>
  renderToStaticMarkup(createElement(DesktopUpdateRow, { api, status, open, popoverId: 'update' }));

test('update row requires the desktop update capability, never a browser or worker API', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    for (const value of [
      {},
      { deployDesktop: { worker: {} } },
      { deployDesktop: { update: api } },
    ]) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value });
      const capability = desktopUpdate();
      const html = renderToStaticMarkup(
        createElement(DesktopUpdateRow, {
          api: capability,
          status: { phase: 'available', commit: '9c41e7f123' },
          open: true,
        }),
      );
      assert.equal(html.includes('Update available'), capability === api);
      assert.equal(html.includes('role="dialog"'), capability === api);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  assert.equal(render({ phase: 'idle' }, true), '');
});

test('each state has one compact button and no inline details when closed', () => {
  const labels: [DesktopUpdateStatus['phase'], string][] = [
    ['available', 'Update available'],
    ['downloading', 'Updating · 42%'],
    ['checking', 'Checking download…'],
    ['ready', 'Restart to update'],
    ['installing', 'Installing…'],
    ['failed', 'Update failed'],
  ];
  for (const [phase, label] of labels) {
    const status = { phase, percent: 42, commit: '9c41e7f123' };
    assert.equal(updateLabel(status), label);
    const html = render(status);
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.ok(html.includes(label));
    assert.match(html, /aria-expanded="false" aria-controls="update"/);
    assert.doesNotMatch(
      html,
      /role="dialog"|<progress|9c41e7f|<p>|Download update|Cancel|Later|Dismiss/,
    );
  }
  assert.equal(updateLabel({ phase: 'failed', error: 'verification' }), 'Update failed');
  assert.equal(updateLabel({ phase: 'idle' }), '');
});

test('open popover uses approved contents, stacked actions and actual download progress', () => {
  const available = render({ phase: 'available', commit: '9c41e7f123' }, true);
  assert.match(available, /aria-expanded="true" aria-controls="update"/);
  assert.match(
    available,
    /id="update"[^>]+role="dialog" aria-labelledby="update-heading" tabindex="-1"/,
  );
  assert.match(available, /id="update-heading"[^>]*>deploy.local for Mac/);
  assert.match(available, /9c41e7f<\/span>/);
  assert.match(available, /Downloads in the background. You choose when to restart./);
  assert.match(available, />Download update<\/button>/);
  const downloading = render(
    { phase: 'downloading', bytes: 54e6, total: 130e6, percent: 42 },
    true,
  );
  assert.match(downloading, /54 of 130 MB · 42%/);
  assert.match(downloading, /<progress value="54000000" max="130000000"/);
  assert.match(downloading, />Cancel<\/button>/);
  const ready = render({ phase: 'ready' }, true);
  assert.match(ready, /Download checked. Restart reopens this page./);
  assert.equal((ready.match(/>Restart to update<\/button>/g) ?? []).length, 1);
  assert.match(ready, />Later<\/button>/);
  for (const phase of ['checking', 'installing'] as const) {
    const html = render({ phase }, true);
    assert.match(html, /role="status"/);
    // The compact row still closes details, but the popover has no actions.
    assert.equal((html.match(/<button/g) ?? []).length, 1);
  }
  assert.match(render({ phase: 'installing' }, true), /Reopening this page in a moment./);
  assert.match(
    render({ phase: 'failed', error: 'verification' }, true),
    /The download did not match what deploy.local published; nothing was changed./,
  );
  const failed = render({ phase: 'failed', error: 'network' }, true);
  assert.match(failed, /The download stopped. Nothing was changed./);
  assert.match(failed, />Try again<\/button>/);
  assert.match(failed, />Dismiss<\/button>/);
});

test('rail always uses a download icon with only busy and failure marks', () => {
  for (const phase of [
    'available',
    'downloading',
    'checking',
    'ready',
    'installing',
    'failed',
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(DesktopUpdateIcon, { status: { phase }, rail: true }),
    );
    const marked = ['downloading', 'checking', 'installing', 'failed'].includes(phase);
    assert.equal((html.match(/<svg/g) ?? []).length, marked ? 2 : 1);
    assert.equal(html.includes('update-state-mark'), marked);
    assert.equal(html.includes('dl-del'), phase === 'failed');
  }
});

test('temporary expansion and every details close leave the remembered sidebar choice alone', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let saved = 'true';
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => (key === sidebarPreferenceKey ? saved : null),
      setItem: (key: string, value: string) => {
        assert.equal(key, sidebarPreferenceKey);
        writes.push(value);
        saved = value;
      },
    },
  });
  try {
    for (const collapsed of [true, false]) {
      saved = String(collapsed);
      let state = { collapsed: sidebarCollapsed(), updateOpen: false };
      for (const reason of ['row', 'Escape', 'outside click', 'Later', 'Dismiss']) {
        state = changeDesktopUpdateNavigation(state, 'open-update');
        assert.equal(state.collapsed && !state.updateOpen, false, reason);
        state = changeDesktopUpdateNavigation(state, 'close-update');
        assert.deepEqual(state, { collapsed, updateOpen: false }, reason);
        assert.equal(sidebarCollapsed(), collapsed, reason);
      }
    }
    assert.deepEqual(writes, []);
    let state = changeDesktopUpdateNavigation(
      { collapsed: true, updateOpen: true },
      'toggle-sidebar',
    );
    assert.deepEqual(state, { collapsed: true, updateOpen: false });
    assert.deepEqual(writes, []);
    state = changeDesktopUpdateNavigation(state, 'toggle-sidebar');
    assert.deepEqual(state, { collapsed: false, updateOpen: false });
    assert.deepEqual(writes, ['false']);
    state = changeDesktopUpdateNavigation({ ...state, updateOpen: true }, 'toggle-sidebar');
    assert.deepEqual(state, { collapsed: true, updateOpen: false });
    assert.deepEqual(writes, ['false', 'true']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('Escape and outside clicks dismiss; inside clicks and other keys do not; listeners clean up', () => {
  const doc = new EventTarget();
  const boundary = { ownerDocument: doc } as unknown as HTMLElement;
  let closes = 0;
  const stop = listenForUpdateDismissal(boundary, () => closes++);
  const click = (inside: boolean) => {
    const event = new Event('click');
    // A download action can replace its DOM node before the document hears the click.
    Object.defineProperty(event, 'composedPath', {
      value: () => (inside ? [boundary, doc] : [doc]),
    });
    doc.dispatchEvent(event);
  };
  const key = (value: string) => {
    const event = new Event('keydown', { cancelable: true });
    Object.defineProperty(event, 'key', { value });
    doc.dispatchEvent(event);
    return event.defaultPrevented;
  };
  click(true);
  assert.equal(key('Enter'), false);
  assert.equal(closes, 0);
  click(false);
  assert.equal(closes, 1);
  assert.equal(key('Escape'), true);
  assert.equal(closes, 2);
  stop();
  click(false);
  assert.equal(key('Escape'), false);
  assert.equal(closes, 2);
});
