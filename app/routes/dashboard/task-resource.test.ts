import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskResource } from './task-resource.ts';

const tick = () => new Promise<void>((done) => setImmediate(done));
test('slow reads do not block callers and a burst coalesces into one trailing refresh', async () => {
  const reads: { resolve: (value: number) => void; signal: AbortSignal }[] = [];
  const values: number[] = [];
  const resource = new TaskResource<number>(
    (_task, signal) => new Promise((resolve) => reads.push({ resolve, signal })),
    (value) => values.push(value),
    (error) => assert.fail(String(error)),
  );
  resource.request('one');
  for (let i = 0; i < 100; i++) resource.request('one');
  assert.equal(reads.length, 1);
  reads[0].resolve(1);
  await tick();
  assert.deepEqual(values, [1]);
  assert.equal(reads.length, 2);
  reads[1].resolve(2);
  await tick();
  assert.deepEqual(values, [1, 2]);
  assert.equal(reads.length, 2);
});

test('switch and cancellation fence late results even when transport ignores abort', async () => {
  const reads: { resolve: (value: string) => void; signal: AbortSignal }[] = [];
  const values: string[] = [];
  const resource = new TaskResource<string>(
    (_task, signal) => new Promise((resolve) => reads.push({ resolve, signal })),
    (value) => values.push(value),
    (error) => assert.fail(String(error)),
  );
  resource.request('old');
  resource.request('old');
  resource.request('new');
  assert.equal(reads[0].signal.aborted, true);
  reads[0].resolve('stale');
  reads[1].resolve('current');
  await tick();
  assert.deepEqual(values, ['current']);
  assert.equal(reads.length, 2);
  resource.request('new');
  resource.cancel();
  reads[2].resolve('unmounted');
  await tick();
  assert.deepEqual(values, ['current']);
});

test('read errors are reported independently and a subsequent refresh recovers', async () => {
  const errors: unknown[] = [];
  const values: string[] = [];
  let attempts = 0;
  const resource = new TaskResource(
    async () => {
      if (++attempts === 1) throw new Error('Diff unavailable');
      return 'recovered';
    },
    (value) => values.push(value),
    (error) => errors.push(error),
  );
  resource.request('one');
  await tick();
  assert.equal(errors.length, 1);
  resource.request('one');
  await tick();
  assert.deepEqual(values, ['recovered']);
});
