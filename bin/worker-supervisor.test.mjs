import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version:${JSON.stringify(version)}});
const root=${JSON.stringify(root)};
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
