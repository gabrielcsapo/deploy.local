import assert from 'node:assert/strict';
import test from 'node:test';
import { inAppPath } from './links.ts';

const origin = 'https://deploy.local';
const click = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};
const link = (href: string, attributes: Record<string, string> = {}) => ({
  href: new URL(href, origin).href,
  target: attributes.target ?? '',
  hasAttribute: (name: string) => name in attributes,
  getAttribute: (name: string) => attributes[name] ?? null,
});

test('a plain click on a dashboard link stays in the page, with its query and hash', () => {
  assert.equal(
    inAppPath(link('/dashboard/projects/p1/code'), click, origin),
    '/dashboard/projects/p1/code',
  );
  assert.equal(
    inAppPath(link('/dashboard/projects/p1?tab=apps#x'), click, origin),
    '/dashboard/projects/p1?tab=apps#x',
  );
});

test('the browser follows links elsewhere, downloads, new tabs and modified clicks', () => {
  assert.equal(inAppPath(link('https://example.com/dashboard'), click, origin), null);
  assert.equal(inAppPath(link('/api/export'), click, origin), null);
  assert.equal(inAppPath(link('/docs'), click, origin), null);
  assert.equal(inAppPath(link('/dashboard/logs', { download: '' }), click, origin), null);
  assert.equal(inAppPath(link('/dashboard/live', { target: '_blank' }), click, origin), null);
  assert.equal(inAppPath(link('/dashboard/live', { 'data-reload': '' }), click, origin), null);
  assert.equal(inAppPath(link('/dashboard/live'), { ...click, metaKey: true }, origin), null);
  assert.equal(inAppPath(link('/dashboard/live'), { ...click, button: 1 }, origin), null);
  assert.equal(
    inAppPath(link('/dashboard/live'), { ...click, defaultPrevented: true }, origin),
    null,
  );
});
