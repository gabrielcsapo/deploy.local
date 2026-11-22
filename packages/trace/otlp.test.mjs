import test from 'node:test';
import assert from 'node:assert/strict';
import { exportInteractions, routeFamily, observeWebFlows } from './otlp.js';
import { interactionTracer } from './interaction.js';
import { setImmediate } from 'node:timers/promises';
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

test('departing documents export the propagated fetch IDs, including writes started after pagehide', async (t) => {
  const origin = 'https://example.test';
  const browser = new EventTarget();
  const sends = [];
  browser.fetch = (_input, init) =>
    new Promise((resolve) => {
      sends.push({ parent: init.headers.get('traceparent'), resolve });
    });
  globalThis.window = browser;
  globalThis.location = new URL(origin);
  const batches = [];
  const tracer = interactionTracer({
    scope: 'owner',
    origin,
    sendBatch: async (events, keepalive) => {
      batches.push({ events, keepalive });
      return true;
    },
  });
  const stop = observeWebFlows(tracer, () => 'http.post.progress');
  t.after(() => {
    stop();
    tracer.close();
    delete globalThis.window;
    delete globalThis.location;
  });
  const first = browser.fetch('/api/progress');
  browser.dispatchEvent(new Event('pagehide'));
  const last = browser.fetch('/api/progress');
  await setImmediate();
  const exiting = batches.flatMap((batch) => batch.events);
  assert.equal(exiting.length, 2);
  assert.ok(batches.every((batch) => batch.keepalive));
  for (const [i, event] of exiting.entries()) {
    assert.equal(event.milestone, 'page.left');
    assert.equal('00-' + event.traceId + '-' + event.spans[0].spanId + '-01', sends[i].parent);
    assert.equal(event.spans[0].statusCode, undefined);
  }
  browser.dispatchEvent(new Event('pageshow'));
  const restored = browser.fetch('/api/progress');
  for (const send of sends) send.resolve(new Response());
  await Promise.all([first, last, restored]);
  await tracer.flush();
  assert.equal(batches.at(-1).events[0].milestone, 'response.headers');
  assert.equal(batches.flatMap((batch) => batch.events).length, 3);
});
