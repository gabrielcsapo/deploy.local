import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { routes } from '../../../routes.ts';
test('public routes and recovery boundaries point to the implemented modules', () => {
  const root = routes[0];
  const about = root.children?.find((route) => route.path === 'about');
  const changelog = root.children?.find((route) => route.path === 'changelog');
  assert.ok(about);
  assert.ok(changelog);
  assert.match(String(about.component), /routes\/home\.js/);
  assert.match(String(changelog.component), /routes\/changelog\.js/);
  assert.match(String(root.notFound), /not-found/);
  const notFound = readFileSync(new URL('../../not-found.tsx', import.meta.url), 'utf8');
  assert.match(notFound, /ui\/v2\/Empty/);
  assert.match(notFound, /href="\/dashboard"/);
  assert.match(notFound, /href="\/dashboard\/live"/);
});
