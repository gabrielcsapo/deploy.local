import test from 'node:test';
import assert from 'node:assert/strict';
import { exportInteractions, routeFamily } from './otlp.js';
import { startHttpSpan } from './http.js';
test('exports a client and linked server span with safe route names and HTTP status', () => {
  const event = {
    traceId: '1'.repeat(32),
    spanId: '2'.repeat(16),
    name: 'details.open',
    milestone: 'response.headers',
    outcome: 'error',
    startedAtUnixMs: 1000,
    durationMs: 10,
    spans: [
      {
        name: 'http.fetch',
        spanId: '3'.repeat(16),
        parentSpanId: '2'.repeat(16),
        startMs: 1,
        durationMs: 7,
        failed: true,
        statusCode: 502,
      },
    ],
  };
  const [root, child] = exportInteractions([event], 'example.web').resourceSpans[0].scopeSpans[0]
    .spans;
  const server = startHttpSpan('00-' + event.traceId + '-' + child.spanId + '-01')(
    'GET',
    '/items/:id',
    502,
  );
  assert.equal(server.parentSpanId, child.spanId);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(root.endTimeUnixNano, '1010000000');
  assert.equal(child.status.code, 2);
  assert.equal(child.attributes[0].value.intValue, '502');
  assert.equal(startHttpSpan('00-' + event.traceId + '-' + child.spanId + '-00'), undefined);
  assert.equal(routeFamily('/api/secret?token=value', '/api/', ['items']), 'other');
});
