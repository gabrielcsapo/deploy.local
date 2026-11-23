import test from 'node:test';
import assert from 'node:assert/strict';
import { electronProfile } from './electron.js';
import { setTimeout as wait } from 'node:timers/promises';

test('links actual IPC intervals, propagates errors, and honors unsampled parents', async () => {
  const spans = [];
  const profile = (process) =>
    electronProfile({
      service: 'test.' + process,
      process,
      send: (body) => spans.push(...body.resourceSpans[0].scopeSpans[0].spans),
    });
  const renderer = profile('renderer'),
    main = profile('main');
  const failure = new Error('private payload');
  await assert.rejects(
    renderer('worker.status', null, (parent) =>
      main('ipc.handle', parent, () => {
        throw failure;
      }),
    ),
    (e) => e === failure,
  );
  const off = '00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-00';
  assert.equal(await main('ignored', off, async (parent) => parent), off);
  await wait(350);
  const [child, root] = spans;
  assert.equal(spans.length, 2);
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(child.traceId, root.traceId);
  assert.equal(root.events[0].name, 'ipc.failed');
  assert.equal(root.status.code, 2);
  assert.ok(!JSON.stringify(spans).includes(failure.message));
});
