import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createProcessSampler, processMetrics, slowProcessLine } from './process-metrics.ts';

test('the real histogram samples memory and event-loop delays, then resets its window', async () => {
  const sampler = createProcessSampler();
  try {
    await delay(60);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
    await delay(40);
    const sample = sampler.sample();
    assert.ok(sample.eventLoopDelayMs.max >= 70, JSON.stringify(sample));
    assert.ok(sample.eventLoopDelayMs.p99 >= sample.eventLoopDelayMs.p50);
    assert.ok(sample.rssBytes > 0 && sample.heapUsedBytes > 0);
    assert.ok(sample.heapTotalBytes >= sample.heapUsedBytes);
    assert.ok(sample.windowMs >= 160);
    assert.deepEqual(sampler.sample().eventLoopDelayMs, { p50: 0, p99: 0, max: 0 });
  } finally {
    sampler.close();
  }
});

test('slow-loop logs use strict thresholds and reject malformed optional telemetry', () => {
  const sample = {
    sampledAt: Date.now(),
    windowMs: 60000,
    rssBytes: 1048576,
    heapUsedBytes: 1024,
    heapTotalBytes: 2048,
    eventLoopDelayMs: { p50: 20, p99: 200, max: 1000 },
  };
  assert.deepEqual(processMetrics(sample), sample);
  assert.equal(slowProcessLine('control', 42, sample), null);
  assert.match(
    slowProcessLine('control', 42, {
      ...sample,
      eventLoopDelayMs: { ...sample.eventLoopDelayMs, p99: 201 },
    })!,
    /control \(pid 42\).*p99=201ms.*rss=1MiB/,
  );
  assert.ok(
    slowProcessLine('edge', 43, {
      ...sample,
      eventLoopDelayMs: { ...sample.eventLoopDelayMs, max: 1001 },
    }),
  );
  for (const invalid of [
    null,
    {},
    'bad',
    { ...sample, rssBytes: -1 },
    { ...sample, windowMs: Infinity },
    { ...sample, eventLoopDelayMs: null },
  ])
    assert.equal(processMetrics(invalid), null);
});

test(
  'supervised children send minute samples on the existing heartbeat channel and exit after disconnect',
  { timeout: 15000 },
  async () => {
    const entry = new URL('./supervisor-heartbeat.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import {startSupervisorHeartbeat} from ${JSON.stringify(entry)};
    startSupervisorHeartbeat(10, 100);
    process.on('message', () => {});
  `,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    const exited = once(child, 'exit');
    const samples: any[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No heartbeat samples')), 10000);
        child.on('message', (message: any) => {
          assert.equal(message.type, 'heartbeat');
          if (!message.metrics) return;
          assert.ok(processMetrics(message.metrics));
          samples.push(message.metrics);
          if (samples.length >= 2) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      assert.ok(samples[1].sampledAt > samples[0].sampledAt);
      assert.ok(samples.every((sample) => sample.windowMs >= 100 && sample.rssBytes > 0));
      child.disconnect();
      assert.equal((await exited)[0], 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  },
);
