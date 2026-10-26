import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('local leases respect same-build owners and replace dead or different-build workers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lease-'));
  const children: ReturnType<typeof spawn>[] = [];
  const source = `
    globalThis.__WORKER_BUILD_COMMIT__ = process.env.TEST_WORKER_BUILD;
    const {claimWorker} = await import(${JSON.stringify(new URL('./worker-lease.ts', import.meta.url).href)});
    const {get} = await import(${JSON.stringify(new URL('./store.ts', import.meta.url).href)});
    process.on('message', () => {
      try { claimWorker('local'); process.send({result:'claimed', lease:get('worker-lease','system','local')}); }
      catch(e) { process.send({result:'rejected', message:e.message}); }
    });
    process.send({result:'ready'});
  `;
  async function start(build = 'same-build') {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEPLOY_DATA_DIR: root, TEST_WORKER_BUILD: build },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(child);
    let errors = '';
    child.stderr!.on('data', (chunk) => {
      errors += chunk;
    });
    const ready = await Promise.race([
      once(child, 'message').then(([message]) => message),
      once(child, 'exit').then(() => {
        throw new Error('Child exited: ' + errors);
      }),
    ]);
    assert.equal(ready.result, 'ready');
    return child;
  }
  try {
    const contenders = await Promise.all(Array.from({ length: 4 }, () => start()));
    const results = await Promise.all(
      contenders.map(async (child) => {
        const result = once(child, 'message');
        child.send!('claim');
        return (await result)[0];
      }),
    );
    assert.equal(results.filter((r) => r.result === 'claimed').length, 1);
    assert.ok(
      results
        .filter((r) => r.result === 'rejected')
        .every((r) => /already running/.test(r.message)),
    );
    const winner = contenders[results.findIndex((r) => r.result === 'claimed')];
    const exited = once(winner, 'exit');
    winner.kill('SIGTERM');
    await exited;
    const replacement = await start();
    const result = once(replacement, 'message');
    replacement.send!('claim');
    const claimed = (await result)[0];
    assert.equal(claimed.result, 'claimed');
    assert.equal(claimed.lease.pid, replacement.pid);
    assert.equal(claimed.lease.executablePath, process.execPath);
    assert.equal(claimed.lease.build.commit, 'same-build');
    const upgraded = await start('new-build');
    const stopped = once(replacement, 'exit');
    const takeover = once(upgraded, 'message');
    upgraded.send!('claim');
    assert.equal((await takeover)[0].result, 'claimed');
    await stopped;
  } finally {
    await Promise.all(
      children
        .filter((c) => c.exitCode === null && c.signalCode === null)
        .map(async (child) => {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
