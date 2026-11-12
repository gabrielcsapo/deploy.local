import assert from 'node:assert/strict';
import test from 'node:test';
import { runBounded } from './bounded-command.mjs';

test('a command that answers returns its output and status', async () => {
  const result = await runBounded(process.execPath, ['-e', 'console.log("29.2.0")']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '29.2.0');
  assert.equal(result.timedOut, false);
});

test('a command that hangs is stopped, and the worker kept running meanwhile', async () => {
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 10);
  const started = Date.now();
  const result = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 200,
  });
  clearInterval(ticking);
  assert.equal(result.status, null);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /did not answer in 0 s/);
  assert.ok(Date.now() - started < 2000);
  assert.ok(ticks >= 5, 'timers ran while the command hung');
});

test('a command that cannot start reports why', async () => {
  const result = await runBounded('deploy-command-that-does-not-exist', ['version']);
  assert.equal(result.status, null);
  assert.match(result.stderr, /ENOENT/);
});
