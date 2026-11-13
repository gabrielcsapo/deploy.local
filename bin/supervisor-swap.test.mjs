import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  swapSupervisor,
  supervisorSwapReceipt,
  scheduleSupervisorSwap,
  waitForSupervisor,
  restartAgentService,
  restartUpdatedServices,
} from './supervisor-swap.mjs';
import { atomicJson } from './code-bundle.mjs';

function fixture(t, platform = 'darwin') {
  const agentDir = mkdtempSync(join(tmpdir(), 'supervisor-swap-'));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const paths = {
    executable: join(agentDir, 'worker'),
    supervisor: join(agentDir, 'supervisor'),
    app: platform === 'darwin' ? join(agentDir, 'app') : null,
  };
  mkdirSync(join(agentDir, 'data'));
  const old = { version: 'old' },
    target = { version: 'new', commit: 'abc', launcherProtocol: 1 };
  writeFileSync(paths.supervisor, JSON.stringify(old), { mode: 0o755 });
  writeFileSync(paths.executable, JSON.stringify(target), { mode: 0o755 });
  const calls = [];
  const options = {
    agentDir,
    root: join(agentDir, 'data'),
    paths,
    platform,
    darwinRelease: '22.1',
    readBuildInfo: async (path) => {
      calls.push(['probe', path]);
      return JSON.parse(readFileSync(path));
    },
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0 };
    },
    seal: async () => calls.push(['seal']),
    restart: async () => calls.push(['restart']),
    waitReady: async () => calls.push(['ready']),
  };
  return { ...options, options, calls, old, target };
}
for (const platform of ['darwin', 'linux'])
  test(`idle ${platform} swaps once, prelaunches the signed inode, retains the old supervisor`, async (t) => {
    const f = fixture(t, platform);
    const oldInode = statSync(f.paths.supervisor).ino;
    let assessedInode;
    f.options.readBuildInfo = async (path) => {
      f.calls.push(['probe', path]);
      if (path.includes('.stage-')) assessedInode = statSync(path).ino;
      return JSON.parse(readFileSync(path));
    };
    assert.equal((await swapSupervisor(f.options)).state, 'complete');
    assert.equal(statSync(f.paths.supervisor).ino, assessedInode);
    assert.equal(statSync(f.paths.supervisor + '.previous').ino, oldInode);
    assert.deepEqual(JSON.parse(readFileSync(f.paths.supervisor)), f.target);
    assert.equal(f.calls.filter(([cmd]) => cmd === 'restart').length, 1);
    if (platform === 'darwin') {
      const sign = f.calls.findIndex(([cmd]) => cmd.endsWith('/codesign'));
      const probe = f.calls.findIndex(([cmd, path]) => cmd === 'probe' && path.includes('.stage-'));
      assert.ok(sign < probe);
      assert.ok(f.calls[sign].includes('local.deploy.worker'));
    } else
      assert.equal(
        f.calls.some(([cmd]) => cmd.includes('codesign')),
        false,
      );
    assert.equal((await swapSupervisor(f.options)).state, 'current');
    // Even if the old build returns later, this target is never attempted twice.
    writeFileSync(f.paths.supervisor, JSON.stringify(f.old));
    assert.equal((await swapSupervisor(f.options)).state, 'complete');
    assert.equal(f.calls.filter(([cmd]) => cmd === 'restart').length, 1);
  });

test('Darwin 24 requires Repair; a running job prevents even a probe', async (t) => {
  const f = fixture(t);
  const before = readFileSync(f.paths.supervisor);
  assert.equal((await swapSupervisor({ ...f.options, busy: true })).state, 'skipped');
  assert.deepEqual(f.calls, []);
  assert.equal(await scheduleSupervisorSwap({ ...f.options, busy: true }), false);
  assert.equal(
    (await swapSupervisor({ ...f.options, darwinRelease: '24.0' })).state,
    'needs-repair',
  );
  assert.deepEqual(readFileSync(f.paths.supervisor), before);
  assert.equal(
    f.calls.some(([cmd]) => ['seal', 'restart'].includes(cmd)),
    false,
  );
  assert.equal(
    (await swapSupervisor({ ...f.options, darwinRelease: '24.0', explicit: true })).state,
    'complete',
  );
});
for (const phase of ['sign', 'prelaunch', 'seal', 'startup'])
  test(`failure during ${phase} preserves or restores the original inode and never retries`, async (t) => {
    const f = fixture(t);
    const before = readFileSync(f.paths.supervisor),
      inode = statSync(f.paths.supervisor).ino;
    const fail = async () => {
      throw new Error('fake failure');
    };
    if (phase === 'sign') f.options.run = async () => ({ status: 1, stderr: 'fake failure' });
    if (phase === 'prelaunch')
      f.options.readBuildInfo = async (path) =>
        path.includes('.stage-') ? fail() : JSON.parse(readFileSync(path));
    if (phase === 'seal') f.options.seal = fail;
    if (phase === 'startup') f.options.waitReady = fail;
    await assert.rejects(swapSupervisor(f.options), /fake failure/);
    assert.deepEqual(readFileSync(f.paths.supervisor), before);
    assert.equal(statSync(f.paths.supervisor).ino, inode);
    assert.equal(supervisorSwapReceipt(f.root).state, 'failed');
    const calls = f.calls.length;
    assert.equal((await swapSupervisor(f.options)).state, 'failed');
    assert.equal(f.calls.length, calls + (phase === 'prelaunch' ? 0 : 2));
    if (phase === 'sign' || phase === 'prelaunch')
      assert.equal(existsSync(f.paths.supervisor + '.previous'), false);
  });

