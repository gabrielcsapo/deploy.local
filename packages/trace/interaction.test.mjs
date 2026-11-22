import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { interactionTracer } from './interaction.js';

test('one terminal event, two independent requests, retry after reload', async () => {
  const map = new Map();
  const storage = {
    getItem: (key) => map.get(key),
    setItem: (key, v) => map.set(key, v),
    removeItem: (key) => map.delete(key),
  };
  const base = { origin: 'https://example.test', scope: 'test-user', storage };
  const first = interactionTracer({ ...base, send: async () => false });
  const open = first.start('detail.open');
  const headers = [];
  const request = async (_url, init) => {
    headers.push(new Headers(init.headers).get('traceparent'));
    return new Response();
  };
  await Promise.all(['/a', '/b'].map((path) => open.fetch(path, {}, request)));
  await open.fetch('https://outside.test/a', {}, request);
  await open.fetch('/other', { headers: { traceparent: 'existing' } }, request);
  await assert.rejects(
    open.span('detail.decode', async () => {
      throw Error('fixture');
    }),
  );
  open.finish('navigation.left', 'cancelled');
  open.finish('details.visible');
  await setImmediate();
  first.close(false);
  const sent = [];
  const next = interactionTracer({
    ...base,
    send: async (event) => {
      sent.push(event);
      return true;
    },
  });
  await next.flush();
  assert.equal(sent.length, 1);
  const [event] = sent;
  assert.equal(event.outcome, 'cancelled');
  assert.equal(event.traceId, open.traceId);
  assert.equal(event.spans.length, 3);
  assert.ok(event.spans.every((s) => s.parentSpanId === event.spanId));
  assert.deepEqual(
    headers.slice(0, 2),
    event.spans.slice(0, 2).map((s) => '00-' + event.traceId + '-' + s.spanId + '-01'),
  );
  assert.deepEqual(headers.slice(2), [null, 'existing']);
  assert.equal(event.spans[2].failed, true);
  assert.equal(map.size, 0);
});

test('a presented frame uses the compositor timestamp even if its callback runs later', async () => {
  let event;
  const tracer = interactionTracer({
    scope: 'test',
    send: async (value) => {
      event = value;
      return true;
    },
  });
  const tap = performance.now() - 100;
  tracer.start('video.play', tap).finish('first.frame', 'ok', tap + 35);
  await setImmediate();
  assert.equal(event.durationMs, 35);
  tracer.close();
});
