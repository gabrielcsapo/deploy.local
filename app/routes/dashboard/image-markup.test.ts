import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changeMarks,
  emptyMarks,
  undoMarks,
  redoMarks,
  serializeMarks,
  flattenSize,
  type MarkShape,
} from './image-markup.ts';
const shape: MarkShape = {
  tool: 'arrow',
  points: [
    { x: 0.1, y: 0.2 },
    { x: 0.8, y: 0.9 },
  ],
  width: 4,
  color: 'accent',
};
test('add, clear, undo, redo and branching preserve document snapshots', () => {
  const initial = emptyMarks();
  const added = changeMarks(initial, [shape]);
  assert.deepEqual(redoMarks(undoMarks(added)).shapes, [shape]);
  const cleared = changeMarks(added, []);
  assert.deepEqual(undoMarks(cleared).shapes, [shape]);
  assert.deepEqual(changeMarks(undoMarks(cleared), [shape, shape]).redo, []);
  assert.deepEqual(initial.shapes, []);
  shape.points[0].x = 0.3;
  assert.equal(added.shapes[0].points[0].x, 0.1);
});
test('serialization excludes hit targets and transient selection', () => {
  const parsed = JSON.parse(
    serializeMarks([{ ...shape, selected: true, hitTarget: 'canvas' } as MarkShape]),
  );
  assert.deepEqual(Object.keys(parsed[0]).sort(), ['color', 'points', 'tool', 'width']);
  assert.deepEqual(parsed[0].points, shape.points);
});
test('flatten preserves native pixels independent of viewport or device scale', () => {
  assert.deepEqual(flattenSize(4032, 3024), { width: 4032, height: 3024 });
  assert.deepEqual(flattenSize(17, 91), { width: 17, height: 91 });
  for (const [w, h] of [
    [0, 1],
    [1, -1],
    [1.5, 2],
    [NaN, 1],
  ])
    assert.throws(() => flattenSize(w, h));
});
