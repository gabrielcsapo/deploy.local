import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('simultaneous local worker starts have one owner; a dead owner can be replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lease-'));
  const children: ReturnType<typeof spawn>[] = [];
  const source = `
    import {claimWorker} from ${JSON.stringify(new URL('./worker-lease.ts', import.meta.url).href)};
    process.on('message', () => {
      try { claimWorker('local'); process.send({result:'claimed'}); }
      catch(e) { process.send({result:'rejected', message:e.message}); }
    });
    process.send({result:'ready'});
  `;
  async function start() {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
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
    const contenders = await Promise.all(Array.from({ length: 4 }, start));
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
    assert.equal((await result)[0].result, 'claimed');
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
