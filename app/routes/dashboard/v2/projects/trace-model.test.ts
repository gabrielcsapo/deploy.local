import assert from 'node:assert/strict';
import test from 'node:test';
import { timeline, visibleRows, type TraceDetail } from './trace-model.ts';
test('keeps overlapping spans, out-of-order parents and their individual statuses', () => {
  const span = (
    spanId: string,
    start: number,
    end: number,
    parentSpanId: string | null,
    status: number,
  ) => ({
    spanId,
    parentSpanId,
    name: spanId,
    service: 'app',
    scope: 'test',
    startTimeUnixNano: String(start * 1e6),
    endTimeUnixNano: String(end * 1e6),
    status,
    attributes: {},
    events: [],
  });
  const data: TraceDetail = {
    truncated: false,
    spans: [span('b', 1, 8, 'a', 2), span('a', 0, 11, null, 0), span('c', 3, 10, 'a', 1)],
  };
  const model = timeline(data);
  assert.deepEqual(
    visibleRows(model, undefined, new Set()).map(({ row, depth }) => [row.id, depth, row.status]),
    [
      ['a', 0, 'Unset'],
      ['b', 1, 'Error'],
      ['c', 1, 'OK'],
    ],
  );
  assert.deepEqual(
    visibleRows(model, undefined, new Set(['a'])).map(({ row }) => row.id),
    ['a'],
  );
  assert.deepEqual(
    visibleRows(model, 'b', new Set()).map(({ row }) => row.id),
    ['b'],
  );
  assert.equal(timeline({ ...data, spans: data.spans.slice(0, 1) }).partial, true);
});
