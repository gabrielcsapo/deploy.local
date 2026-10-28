import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { superviseWorker, workerUpdateReceipt } from '../bin/worker-supervisor.mjs';
import { installWorkerBuild } from '../bin/worker-update.mjs';

async function waitFor(check: () => any) {
  for (let i = 0; i < 300; i++) {
    const result = check();
    if (result) return result;
    await delay(10);
  }
  throw new Error('Fake worker did not finish');
}
function binary(root: string, version: string, crash = false) {
  return Buffer.from(`#!/bin/sh\nexec "${process.execPath}" --input-type=module - "$@" <<'WORKER'\nimport{existsSync,readFileSync,writeFileSync}from'node:fs';
if(process.argv[2]==='version'){console.log(JSON.stringify({version:${JSON.stringify(version)}}));process.exit(0)}
process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version:${JSON.stringify(version)}});
const root=${JSON.stringify(root)};
if(${JSON.stringify(version)}==='old'&&!existsSync(root+'/requested')){writeFileSync(root+'/requested','1');process.send({type:'worker-update',request:JSON.parse(readFileSync(root+'/request.json','utf8'))})}
${crash ? 'setTimeout(()=>process.exit(9),50);' : ''}
setInterval(()=>{try{const r=JSON.parse(readFileSync(root+'/worker-update.json','utf8'));if(['complete','failed'].includes(r.state))writeFileSync(root+'/report.json',JSON.stringify({...r,version:${JSON.stringify(version)}}))}catch{}},20);
WORKER
`);
}
for (const crash of [false, true])
  test(`supervised worker ${crash ? 'restores a build that passes version but crashes after readiness' : 'reports success only after sustained replacement startup'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'worker-supervisor-'));
    const executable = join(root, 'worker');
    const old = binary(root, 'old'),
      next = binary(root, 'new', crash);
    const request = {
      jobId: 'job',
      nonce: 'nonce',
      targetVersion: 'new',
      sha256: createHash('sha256').update(next).digest('hex'),
      size: next.length,
    };
    writeFileSync(executable, old, { mode: 0o755 });
    writeFileSync(join(root, 'request.json'), JSON.stringify(request));
    const controller = new AbortController();
    const running = superviseWorker({
      executable,
      root,
      version: 'old',
      stableMs: 150,
      startupMs: 1000,
      signal: controller.signal,
      download: async () => next,
      install: (options: any) => installWorkerBuild({ ...options, platform: 'linux' }),
    });
    try {
      const receipt = await waitFor(() => {
        const receipt = workerUpdateReceipt(root);
        return receipt && ['complete', 'failed'].includes(receipt.state) && receipt;
      });
      assert.equal(receipt.state, crash ? 'failed' : 'complete', JSON.stringify(receipt));
      assert.equal(receipt.version, crash ? 'old' : 'new');
      assert.equal(readFileSync(executable, 'utf8'), (crash ? old : next).toString());
      const report = await waitFor(() => {
        try {
          return JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
        } catch {
          return null;
        }
      });
      assert.equal(report.version, crash ? 'old' : 'new');
      assert.equal(report.nonce, 'nonce');
    } finally {
      controller.abort();
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  });

test('executor restart restores an unconfirmed swap before starting any worker', async () => {
  const root = mkdtempSync(join(tmpdir(), 'worker-recovery-'));
  const executable = join(root, 'worker');
  const old = binary(root, 'old');
  writeFileSync(executable, binary(root, 'new'), { mode: 0o755 });
  writeFileSync(`${executable}.previous`, old, { mode: 0o755 });
  writeFileSync(join(root, 'requested'), 'already requested');
  writeFileSync(
    join(root, 'worker-update.json'),
    JSON.stringify({
      state: 'starting',
      jobId: 'job',
      nonce: 'nonce',
      targetVersion: 'new',
      previousVersion: 'old',
      previousDigest: createHash('sha256').update(old).digest('hex'),
    }),
  );
  const controller = new AbortController();
  const running = superviseWorker({ executable, root, version: 'new', signal: controller.signal });
  try {
    assert.equal(workerUpdateReceipt(root).state, 'failed');
    assert.equal(readFileSync(executable, 'utf8'), old.toString());
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(join(root, 'report.json'), 'utf8')).version === 'old';
      } catch {
        return false;
      }
    });
  } finally {
    controller.abort();
    await running;
    rmSync(root, { recursive: true, force: true });
  }
});
