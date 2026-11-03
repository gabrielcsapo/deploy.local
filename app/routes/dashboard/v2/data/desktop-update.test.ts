import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopUpdateRow } from '../DesktopUpdate';
import { desktopUpdate, type DesktopUpdateApi, type DesktopUpdateStatus } from './desktop-update';

const api: DesktopUpdateApi = {
  status: async () => ({ phase: 'idle' }),
  onChange: () => () => {},
  start: async () => {},
  cancel: async () => {},
  restart: async () => {},
};
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
        }),
      );
      assert.equal(html.includes('Update available'), capability === api);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
  assert.equal(
    renderToStaticMarkup(createElement(DesktopUpdateRow, { api, status: { phase: 'idle' } })),
    '',
  );
});
test('approved copy, actual progress, and one restart action', () => {
  const render = (status: DesktopUpdateStatus) =>
    renderToStaticMarkup(createElement(DesktopUpdateRow, { api, status }));
  const downloading = render({ phase: 'downloading', bytes: 54e6, total: 130e6, percent: 42 });
  assert.match(downloading, /Downloading update · 42%/);
  assert.match(downloading, /54 of 130 MB/);
  assert.match(downloading, /Cancel/);
  assert.match(render({ phase: 'checking' }), /Checking download…/);
  assert.match(render({ phase: 'ready' }), /Download checked. Reopens this page./);
  assert.doesNotMatch(render({ phase: 'installing' }), /<button/);
  assert.match(
    render({ phase: 'failed', error: 'verification' }),
    /The download did not match what deploy.local published; nothing was changed./,
  );
  assert.match(
    render({ phase: 'failed', error: 'network' }),
    /The download stopped. Nothing was changed./,
  );
});
