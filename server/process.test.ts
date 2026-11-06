import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processResult } from './process.ts';

test('probes yield, close stdin and preserve status/output', async () => {
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  try {
    const result = await processResult(process.execPath, [
      '-e',
      "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => { process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3; }, 50))",
    ]);
    assert.equal(ticked, true);
    assert.equal(result.status, 3);
    assert.equal(result.stdout, 'out');
    assert.equal(result.stderr, 'err');
  } finally {
    clearTimeout(timer);
  }
});

test('missing executables, timeouts, output limits and ignored stderr retain probe failure semantics', async () => {
  assert.equal((await processResult('/nonexistent/deploy-probe', [])).status, null);
  assert.equal(
    (await processResult(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }))
      .status,
    null,
  );
  const large = await processResult(process.execPath, [
    '-e',
    "process.stdout.write('x'.repeat(2000000))",
  ]);
  assert.equal(large.status, null);
  assert.equal((large.error as NodeJS.ErrnoException).code, 'ENOBUFS');
  assert.equal(
    (
      await processResult(process.execPath, ['-e', "process.stderr.write('x'.repeat(2000000))"], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    ).status,
    0,
  );
});
