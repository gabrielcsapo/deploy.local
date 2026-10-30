import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PublicHeader, sourceUrl } from './header.client.tsx';
import { ChangelogPage } from './about/changelog-page.tsx';

const links = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map(([, href, label]) => [
    href,
    label
      .replace(/<[^>]*>/g, '|')
      .replace(/\|+/g, ' ')
      .trim(),
  ]);

test('the public header links home, every public page, the source and sign-in', () => {
  const html = renderToStaticMarkup(createElement(PublicHeader));
  assert.deepEqual(links(html), [
    ['/', 'd deploy.local'],
    ['/about', 'About'],
    ['/docs', 'Docs'],
    ['/changelog', 'Changelog'],
    [sourceUrl, 'Source'],
    ['/signin', 'Sign in'],
    // The phone menu carries the same links, with Source naming where it goes.
    ['/about', 'About'],
    ['/docs', 'Docs'],
    ['/changelog', 'Changelog'],
    [sourceUrl, 'Source GitHub'],
  ]);
  assert.doesNotMatch(html, /aria-current/);
  assert.match(html, /class="dl-btn secondary site-signin"/);
  // The menu starts closed and its button says so.
  assert.match(html, /aria-label="Menu" aria-expanded="false" aria-controls="([^"]+)"/);
  const id = html.match(/aria-controls="([^"]+)"/)![1];
  assert.match(
    html,
    new RegExp(`<nav id="${id}" class="dl-menu site-menu" aria-label="Site menu" hidden="">`),
  );
});

test('the current public page is marked in the header and the phone menu', () => {
  for (const current of ['about', 'docs', 'changelog'] as const) {
    const html = renderToStaticMarkup(createElement(PublicHeader, { current }));
    const marked = [...html.matchAll(/<a ([^>]*)aria-current="page"[^>]*>/g)].map(
      (match) => match[0].match(/href="([^"]+)"/)![1],
    );
    assert.deepEqual(marked, [`/${current}`, `/${current}`]);
    assert.match(html, new RegExp(`class="dl-menu-item on" aria-current="page"`));
  }
});

test('About, Changelog and Docs share the one public header', () => {
  const changelog = renderToStaticMarkup(createElement(ChangelogPage, { releases: [] }));
  assert.match(changelog, /<header class="site-header">/);
  assert.match(changelog, /<a href="\/changelog" aria-current="page">Changelog<\/a>/);
  const about = readFileSync(new URL('./about/page.tsx', import.meta.url), 'utf8');
  assert.match(about, /<PublicPage current="about">/);
  const docs = readFileSync(new URL('../docs/screen.client.tsx', import.meta.url), 'utf8');
  assert.match(docs, /<PublicHeader current="docs" wide \/>/);
  const home = readFileSync(new URL('./page.client.tsx', import.meta.url), 'utf8');
  assert.match(home, /<PublicHeader \/>/);
});
