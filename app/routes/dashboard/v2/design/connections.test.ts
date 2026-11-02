import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardConnections, connectionCurve, connectionPairs } from './connections';
import type { Canvas, DesignLink } from './model';

const link = (from: string, to: string, layer: string, sidebar = false): DesignLink => ({
  from,
  to,
  layer,
  sidebar,
  text: layer,
});
const links = [
  link('A', 'B', 'first'),
  link('A', 'B', 'second'),
  link('B', 'A', 'back'),
  link('B', 'C', 'other-page'),
  link('C', 'A', 'outside'),
  link('C', 'A', 'outside-two'),
  link('A', 'C', 'sidebar', true),
  link('A', 'A', 'self'),
  link('A', 'Missing', 'missing'),
];

test('one directed arrow per pair, excluding self, sidebar and other pages', () => {
  assert.deepEqual(connectionPairs(links, ['A', 'B'], false, null), [
    { from: 'A', to: 'B', highlighted: false },
    { from: 'B', to: 'A', highlighted: false },
  ]);
  assert.equal(connectionPairs(links, ['A', 'B', 'C'], true, null).length, 5);
});

test('board selection highlights incoming and outgoing; layer selection only its own link', () => {
  assert.ok(
    connectionPairs(links, ['A', 'B'], false, { board: 'A', layer: null }).every(
      (pair) => pair.highlighted,
    ),
  );
  const pairs = connectionPairs(links, ['A', 'B', 'C'], false, { board: 'A', layer: 'second' });
  assert.deepEqual(
    pairs.filter((pair) => pair.highlighted),
    [{ from: 'A', to: 'B', highlighted: true }],
  );
  assert.equal(
    connectionPairs(links, ['A', 'B', 'C'], false, { board: 'A', layer: 'sidebar' }).filter(
      (pair) => pair.highlighted,
    ).length,
    0,
  );
  assert.equal(
    connectionPairs(links, ['A', 'B', 'C'], true, { board: 'A', layer: 'sidebar' }).filter(
      (pair) => pair.highlighted,
    ).length,
    1,
  );
});

const canvas: Canvas = {
  boards: {
    A: { x: 0, y: 10, w: 100, h: 100 },
    B: { x: 200, y: 10, w: 100, h: 100 },
    C: { x: 0, y: 1010, w: 100, h: 100 },
  },
  notes: {
    'section-one': { x: 0, y: 0, text: 'First page' },
    'section-two': { x: 0, y: 1000, text: 'Second page' },
  },
};
const section = { id: 'section-one', title: 'First page', x: 0, y: 0, boards: ['A', 'B'] };

test('panel groups other pages, preserves layer labels and counts incoming layers per board', () => {
  const result = boardConnections(canvas, section, 'A', links, false);
  assert.equal(result.leadsTo, 2);
  assert.equal(result.comesFrom, 2);
  assert.equal(result.sidebar, 1);
  assert.equal(result.outgoing[0].page?.title, 'First page');
  assert.deepEqual(
    result.outgoing[0].items.map((item) => item.layer),
    ['first', 'second'],
  );
  assert.equal(result.outgoing[1].page, null); // Missing targets stay visible as unavailable links.
  assert.equal(result.incoming[1].page?.title, 'Second page');
  assert.deepEqual(result.incoming[1].items, [{ from: 'C', layers: 2 }]);
  assert.equal(boardConnections(canvas, section, 'A', links, true).leadsTo, 3);
});

test('incoming counts deduplicate a repeated layer and empty boards have no connections', () => {
  const result = boardConnections(canvas, section, 'A', [...links, links[4]], false);
  assert.deepEqual(result.incoming[1].items, [{ from: 'C', layers: 2 }]);
  const empty = boardConnections(canvas, section, 'Unknown', links, false);
  assert.equal(empty.leadsTo, 0);
  assert.equal(empty.comesFrom, 0);
});

test('arrows leave the facing edge for horizontal and vertical board arrangements', () => {
  const from = { x: 0, y: 0, w: 100, h: 100 };
  const right = connectionCurve(from, { ...from, x: 300 }, 1);
  assert.deepEqual([right.x, right.y], [103, 50]);
  assert.ok(right.path.endsWith(', 296 50'));
  const below = connectionCurve(from, { ...from, y: 300 }, 1);
  assert.deepEqual([below.x, below.y], [50, 103]);
  assert.ok(below.path.endsWith(', 50 296'));
  const above = connectionCurve(from, { ...from, y: -300 }, 0.5);
  assert.deepEqual([above.x, above.y], [50, -6]);
  assert.ok(above.path.endsWith(', 50 -192'));
});