for (const platform of ['darwin', 'linux'])
  test(`automatic ${platform} swap helper runs outside the service being restarted`, async (t) => {
    const f = fixture(t, platform);
    assert.equal(await scheduleSupervisorSwap({ ...f.options, uid: 501 }), true);
    const cmd = f.calls.find(
      ([command]) => command === '/bin/launchctl' || command === 'systemd-run',
    );
    assert.ok(cmd.includes('supervisor-swap'));
    assert.ok(cmd.some((arg) => arg.includes('DEPLOY_AGENT_CONFIG=')));
    assert.ok(platform === 'darwin' ? cmd.includes('submit') : cmd.includes('--user'));
    assert.equal(await scheduleSupervisorSwap(f.options), false);
    assert.equal((await swapSupervisor({ ...f.options, scheduled: true })).state, 'complete');
  });

test('startup requires fresh readiness from the target executable, with a bounded timeout', async (t) => {
  const f = fixture(t);
  const path = join(f.root, 'supervisor-ready.json');
  atomicJson(path, { at: 1, executableVersion: 'new', launcherProtocol: 1 });
  await assert.rejects(
    waitForSupervisor({
      root: f.root,
      since: 2,
      targetVersion: 'new',
      startupMs: 1,
      sleep: async () => {},
    }),
    /startup window/,
  );
  atomicJson(path, { at: 3, executableVersion: 'new', launcherProtocol: 1 });
  await waitForSupervisor({ root: f.root, since: 2, targetVersion: 'new' });
});

test('restart commands use the agent label and user unit, with bounds', async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0 };
  };
  await restartAgentService({ platform: 'darwin', uid: 501, run });
  await restartAgentService({ platform: 'linux', uid: 501, run });
  assert.deepEqual(calls[0].args, ['kickstart', '-k', 'gui/501/sh.deploy.agent']);
  assert.deepEqual(calls[1].args, ['--user', 'restart', 'deploy-local-agent.service']);
  assert.ok(calls.every((call) => call.options.timeoutMs === 15000));
});

test('migration admission denial does not create an attempt or launch a helper', async (t) => {
  const f = fixture(t, 'linux');
  assert.equal(await scheduleSupervisorSwap({ ...f.options, reserve: async () => false }), false);
  assert.equal(supervisorSwapReceipt(f.root), null);
  assert.equal(
    f.calls.some(([command]) => command === 'systemd-run'),
    false,
  );
});

test('helper launch failure is recorded once without touching the supervisor', async (t) => {
  const f = fixture(t, 'linux');
  const original = readFileSync(f.paths.supervisor);
  await assert.rejects(
    scheduleSupervisorSwap({
      ...f.options,
      run: async () => ({ status: 1, stderr: 'launch failed' }),
    }),
    /launch failed/,
  );
  assert.equal(supervisorSwapReceipt(f.root).state, 'failed');
  assert.deepEqual(readFileSync(f.paths.supervisor), original);
  assert.equal(await scheduleSupervisorSwap(f.options), false);
});

test('a helper the manager never executes fails its queued receipt and is not retried', async (t) => {
  const f = fixture(t, 'linux');
  await scheduleSupervisorSwap(f.options);
  const path = join(f.root, 'supervisor-swap.json');
  atomicJson(path, { ...JSON.parse(readFileSync(path)), at: Date.now() - 61000 });
  assert.equal(supervisorSwapReceipt(f.root).state, 'failed');
  assert.equal(await scheduleSupervisorSwap(f.options), false);
});

test('routine code updates keep the supervisor and relays; the explicit supervisor-fix flag restarts once', async () => {
  const calls = [];
  const options = {
    restartTasks: async () => calls.push('tasks'),
    restartSupervisor: async () => calls.push('supervisor'),
  };
  await restartUpdatedServices({ kind: 'code' }, options);
  await restartUpdatedServices({ kind: 'code', restartSupervisor: false }, options);
  await restartUpdatedServices({ restartSupervisor: true }, options);
  assert.deepEqual(calls, ['tasks', 'tasks', 'tasks']);
  await restartUpdatedServices({ kind: 'code', restartSupervisor: true }, options);
  assert.deepEqual(calls, ['tasks', 'tasks', 'tasks', 'tasks', 'supervisor']);
});

test('a retried helper rolls back an interrupted rename instead of attempting the same target again', async (t) => {
  const f = fixture(t, 'linux');
  const { bundleDigest } = await import('./code-bundle.mjs');
  const old = readFileSync(f.paths.supervisor);
  writeFileSync(f.paths.supervisor + '.previous', old);
  writeFileSync(f.paths.supervisor, JSON.stringify(f.target));
  atomicJson(join(f.root, 'supervisor-swap.json'), {
    state: 'starting',
    previousDigest: bundleDigest(old),
    target: 'new:abc:1',
    attempts: ['new:abc:1'],
  });
  assert.equal((await swapSupervisor({ ...f.options, scheduled: true })).state, 'failed');
  assert.deepEqual(readFileSync(f.paths.supervisor), old);
  assert.equal(f.calls.filter(([command]) => command === 'restart').length, 1);
  assert.equal(
    f.calls.some(([command]) => command === 'probe'),
    false,
  );
});
