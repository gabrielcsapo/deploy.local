import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignCard, cardRegion } from './Review';
import * as model from './review-model';

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

test('sent changes retain their notice in later review rounds', () => {
  assert.equal(model.changesNotice(2, 3, false, { actionId: 'changes' }), 'sent');
  assert.equal(model.changesNotice(1, 3, true), 'draft');
  assert.equal(model.changesNotice(2, 3, true), null);
  assert.equal(model.changesNotice(1, 3, false, { actionId: 'approve' }), null);
  assert.equal(model.changesNotice(1, 3, false, { actionId: 'update' }), null);
  assert.equal(model.changesNotice(1, 0, false, { actionId: 'changes' }), null);
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
