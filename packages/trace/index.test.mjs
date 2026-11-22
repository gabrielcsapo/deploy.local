import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startTrace } from './index.js';
import { parseRouteTiming, validateBrowserBatch } from '../../server/telemetry.ts';

test('nested concurrent operations retain their caller and failure through both transports', async () => {
  const trace = startTrace();
  const req = 'abc12345'.repeat(4);
  const child = startTrace(trace.traceparent);
  await child.span('catalog', async (root) => {
    const failure = Error('private query');
    await Promise.all([
      root.span('sql.read', () => 1),
      assert.rejects(
        root.span('image.decode', () => {
          throw failure;
        }),
        (err) => err === failure,
      ),
    ]);
  });
  const spans = parseRouteTiming(child.serverTiming()).spans;
  assert.equal(spans.length, 3);
  const [catalog, sql, image] = spans;
  assert.equal(sql.parentSpanId, catalog.spanId);
  assert.equal(image.parentSpanId, catalog.spanId);
  assert.equal(image.failed, true);
  assert.equal(catalog.parentSpanId, trace.traceparent.split('-')[2]);
  const event = child.clientEvent(req, '/photos/:id');
  assert.deepEqual(event.spans, spans);
  assert.equal(child.traceId, trace.traceId);
  assert.doesNotThrow(() => validateBrowserBatch({ v: 1, build: null, events: [event] }));
  assert.throws(() =>
    validateBrowserBatch({
      v: 1,
      build: null,
      events: [{ ...event, spans: [{ ...sql, query: 'private' }] }],
    }),
  );
  assert.ok(!child.serverTiming().includes('private'));
});
