import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundleDigest, installCodeBundle, readCurrentBundle, atomicJson } from './code-bundle.mjs';
import { superviseWorker, workerUpdateReceipt } from './worker-supervisor.mjs';

async function waitFor(check) {
  for (let i = 0; i < 500; i++) {
    const value = check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('Timed out waiting for worker');
}
for (const fail of [false, true])
  test(`code update ${fail ? 'rolls back a child that never becomes ready' : 'confirms readiness without changing any executable'}`, async (t) => {
    const agentDir = mkdtempSync(join(tmpdir(), 'code-update-'));
    const root = join(agentDir, 'data');
    const executable = join(agentDir, 'worker');
    const childScript = join(agentDir, 'child.mjs');
    const entry = (version, ready = true) => `module.exports = async () => {
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(join(agentDir, 'started-'))}+${JSON.stringify(version)}, '1');
    ${ready ? `process.send({type:'worker-ready', token:process.env.DEPLOY_WORKER_CHILD, version:${JSON.stringify(version)}});` : ''}
    if (${JSON.stringify(version)} === 'old' && !fs.existsSync(${JSON.stringify(join(agentDir, 'requested'))})) {
      fs.writeFileSync(${JSON.stringify(join(agentDir, 'requested'))}, '1');
      process.send({type:'worker-update', request:JSON.parse(fs.readFileSync(${JSON.stringify(join(agentDir, 'request.json'))}))});
    }
    setInterval(()=>{},1000);
  };`;
    const old = Buffer.from(entry('old'));
    const next = Buffer.from(entry('new', !fail));
    const previous = installCodeBundle({
      agentDir,
      version: 'old',
      bytes: old,
      size: old.length,
      sha256: bundleDigest(old),
      launcherProtocol: 1,
      executableProtocol: 1,
    });
    writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${childScript}" "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(
      childScript,
      `import {runLauncher} from ${JSON.stringify(new URL('./launcher.mjs', import.meta.url).href)}; await runLauncher({ agentDir:${JSON.stringify(agentDir)}, build:{version:'baked'}, baked:()=>process.exit(9) });`,
    );
    writeFileSync(
      join(agentDir, 'request.json'),
      JSON.stringify({
        kind: 'code',
        targetVersion: 'new',
        launcherProtocol: 1,
        sha256: bundleDigest(next),
        size: next.length,
        nonce: 'n',
        jobId: 'j',
      }),
    );
    const original = readFileSync(executable),
      mtime = statSync(executable).mtimeMs;
    const controller = new AbortController();
    const updates = [];
    const running = superviseWorker({
      executable,
      root,
      agentDir,
      executableProtocol: 1,
      version: 'old',
      stableMs: 40,
      startupMs: 400,
      killGraceMs: 50,
      signal: controller.signal,
      download: async () => next,
      install: () => assert.fail('executable write'),
      afterInstall: () => assert.fail('codesign'),
      onUpdated: (r) => updates.push(r),
    });
    t.after(async () => {
      controller.abort();
      await running;
      rmSync(agentDir, { recursive: true, force: true });
    });
    await waitFor(() => ['complete', 'failed'].includes(workerUpdateReceipt(root)?.state));
    const receipt = workerUpdateReceipt(root);
    assert.equal(receipt.state, fail ? 'failed' : 'complete');
    assert.equal(receipt.version, fail ? 'old' : 'new');
    assert.equal(receipt.nonce, 'n');
    assert.deepEqual(receipt.previousBundle, previous);
    assert.equal(readCurrentBundle(agentDir).version, fail ? 'old' : 'new');
    assert.deepEqual(readFileSync(executable), original);
    assert.equal(statSync(executable).mtimeMs, mtime);
    assert.equal(updates.length, fail ? 0 : 1);
    assert.equal(existsSync(executable + '.previous'), false);
  });

test('legacy and code receipts remain readable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const receipt of [
    { state: 'complete', version: 'old' },
    { kind: 'code', state: 'failed', version: 'old', previousBundle: null },
  ]) {
    atomicJson(join(root, 'worker-update.json'), receipt);
    assert.deepEqual(workerUpdateReceipt(root), receipt);
  }
});

test('an interrupted code update restores its pointer before any child is started', async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), 'code-interrupted-'));
  const root = join(agentDir, 'data');
  const bytes = Buffer.from('module.exports = () => {};');
  const options = {
    agentDir,
    bytes,
    size: bytes.length,
    sha256: bundleDigest(bytes),
    launcherProtocol: 1,
    executableProtocol: 1,
  };
  const old = installCodeBundle({ ...options, version: 'old' });
  installCodeBundle({ ...options, version: 'new' });
  atomicJson(join(root, 'worker-update.json'), {
    kind: 'code',
    state: 'starting',
    targetVersion: 'new',
    previousVersion: 'old',
    previousBundle: old,
    previousBundleHistory: null,
  });
  const script = join(agentDir, 'child.mjs');
  const marker = join(agentDir, 'observed');
  writeFileSync(
    script,
    `import {readFileSync,writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},readFileSync(${JSON.stringify(join(agentDir, 'code/current.json'))})); process.send({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version:'old'}); setInterval(()=>{},1000);`,
  );
  const controller = new AbortController();
  const running = superviseWorker({
    executable: process.execPath,
    args: [script],
    root,
    agentDir,
    version: 'new',
    signal: controller.signal,
    afterInstall: () => assert.fail('codesign'),
  });
  t.after(async () => {
    controller.abort();
    await running;
    rmSync(agentDir, { recursive: true, force: true });
  });
  await waitFor(() => existsSync(marker));
  assert.deepEqual(JSON.parse(readFileSync(marker)), old);
  assert.equal(workerUpdateReceipt(root).state, 'failed');
  assert.equal(existsSync(join(agentDir, 'code/new')), false);
});
