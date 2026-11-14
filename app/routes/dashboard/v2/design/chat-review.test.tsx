import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxProvider, remember } from '../data/hooks';
import type { DesignReview } from '../../../../../shared/v2/contracts';
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

test('approved proposal card offers Build only after landing, then links the recorded builder', () => {
  const item = {
    id: 'design:chat:branch:commit',
    title: 'Welcome',
    state: 'answered',
    answer: { actionId: 'approve', at: '2026-11-12T12:00:00Z', by: 'owner', on: 'web' },
  } as DesignReview['item'];
  const api = '/api/chat-approved';
  const review = {
    id: item.id,
    item,
    boards: [],
    groups: [],
    proposerTaskId: 'proposer',
    proposer: { id: 'designer', name: 'Designer', avatar: null },
    landing: { at: '2026-11-12T12:00:30Z', state: 'landed', commit: '4f05991abcdef' },
  } as unknown as DesignReview;
  const render = (data: DesignReview) => {
    remember(`${api}/review?item=${encodeURIComponent(item.id)}&evidence=text`, data);
    return renderToStaticMarkup(
      createElement(
        InboxProvider,
        null,
        createElement(DesignCard, {
          projectId: 'chat',
          taskId: 'proposer',
          design: { api, proposal: item },
        }),
      ),
    );
  };
  const ready = render(review);
  assert.match(ready, /Approved · on main as 4f05991 · not built yet/);
  assert.match(ready, />Build<\/button>/);
  assert.doesNotMatch(ready, /Where to build|starts building|is building it/);
  assert.doesNotMatch(
    render({ ...review, landing: { ...review.landing!, state: 'pending' } }),
    />Build</,
  );
  const building = render({
    ...review,
    landing: { ...review.landing!, build: { at: '', taskId: 'builder', name: 'Designer' } },
  });
  assert.doesNotMatch(building, />Build</);
  assert.match(building, /href="\/dashboard\/tasks\/builder">Designer is building it<\/a>/);
});
