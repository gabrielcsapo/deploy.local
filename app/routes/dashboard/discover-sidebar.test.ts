import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { V2Sidebar } from './v2-layout.client';

const resource = { data: null, loading: false, error: false };
const data: ComponentProps<typeof V2Sidebar>['data'] = {
  packages: resource,
  workspace: resource,
  live: resource,
  user: resource,
  computers: resource,
  agents: resource,
  desktopUpdate: { api: undefined, status: { phase: 'idle' } },
  inbox: { items: [], loading: false, error: '', answer: async () => {}, retry() {} },
};
test('Discover selects Projects, matching the board sidebar place', () => {
  const board = readFileSync(
    new URL('../../../design/boards/Discover.html', import.meta.url),
    'utf8',
  );
  assert.match(board, /&quot;place&quot;:&quot;Projects&quot;/);
  for (const pathname of [
    '/dashboard/discover',
    '/dashboard/discover/import',
    '/dashboard/discover/immich',
    '/dashboard/projects/p1',
  ]) {
    const html = renderToStaticMarkup(createElement(V2Sidebar, { pathname, data }));
    const current = [...html.matchAll(/<a\b[^>]*aria-current="page"[^>]*>/g)];
    assert.equal(current.length, 1, pathname);
    assert.match(current[0][0], /href="\/dashboard\/projects"/);
    assert.match(current[0][0], /class="dl-nav on /);
  }
  const home = renderToStaticMarkup(createElement(V2Sidebar, { pathname: '/dashboard', data }));
  assert.match(home, /href="\/dashboard"[^>]*aria-current="page"/);
  const unrelated = renderToStaticMarkup(
    createElement(V2Sidebar, { pathname: '/dashboard/discovery', data }),
  );
  assert.doesNotMatch(unrelated, /aria-current="page"/);
});
