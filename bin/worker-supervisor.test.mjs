import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseWorker, workerUpdateReceipt } from './worker-supervisor.mjs';
import { installWorkerBuild } from './worker-update.mjs';

async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    const result = check();
    if (result) return result;
    await delay(10);
  }
  throw new Error('Fake worker did not finish');
}
// A fake `agent run` child: the old build asks for an update once; `crash` fails after readiness.
function binary(root, version, crash = false) {
  return Buffer.from(`#!/bin/sh\nexec "${process.execPath}" --input-type=module - "$@" <<'WORKER'
import{existsSync,readFileSync,writeFileSync}from'node:fs';
if(process.argv[2]==='version'){console.log(JSON.stringify({version:${JSON.stringify(version)}}));process.exit(0)}
const root=${JSON.stringify(root)};
writeFileSync(root+'/started-'+${JSON.stringify(version)},'1');
writeFileSync(root+'/pid-'+${JSON.stringify(version)},String(process.pid));
process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version:${JSON.stringify(version)}});
if(${JSON.stringify(version)}==='old'&&!existsSync(root+'/requested')){writeFileSync(root+'/requested','1');process.send({type:'worker-update',request:JSON.parse(readFileSync(root+'/request.json','utf8'))})}
${crash ? 'setTimeout(()=>process.exit(9),50);' : ''}
setInterval(()=>{},1000);
WORKER
`);
}
for (const crash of [false, true])
  test(`the task worker ${crash ? 'does not restart after a rolled-back update' : 'restarts once the update is confirmed'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-restart-'));
    const executable = join(root, 'deploy-worker');
    const next = binary(root, 'new', crash);
    writeFileSync(executable, binary(root, 'old'), { mode: 0o755 });
    writeFileSync(
      join(root, 'request.json'),
      JSON.stringify({
        jobId: 'job',
        nonce: 'nonce',
        targetVersion: 'new',
        sha256: createHash('sha256').update(next).digest('hex'),
        size: next.length,
      }),
    );
    const restarts = [];
    const controller = new AbortController();
    const running = superviseWorker({
      executable,
      root,
      version: 'old',
      stableMs: 150,
      startupMs: 1000,
      signal: controller.signal,
      download: async () => next,
      install: (options) => installWorkerBuild({ ...options, platform: 'linux' }),
      onUpdated: (receipt) => restarts.push(receipt),
    });
    try {
      const receipt = await waitFor(() => {
        const current = workerUpdateReceipt(root);
        return current && ['complete', 'failed'].includes(current.state) && current;
      });
      assert.equal(receipt.state, crash ? 'failed' : 'complete');
      await delay(300);
      assert.deepEqual(
        restarts.map((update) => [update.state, update.version]),
        crash ? [] : [['complete', 'new']],
      );
    } finally {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });

test('a failed task worker restart does not undo a confirmed update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-restart-fail-'));
  const executable = join(root, 'deploy-worker');
  const next = binary(root, 'new');
  writeFileSync(executable, binary(root, 'old'), { mode: 0o755 });
  writeFileSync(
    join(root, 'request.json'),
    JSON.stringify({
      targetVersion: 'new',
      sha256: createHash('sha256').update(next).digest('hex'),
      size: next.length,
    }),
  );
  const controller = new AbortController();
  const errors = [];
  const original = console.error;
  console.error = (message) => errors.push(message);
  const running = superviseWorker({
    executable,
    root,
    version: 'old',
    stableMs: 100,
    startupMs: 1000,
    signal: controller.signal,
    download: async () => next,
    install: (options) => installWorkerBuild({ ...options, platform: 'linux' }),
    onUpdated: () => {
      throw new Error('Task worker restart failed.');
    },
  });
  try {
    await waitFor(() => workerUpdateReceipt(root)?.state === 'complete');
    await waitFor(() => errors.length);
    assert.match(errors[0], /Worker updated, but Task worker restart failed/);
    assert.equal(workerUpdateReceipt(root).version, 'new');
  } finally {
    console.error = original;
    controller.abort();
    await running;
    rmSync(root, { recursive: true, force: true });
  }
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Like codesign: new signature bytes in a new inode, so other links keep the old bytes.
function fakeSeal(path) {
  writeFileSync(`${path}.seal`, `${readFileSync(path, 'utf8')}\n# sealed\n`, { mode: 0o755 });
  renameSync(`${path}.seal`, path);
}
function appLayout() {
  const root = mkdtempSync(join(tmpdir(), 'worker-app-'));
  const macos = join(root, 'deploy.local Worker.app/Contents/MacOS');
  mkdirSync(macos, { recursive: true });
  return {
    root,
    macos,
    executable: join(macos, 'deploy-worker'),
    previous: join(root, 'deploy-worker-app.previous'),
  };
}
for (const crash of [false, true])
  test(`a swapped-in build is sealed before it starts${crash ? ', and a rollback seals the restored build' : ''}`, async () => {
    const { root, macos, executable, previous } = appLayout();
    writeFileSync(executable, binary(root, 'old'), { mode: 0o755 });
    fakeSeal(executable);
    const sealedOld = readFileSync(executable, 'utf8');
    const next = binary(root, 'new', crash);
    writeFileSync(
      join(root, 'request.json'),
      JSON.stringify({ targetVersion: 'new', sha256: sha256(next), size: next.length }),
    );
    const seals = [];
    const controller = new AbortController();
    const running = superviseWorker({
      executable,
      previous,
      root,
      version: 'old',
      stableMs: 150,
      startupMs: 1000,
      signal: controller.signal,
      download: async () => next,
      install: (options) => installWorkerBuild({ ...options, platform: 'linux' }),
      afterInstall: (path) => {
        const content = readFileSync(path, 'utf8');
        seals.push({
          path,
          build: content.includes('"new"') ? 'new' : 'old',
          newStarted: existsSync(join(root, 'started-new')),
        });
        fakeSeal(path);
      },
    });
    try {
      const receipt = await waitFor(() => {
        const current = workerUpdateReceipt(root);
        return current && ['complete', 'failed'].includes(current.state) && current;
      });
      assert.equal(receipt.state, crash ? 'failed' : 'complete', JSON.stringify(receipt));
      // The digest of the sealed build being replaced is what a rollback checks.
      assert.equal(receipt.previousDigest, sha256(sealedOld));
      assert.deepEqual(seals, [
        { path: executable, build: 'new', newStarted: false },
        ...(crash ? [{ path: executable, build: 'old', newStarted: true }] : []),
      ]);
      // The replaced build waits outside the bundle, so the bundle's seal stays valid.
      assert.deepEqual(readdirSync(macos), ['deploy-worker']);
      if (crash) {
        assert.ok(!existsSync(previous));
        assert.equal(readFileSync(executable, 'utf8'), `${sealedOld}\n# sealed\n`);
      } else {
        assert.equal(readFileSync(previous, 'utf8'), sealedOld);
        assert.equal(readFileSync(executable, 'utf8'), `${next}\n# sealed\n`);
      }
    } finally {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });

test('an interrupted update restores and seals the previous build before any worker starts', async () => {
  const { root, executable, previous } = appLayout();
  writeFileSync(previous, binary(root, 'old'), { mode: 0o755 });
  fakeSeal(previous);
  writeFileSync(executable, binary(root, 'new'), { mode: 0o755 });
  writeFileSync(join(root, 'requested'), '1');
  writeFileSync(
    join(root, 'worker-update.json'),
    JSON.stringify({
      state: 'starting',
      targetVersion: 'new',
      previousVersion: 'old',
      previousDigest: sha256(readFileSync(previous)),
    }),
  );
  const seals = [];
  const controller = new AbortController();
  const running = superviseWorker({
    executable,
    previous,
    root,
    version: 'new',
    startupMs: 1000,
    signal: controller.signal,
    afterInstall: (path) => {
      seals.push(existsSync(join(root, 'started-old')) || existsSync(join(root, 'started-new')));
      fakeSeal(path);
    },
  });
  try {
    await waitFor(() => existsSync(join(root, 'started-old')));
    assert.deepEqual(seals, [false]);
    assert.ok(!existsSync(join(root, 'started-new')));
    assert.equal(workerUpdateReceipt(root).state, 'failed');
    assert.equal(workerUpdateReceipt(root).version, 'old');
  } finally {
    controller.abort();
    await running;
    rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ['healthy', 'stale', 'frozen', 'startup'])
  test(`watchdog handles a ${mode} child`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-watchdog-'));
    const script = join(root, 'child.mjs');
    const starts = join(root, 'starts');
    const ready = join(root, 'ready');
    writeFileSync(
      script,
      `
import {appendFileSync,writeFileSync} from 'node:fs';
appendFileSync(${JSON.stringify(starts)},process.pid+'\\n');
const token=process.env.DEPLOY_WORKER_CHILD;
process.on('SIGTERM',()=>{});
setTimeout(()=>{
  process.send({type:'worker-ready',token,version:'test'});
  writeFileSync(${JSON.stringify(ready)},'ready');
  if (${JSON.stringify(mode)}==='frozen') setTimeout(()=>{while(true){}},30);
  if (${JSON.stringify(mode)}==='healthy'||${JSON.stringify(mode)}==='startup')
    setInterval(()=>process.send({type:'worker-heartbeat',token}),20);
},${mode === 'startup' ? 450 : 0});
setInterval(()=>{},1000);
`,
    );
    const logs = [];
    const controller = new AbortController();
    const running = superviseWorker({
      executable: process.execPath,
      args: [script],
      root,
      version: 'test',
      heartbeatMs: 180,
      watchdogIntervalMs: 20,
      killGraceMs: 80,
      startupMs: 1500,
      signal: controller.signal,
      log: (line) => logs.push(line),
    });
    t.after(async () => {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    });
    const pids = () => (existsSync(starts) ? readFileSync(starts, 'utf8').trim().split('\n') : []);
    await waitFor(() => existsSync(ready));
    if (mode === 'healthy' || mode === 'startup') {
      await delay(550);
      assert.equal(pids().length, 1);
      assert.deepEqual(logs, []);
    } else {
      await waitFor(() => pids().length >= 2);
      assert.notEqual(pids()[0], pids()[1]);
      assert.match(logs[0], /heartbeat stopped.*restarting/);
      assert.throws(() => process.kill(Number(pids()[0]), 0), /ESRCH/);
    }
  });

for (const phase of ['staged binary', 'bundle'])
  test(`a ${phase} codesign timeout abandons the update and leaves the old worker running`, async (t) => {
    const { runBounded, runCodesign } = await import('./bounded-command.mjs');
    const { sealWorkerBundle } = await import('./agent-services.mjs');
    const { root, macos, executable, previous } = appLayout();
    const app = join(macos, '../..');
    const old = binary(root, 'old');
    const next = binary(root, 'new');
    writeFileSync(executable, old, { mode: 0o755 });
    writeFileSync(join(app, 'seal'), 'old seal');
    writeFileSync(
      join(root, 'request.json'),
      JSON.stringify({
        targetVersion: 'new',
        sha256: sha256(next),
        size: next.length,
      }),
    );
    const logs = [];
    const controller = new AbortController();
    const hangingSign = (_command, _args, options) =>
      runBounded(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        ...options,
        timeoutMs: 450,
      });
    let ticks = 0;
    const ticking = setInterval(() => ticks++, 20);
    const running = superviseWorker({
      executable,
      previous,
      root,
      version: 'old',
      signal: controller.signal,
      heartbeatMs: 150,
      watchdogIntervalMs: 20,
      log: (line) => logs.push(line),
      download: async () => next,
      install: (options) =>
        installWorkerBuild({
          ...options,
          platform: phase === 'bundle' ? 'linux' : 'darwin',
          sign: (args) => runCodesign(args, { run: hangingSign }),
        }),
      afterInstall:
        phase === 'bundle'
          ? () =>
              sealWorkerBundle(app, {
                signSupervisor: false,
                run: async (command, args, options) => {
                  writeFileSync(executable, 'half signed');
                  writeFileSync(join(app, 'seal'), 'broken seal');
                  return hangingSign(command, args, options);
                },
              })
          : () => {
              throw new Error('Unchanged old worker must not need sealing');
            },
    });
    t.after(async () => {
      controller.abort();
      await running;
      clearInterval(ticking);
      rmSync(root, { recursive: true, force: true });
    });
    await waitFor(() => existsSync(join(root, 'pid-old')));
    const originalPid = Number(readFileSync(join(root, 'pid-old'), 'utf8'));
    await waitFor(() => workerUpdateReceipt(root)?.state === 'failed');
    assert.equal(Number(readFileSync(join(root, 'pid-old'), 'utf8')), originalPid);
    process.kill(originalPid, 0);
    assert.match(workerUpdateReceipt(root).error, /timed out/);
    assert.equal(workerUpdateReceipt(root).version, 'old');
    assert.deepEqual(readFileSync(executable), old);
    assert.equal(readFileSync(join(app, 'seal'), 'utf8'), 'old seal');
    assert.equal(existsSync(join(root, 'started-new')), false);
    assert.deepEqual(readdirSync(macos), ['deploy-worker']);
    assert.ok(ticks >= 10, 'supervisor event loop ran while signing waited');
    assert.equal(
      logs.some((line) => line.includes('heartbeat stopped')),
      false,
      'watchdog did not interrupt an update longer than its heartbeat limit',
    );
    assert.ok(logs.some((line) => line.includes('Worker update abandoned:')));
  });

test('a child exit during installation cannot start the candidate before rollback finishes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-update-exit-'));
  const executable = join(root, 'worker');
  const old = binary(root, 'old', true);
  const next = binary(root, 'new');
  writeFileSync(executable, old, { mode: 0o755 });
  writeFileSync(
    join(root, 'request.json'),
    JSON.stringify({ targetVersion: 'new', sha256: sha256(next), size: next.length }),
  );
  const controller = new AbortController();
  let sealing = false;
  const running = superviseWorker({
    executable,
    root,
    version: 'old',
    signal: controller.signal,
    download: async () => next,
    install: (options) => installWorkerBuild({ ...options, platform: 'linux' }),
    afterInstall: async () => {
      sealing = true;
      await delay(450);
    },
  });
  t.after(async () => {
    controller.abort();
    await running;
    rmSync(root, { recursive: true, force: true });
  });
  await waitFor(() => sealing);
  await delay(300);
  assert.equal(existsSync(join(root, 'started-new')), false);
  await waitFor(() => workerUpdateReceipt(root)?.state === 'failed');
  assert.deepEqual(readFileSync(executable), old);
});
