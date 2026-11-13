import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignCard, cardRegion } from './Review';

test('chat card keeps Review and Open in Design together', () => {
  const design = {
    api: '/api/card-test',
    proposal: {
      id: 'design:p:b:c',
      title: 'Welcome',
      kind: 'other',
      text: '',
      from: 'agent',
      createdAt: '2026-11-07T12:00:00Z',
      state: 'waiting',
      actions: [],
    },
  } as Parameters<typeof DesignCard>[0]['design'];
  const html = renderToStaticMarkup(
    createElement(DesignCard, { projectId: 'p', taskId: 't', design }),
  );
  assert.match(html, /Review<\/a><a class="dl-btn quiet"/);
  assert.match(html, /href="\/dashboard\/design\?review=design%3Ap%3Ab%3Ac"/);
});

test('chat crops keep the approved zoom even when a changed wrapper spans the screen', () => {
  const preview = {
    width: 1440,
    height: 900,
    areas: [{ before: { x: 240, y: 80, w: 1200, h: 820 }, after: null }],
    crop: { x: 0, y: 0, w: 1440, h: 900 },
  };
  const region = cardRegion(preview as Parameters<typeof cardRegion>[0], 'before');
  assert.equal(region.w, 1440 * 0.52);
  assert.ok(region.x >= 0 && region.y >= 0);
  assert.ok(region.x + region.w <= preview.width && region.y + region.h <= preview.height);
});

test('chat card uses the approved four-screen glyph', () => {
  const design = {
    api: '/api/card-glyph',
    proposal: {
      id: 'design:p:b:c',
      title: 'Welcome',
      kind: 'other',
      text: '',
      from: 'agent',
      createdAt: '2026-11-07T12:00:00Z',
      state: 'waiting',
      actions: [],
    },
  } as Parameters<typeof DesignCard>[0]['design'];
  const html = renderToStaticMarkup(
    createElement(DesignCard, { projectId: 'p', taskId: 't', design }),
  );
  assert.equal((html.match(/<rect /g) ?? []).length, 4);
});
