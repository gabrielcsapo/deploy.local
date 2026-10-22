import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { ListRow, PropertyRow } from './ListPage.tsx';
import { IconLink } from './IconButton.tsx';

test('resource navigation spans the row with sibling hover utilities and Delete inside overflow', () => {
  const html = renderToStaticMarkup(
    createElement(ListRow, {
      to: '/dashboard/test',
      icon: 'grid',
      title: 'Test application',
      secondary: 'https://test.local',
      actions: createElement(IconLink, {
        icon: 'external',
        label: 'Open application',
        href: 'https://test.local',
      }),
      menu: createElement('button', { 'data-dismiss-menu': true }, 'Delete'),
    }),
  );
  assert.match(html, /class="ui-list-link"[^>]*>/);
  assert.match(html, /href="\/dashboard\/test"/);
  assert.match(html, /aria-label="Actions for Test application"/);
  assert.match(html, /popover="auto"[^>]*><button[^>]*>Delete<\/button>/);
  assert.doesNotMatch(html, /<a[^>]*>(?:(?!<\/a>).)*<button/);
  const css = readFileSync(new URL('./ui.css', import.meta.url), 'utf8');
  assert.match(css, /\.ui-list-row:hover \.ui-list-actions/);
  assert.match(css, /\.ui-list-row:focus-within \.ui-list-actions/);
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\)/);
  assert.match(css, /min-height: var\(--ds-size-resourceRow\)/);
});

test('property rows retain a real labeled control', () => {
  const html = renderToStaticMarkup(
    createElement(PropertyRow, {
      label: 'Schedule',
      // eslint-disable-next-line react/no-children-prop -- createElement supplies the required child in this non-JSX test.
      children: createElement('input', { 'aria-label': 'Schedule', defaultValue: 'daily' }),
    }),
  );
  assert.match(html, /ui-property-label/);
  assert.match(html, /aria-label="Schedule"/);
  assert.doesNotMatch(html, /<table/);
});
