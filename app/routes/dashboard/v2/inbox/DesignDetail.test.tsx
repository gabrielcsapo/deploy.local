import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  DesignReviewScreen,
  DesignReviewSummary,
  InboxItem,
} from '../../../../../shared/v2/contracts';
import { InboxProvider } from '../data/hooks';
import { DesignDetail, ShotPair } from './DesignDetail';

const screen = {
  file: 'Computer.html',
  title: 'Computer',
  w: 1440,
  h: 900,
  widths: [1440, 700],
  status: 'changed',
  added: false,
  removed: false,
} as unknown as DesignReviewScreen;

// Live on SER: Before showed the whole Computers screen while After zoomed into one element.
test('Before and After draw the same rectangle of the screen, each with the change outlined', () => {
  const html = renderToStaticMarkup(
    <ShotPair
      screen={screen}
      preview={{
        width: 1440,
        height: 900,
        before: '/before.png',
        after: '/after.png',
        beforeSrc: '/before.png',
        afterSrc: '/after.png',
        complete: true,
        // A new element: main has nothing there.
        areas: [{ before: null, after: { x: 600, y: 300, w: 100, h: 40 } }] as never,
        crop: { x: 552, y: 252, w: 196, h: 136 },
      }}
    />,
  );
  const boxes = [...html.matchAll(/viewBox="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(boxes, ['450 195 400 250', '450 195 400 250']);
  assert.equal((html.match(/class="v2-asks-change"/g) ?? []).length, 2);
  // The complete crop fits the frame; nothing is cut by a cover zoom.
  assert.doesNotMatch(html, /slice/);
  assert.match(html, /Before · main<\/figcaption>.*After<\/figcaption>/);
});

test('a design from a task names "A task" and links it, under the proposal’s own title', () => {
  const item = {
    id: 'design:drop:design~baseline:abc',
    kind: 'other',
    title: 'Baseline',
    text: '',
    from: 'gabriel',
    projectId: 'drop',
    taskId: 'task-drop',
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    state: 'waiting',
    actions: [{ id: 'approve', label: 'Approve design', primary: true }],
  } as InboxItem;
  const summary = {
    id: item.id,
    title: 'Drop: a baseline of the pages shipped today',
    summary: null,
    projectId: 'drop',
    project: 'drop',
    branch: 'design/baseline',
    createdAt: item.createdAt,
    proposer: { id: null, name: 'A task', avatar: null },
    counts: { screens: 14, changed: 14, new: 0, removed: 0 },
    stale: false,
    conflicts: [],
  } as DesignReviewSummary;
  const html = renderToStaticMarkup(
    <InboxProvider>
      <DesignDetail item={item} summary={summary} who="Gabriel" now={Date.now()} />
    </InboxProvider>,
  );
  assert.match(html, /<h2 class="dl-title">Drop: a baseline of the pages shipped today<\/h2>/);
  assert.match(
    html,
    /<span class="dl-meta">drop · <a href="\/dashboard\/tasks\/task-drop">A task<\/a> · 1 min ago · 14 screens<\/span>/,
  );
});
