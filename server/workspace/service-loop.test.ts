import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServiceLoop } from './service-loop.ts';

test('the heartbeat keeps ticking while a pass is still running, and passes never overlap', async () => {
  let beats = 0;
  let running = 0;
  let overlapped = false;
  let passes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const loop = startServiceLoop({
    intervalMs: 10,
    beat: () => beats++,
    pass: async () => {
      if (running++) overlapped = true;
      passes++;
      // The first pass stays busy, like a long Git operation.
      if (passes === 1) await held;
      running--;
    },
  });
  try {
    await delay(150);
    assert.equal(passes, 1, 'a second pass started while the first was running');
    assert.ok(beats >= 5, `only ${beats} heartbeats during a long pass`);
    release();
    await delay(60);
    assert.ok(passes > 1, 'work did not resume after the long pass');
    assert.equal(overlapped, false);
  } finally {
    loop.stop();
  }
});

test('a failing pass or heartbeat is reported and the loop carries on', async () => {
  const errors: string[] = [];
  let passes = 0;
  let beats = 0;
  const loop = startServiceLoop({
    intervalMs: 10,
    beat: () => {
      if (beats++ === 0) throw new Error('database is busy');
    },
    pass: () => {
      if (passes++ === 0) throw new Error('scan failed');
    },
    onError: (error) => errors.push((error as Error).message),
  });
  try {
    await delay(80);
    assert.deepEqual(errors.sort(), ['database is busy', 'scan failed']);
    assert.ok(passes > 1 && beats > 1);
  } finally {
    loop.stop();
  }
});
