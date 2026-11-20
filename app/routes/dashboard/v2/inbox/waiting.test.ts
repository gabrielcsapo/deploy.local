import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import {
  contextLine,
  namedList,
  openItem,
  rowAction,
  shotRegion,
  waitingAge,
  waitingGroups,
  waitingHref,
  waitingKind,
} from './waiting.ts';

const now = new Date(2026, 10, 20, 15, 0);
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
const item = (id: string, kind: InboxItem['kind'], minutes: number, extra = {}): InboxItem => ({
  id,
  kind,
  title: id,
  text: '',
  from: 'warden',
  createdAt: ago(minutes),
  actions: [],
  state: 'waiting',
  ...extra,
});

test('Waiting on you groups by what you must do, in a fixed order, each group with its first item', () => {
  const items = [
    item('question:q', 'question', 40, { taskId: 't' }),
    item('design:forma:upload-history:1', 'other', 60),
    item('agent-run:researcher:x:today', 'other', 120),
    item('rollback:forma:r1', 'rollback', 17),
    item('design:deploy:diagnostics:2', 'other', 180),
    item('control:c', 'control', 5, { taskId: 't' }),
  ];
  const groups = waitingGroups(items);
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((entry) => entry.id)]),
    [
      ['Decide now', ['rollback:forma:r1']],
      ['Review designs', ['design:forma:upload-history:1', 'design:deploy:diagnostics:2']],
      ['Proposals', ['agent-run:researcher:x:today']],
      ['Answer', ['control:c', 'question:q']],
    ],
  );
  // A group appears with its first item: no heading over nothing.
  assert.deepEqual(
    waitingGroups([item('question:q', 'question', 1)]).map((group) => group.id),
    ['answer'],
  );
  assert.deepEqual(waitingGroups([]), []);
});

test('each kind gets its own mark, and a design build check counts as a design', () => {
  assert.equal(waitingKind(item('rollback:x', 'rollback', 1)), 'risk');
  assert.equal(waitingKind(item('merge:x', 'merge', 1)), 'risk');
  assert.equal(waitingKind(item('design:p:b:c', 'other', 1)), 'design');
  assert.equal(
    waitingKind(item('design-build:x', 'other', 1, { designCheck: { reviewId: 'r' } })),
    'design',
  );
  assert.equal(waitingKind(item('question:x', 'question', 1)), 'question');
  assert.equal(waitingKind(item('agent-run:x', 'other', 1)), 'proposal');
  assert.equal(rowAction(item('question:x', 'question', 1)), 'Answer');
  assert.equal(rowAction(item('design:p:b:c', 'other', 1)), 'Review');
});

test('a row says project · who asked · age, and a design adds its screens', () => {
  const design = item('design:forma:b:c', 'other', 60, { projectId: 'forma' });
  assert.equal(
    contextLine(design, {
      project: 'forma-id',
      who: 'An agent',
      review: {
        project: 'forma',
        proposer: { id: null, name: 'Gabriel', avatar: null },
        counts: { screens: 2, changed: 2, new: 0, removed: 0 },
      },
      now,
    }),
    'forma · Gabriel · 1 hour ago · 2 screens',
  );
  // Before its review summary arrives, the row still names what it knows.
  assert.equal(
    contextLine(design, { project: 'forma', who: 'Gabriel', now }),
    'forma · Gabriel · 1 hour ago',
  );
  assert.equal(
    contextLine(item('rollback:forma:r', 'rollback', 17), { project: 'forma', who: 'Warden', now }),
    'forma · Warden asked · 17 min ago',
  );
  assert.equal(
    contextLine(item('question:q', 'question', 40, { taskId: 't' }), {
      who: 'Release notes writer',
      now,
    }),
    'Release notes writer · in a task · 40 min ago',
  );
});

test('ages read in words, and long lists of names are summed up', () => {
  assert.equal(waitingAge(ago(0), now), 'just now');
  assert.equal(waitingAge(ago(1), now), '1 min ago');
  assert.equal(waitingAge(ago(180), now), '3 hours ago');
  assert.equal(waitingAge(new Date(2026, 10, 19, 9).toISOString(), now), 'Yesterday');
  assert.equal(waitingAge(new Date(2026, 10, 18, 22).toISOString(), now), '2 days ago');
  assert.equal(waitingAge('invalid', now), '');
  assert.equal(namedList(['Git']), 'Git');
  assert.equal(namedList(['Git', 'Logs']), 'Git and Logs');
  assert.equal(
    namedList([
      'Compute',
      'Diagnostics attention',
      'Git',
      'Logs',
      'Processes',
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
    ]),
    'Compute, Diagnostics attention, Git, Logs, Processes and 6 more',
  );
});

test('the open item is the one asked for, else the first row, never a Decide now card', () => {
  const groups = waitingGroups([
    item('rollback:forma:r', 'rollback', 1),
    item('design:a:b:c', 'other', 2),
    item('question:q', 'question', 3),
  ]);
  assert.equal(openItem(groups, null)?.id, 'design:a:b:c');
  assert.equal(openItem(groups, 'question:q')?.id, 'question:q');
  assert.equal(openItem(groups, 'missing')?.id, 'design:a:b:c');
  assert.equal(openItem(waitingGroups([item('rollback:x', 'rollback', 1)]), null), null);
  assert.equal(waitingHref({ id: 'design:a:b:c' }), '/dashboard/inbox?item=design%3Aa%3Ab%3Ac');
});

test('a shot shows the change near the screen’s own size, in the frame’s proportions', () => {
  const preview = { width: 1440, height: 900, crop: { x: 0, y: 0, w: 720, h: 520 } };
  const small = shotRegion(
    { ...preview, areas: [{ before: null, after: { x: 600, y: 300, w: 100, h: 40 } }] as never },
    'after',
  );
  // A small change still shows about 400 px of screen around it, centred on it.
  assert.deepEqual(small, { x: 450, y: 195, w: 400, h: 250 });
  // A wide change keeps all of itself; the crop never leaves the screen.
  const wide = shotRegion(
    { ...preview, areas: [{ before: { x: 0, y: 800, w: 1400, h: 100 }, after: null }] as never },
    'before',
  );
  assert.equal(wide.w, 1440);
  assert.equal(wide.y + wide.h <= 900, true);
  // Without a change area, the preview's own crop is used.
  assert.deepEqual(shotRegion({ ...preview, areas: [] }, 'after'), {
    x: 0,
    y: 0,
    w: 832,
    h: 520,
  });
});
