import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimRemoteWorker } from './remote-worker-lease.ts';
import { workerLease, type WorkerLease } from './worker-process.ts';

const moduleURL = new URL('./worker-process.ts', import.meta.url).href;
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
async function fakeWorker() {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { workerLease } from ${JSON.stringify(moduleURL)};
    process.send(workerLease({version:'old',commit:'old'}));
    setInterval(()=>{},1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const [lease] = await once(child, 'message');
  return { child, lease: lease as WorkerLease };
}

test('remote lease replaces a live worker from a different build and records identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-worker-lease-'));
  const path = join(root, 'worker.pid');
  const { child, lease } = await fakeWorker();
  try {
    writeFileSync(path, JSON.stringify(lease));
    const exited = once(child, 'exit');
    const current = { ...lease, ...workerLease(), build: { version: 'new', commit: 'new' } };
    const release = claimRemoteWorker(path, current);
    await exited;
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), current);
    release();
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('same-build live lease remains owned; recycled PID lease is replaced without a signal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-worker-live-'));
  const path = join(root, 'worker.pid');
  const { child, lease } = await fakeWorker();
  try {
    writeFileSync(path, JSON.stringify(lease));
    assert.throws(() => claimRemoteWorker(path, { ...lease, pid: process.pid }), /already running/);
    assert.equal(child.signalCode, null);
    writeFileSync(path, JSON.stringify({ ...lease, started: 'reused-pid' }));
    const release = claimRemoteWorker(path);
    assert.equal(child.signalCode, null);
    release();
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const ipc of [true, false]) {
  test(`orphan worker exits after fake app dies (${ipc ? 'IPC' : 'parent PID watch'})`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-parent-'));
    const marker = join(root, 'exited');
    const source = `
      import {watchWorkerParent} from ${JSON.stringify(moduleURL)};
      import {writeFileSync} from 'node:fs';
      watchWorkerParent(()=>{writeFileSync(${JSON.stringify(marker)},'exited');process.exit(0)});
      ${ipc ? "process.send('ready');" : 'writeFileSync(' + JSON.stringify(marker + '.ready') + ", 'ready');"}
      setInterval(()=>{},1000);
    `;
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {spawn} from 'node:child_process';
      import {existsSync} from 'node:fs';
      const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(source)}],{
        env:{...process.env,DEPLOY_WORKER_PARENT_PID:${ipc ? "''" : 'String(process.pid)'}},
        stdio:['ignore','ignore','inherit'${ipc ? ",'ipc'" : ''}]
      });
      ${ipc ? "child.once('message',()=>process.send(child.pid));" : 'const ready=setInterval(()=>{if(existsSync(' + JSON.stringify(marker + '.ready') + ')){clearInterval(ready);process.send(child.pid)}},25);'}
      process.on('message',()=>process.exit(0));
    `,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    let pid: number | undefined;
    try {
      [pid] = await once(parent, 'message', { signal: AbortSignal.timeout(5000) });
      const exited = once(parent, 'exit');
      parent.kill('SIGKILL');
      await exited;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          assert.equal(readFileSync(marker, 'utf8'), 'exited');
          return;
        } catch {
          await new Promise((done) => setTimeout(done, 25));
        }
      }
      assert.fail('orphan did not shut down');
    } finally {
      await stop(parent);
      // Only the fake child PID returned by this test is eligible for cleanup.
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('simultaneous remote starts leave exactly one same-build owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'remote-contenders-'));
  const path = join(root, 'worker.pid');
  const children: ChildProcess[] = [];
  const claimURL = new URL('./remote-worker-lease.ts', import.meta.url).href;
  try {
    const contenders = await Promise.all(
      Array.from({ length: 4 }, async () => {
        const child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `
        import {claimRemoteWorker} from ${JSON.stringify(claimURL)};
        process.on('message',()=>{
          try { claimRemoteWorker(${JSON.stringify(path)}); process.send('claimed'); }
          catch(error) { process.send(error.message); }
        });
        process.send('ready');
      `,
          ],
          { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
        );
        children.push(child);
        await once(child, 'message');
        return child;
      }),
    );
    const results = await Promise.all(
      contenders.map(async (child) => {
        const message = once(child, 'message');
        child.send!('claim');
        return (await message)[0];
      }),
    );
    assert.equal(results.filter((result) => result === 'claimed').length, 1);
    assert.ok(
      results
        .filter((result) => result !== 'claimed')
        .every((result) => /already running/.test(result)),
      JSON.stringify(results),
    );
  } finally {
    await Promise.all(children.map(stop));
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'legacy PID lock from another Linux install is verified before takeover',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'legacy-worker-lease-'));
    const entry = join(root, 'workspace-remote-worker.js');
    const path = join(root, 'worker.pid');
    writeFileSync(entry, `process.send('ready');setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, DEPLOY_WORKER_ROOT: root },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    try {
      await once(child, 'message');
      writeFileSync(path, String(child.pid));
      const exited = once(child, 'exit');
      claimRemoteWorker(path)();
      await exited;
    } finally {
      await stop(child);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('legacy live PID without a verified worker entry is respected', async () => {
  const root = mkdtempSync(join(tmpdir(), 'unverified-worker-lease-'));
  const path = join(root, 'worker.pid');
  const { child } = await fakeWorker();
  try {
    writeFileSync(path, String(child.pid));
    assert.throws(() => claimRemoteWorker(path), /identity must be verified/);
    assert.equal(child.signalCode, null);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'legacy Linux worker belonging to a different lock directory is never signaled',
  { skip: process.platform !== 'linux' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'other-worker-lease-'));
    const entry = join(root, 'workspace-remote-worker.js');
    const path = join(root, 'worker.pid');
    writeFileSync(entry, `process.send('ready');setInterval(()=>{},1000);`);
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, DEPLOY_WORKER_ROOT: join(root, 'other') },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    try {
      await once(child, 'message');
      writeFileSync(path, String(child.pid));
      assert.throws(() => claimRemoteWorker(path), /identity must be verified/);
      assert.equal(child.signalCode, null);
    } finally {
      await stop(child);
      rmSync(root, { recursive: true, force: true });
    }
  },
);
