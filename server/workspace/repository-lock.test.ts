import test from 'node:test';
import assert from 'node:assert/strict';
import { keyedSlots } from './repository-lock.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test('slots run at most the limit per key, in arrival order, and other keys do not wait', async () => {
  const slots = keyedSlots(2);
  let running = 0;
  let most = 0;
  const order: number[] = [];
  const held = Array.from({ length: 8 }, (_, n) =>
    slots('busy', async () => {
      order.push(n);
      most = Math.max(most, ++running);
      await tick();
      running--;
    }),
  );
  let other = false;
  await slots('quiet', async () => {
    other = true;
  });
  assert.equal(other, true);
  assert.ok(running > 0, 'the other key finished while this one was still busy');
  await Promise.all(held);
  assert.equal(most, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('the bound holds when new work arrives just as a slot frees up', async () => {
  const slots = keyedSlots(1);
  let running = 0;
  let most = 0;
  const work = async () => {
    most = Math.max(most, ++running);
    await tick();
    running--;
  };
  const first = slots('key', work);
  const second = slots('key', work);
  // Runs right after the first finishes and before the second, which it must not overtake.
  await first;
  const third = slots('key', work);
  await Promise.all([second, third]);
  assert.equal(most, 1);
});

test('work that fails gives its slot to the next, and the caller gets the failure', async () => {
  const slots = keyedSlots(1);
  const failing = slots('key', async () => {
    await tick();
    throw Object.assign(new Error('Conflict'), { status: 409 });
  });
  const next = slots('key', async () => 'ran');
  await assert.rejects(failing, { message: 'Conflict', status: 409 });
  assert.equal(await next, 'ran');
});
