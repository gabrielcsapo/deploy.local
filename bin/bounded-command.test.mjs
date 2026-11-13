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

test('a timeout kills the process group, including a descendant holding inherited pipes', async (t) => {
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setTimeout: delay } = await import('node:timers/promises');
  const root = mkdtempSync(join(tmpdir(), 'bounded-group-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'escaped');
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'escaped'), 800)`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: 'inherit'}); setInterval(() => {}, 1000)`;
  const result = await runBounded(process.execPath, ['-e', parent], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  await delay(900);
  assert.equal(existsSync(marker), false, 'the descendant could not keep running after timeout');
});

test('codesign has a ten minute limit and periodically logs the command it is waiting on', async () => {
  const { runCodesign } = await import('./bounded-command.mjs');
  let options;
  await runCodesign(['--force', '--sign', '-', '/fixture/worker'], {
    run: (_command, _args, value) => {
      options = value;
      return { status: 0 };
    },
  });
  assert.equal(options.timeoutMs, 600_000);
  const logs = [];
  const result = await runCodesign(['--force', '--sign', '-', '/fixture/worker'], {
    run: (_command, _args, value) =>
      runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], value),
    timeoutMs: 180,
    progressMs: 40,
    log: (message) => logs.push(message),
  });
  assert.equal(result.timedOut, true);
  assert.ok(logs.length >= 2);
  assert.match(logs[0], /Waiting for codesign --force --sign - \/fixture\/worker/);
});

test('Docker queries remain short while builds, foreground jobs, and copies get time to finish', async () => {
  const { dockerCommandTimeout, DATA_COMMAND_TIMEOUT_MS } = await import('./bounded-command.mjs');
  for (const args of [
    ['ps'],
    ['inspect', 'app'],
    ['buildx', 'version'],
    ['buildx', 'build', '--help'],
  ])
    assert.equal(dockerCommandTimeout(args), 30_000);
  for (const args of [
    ['build', '.'],
    ['pull', 'image'],
    ['cp', 'source', 'target'],
    ['run', '--rm', 'image', 'migrate'],
    ['exec', 'app', 'migrate'],
  ])
    assert.equal(dockerCommandTimeout(args), DATA_COMMAND_TIMEOUT_MS);
  assert.equal(dockerCommandTimeout(['run', '-d', 'image']), 5 * 60_000);
  // A job's own arguments are not Docker's: this migration keeps the long limit.
  assert.equal(
    dockerCommandTimeout(['run', '--rm', 'image', 'migrate', '-d', 'database']),
    DATA_COMMAND_TIMEOUT_MS,
  );
});

test('settles waits for a poll in flight and gives up when it never ends', async () => {
  // A worker asked to update mid-poll waits for the poll, instead of declining as "busy".
  const { settles } = await import('./bounded-command.mjs');
  let clock = 0;
  const options = { now: () => clock, sleep: async (ms) => void (clock += ms), stepMs: 100 };
  let polling = true;
  setTimeout(() => (polling = false), 0);
  let checks = 0;
  assert.equal(await settles(() => (++checks > 3 ? !(polling = false) : !polling), options), true);
  clock = 0;
  assert.equal(await settles(() => false, { ...options, timeoutMs: 1000 }), false);
  assert.equal(clock, 1000);
  assert.equal(await settles(() => true, options), true);
});
