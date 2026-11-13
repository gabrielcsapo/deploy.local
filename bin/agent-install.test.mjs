import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureWorkerBuild } from './agent-install.mjs';
import { installWorkerBuild } from './worker-update.mjs';
import {
  linkWorkerSupervisor,
  serviceProgramArguments,
  supervisedExecutable,
  workerExecutablePaths,
} from './agent-services.mjs';
import { superviseWorker } from './worker-supervisor.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function binary(version, commit = version, marker = '') {
  return Buffer.from(`#!/bin/sh\n# ${marker}\nexec '${process.execPath}' --input-type=module - "$@" <<'WORKER'
import {writeFileSync} from 'node:fs';
import {agentHeartbeatCapabilities} from ${JSON.stringify(new URL('./agent-services.mjs', import.meta.url).href)};
const version=${JSON.stringify(version)},commit=${JSON.stringify(commit)};
if(process.argv[2]==='version'){console.log(JSON.stringify({version,commit}));process.exit(0)}
writeFileSync(process.env.TEST_HEARTBEAT,JSON.stringify({version,...agentHeartbeatCapabilities({}, undefined)}));
process.send?.({type:'worker-ready',token:process.env.DEPLOY_WORKER_CHILD,version});
setInterval(()=>{},1000);
WORKER
`);
}
function fixture(t, { mac = false, version = 'new', commit = version, marker = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agent-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const layout = { platform: mac ? 'darwin' : 'linux', app: mac ? join(root, 'Worker.app') : null };
  const paths = workerExecutablePaths(root, layout);
  mkdirSync(dirname(paths.executable), { recursive: true });
  const old = binary('old');
  const next = binary(version, commit, marker);
  writeFileSync(paths.executable, old, { mode: 0o755 });
  writeFileSync(paths.previous, 'earlier rollback');
  const manifest = {
    version,
    commit,
    targets: { [`${layout.platform}-x64`]: { sha256: digest(next), size: next.length } },
  };
  const requests = [],
    lines = [],
    restarts = [];
  let artifact = next,
    sealFails = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    if (String(url).endsWith('/cli/version')) return Response.json(manifest);
    if (artifact instanceof Error) throw artifact;
    return new Response(artifact);
  });
  const options = {
    paths,
    platform: layout.platform,
    arch: 'x64',
    install: (input) => installWorkerBuild({ ...input, platform: 'linux' }),
    seal: () => {
      if (mac) {
        // Signing mutates both the executable and the app's resource seal.
        writeFileSync(
          paths.executable,
          Buffer.concat([readFileSync(paths.executable), Buffer.from('# signed\n')]),
        );
        writeFileSync(join(paths.app, 'seal'), 'new seal');
      }
      if (sealFails) throw new Error('seal failed');
    },
    restartServices: () => restarts.push(readFileSync(paths.executable)),
    print: (line) => lines.push(line),
  };
  return {
    root,
    paths,
    old,
    next,
    manifest,
    requests,
    lines,
    restarts,
    options,
    layout,
    artifact: (value) => {
      artifact = value;
    },
    failSeal: () => {
      sealFails = true;
    },
    repair: () => ensureWorkerBuild('http://fixture.invalid:5300', root, options),
  };
}

test('install refreshes an outdated worker and retains the previous working build', async (t) => {
  const f = fixture(t);
  await f.repair();
  assert.deepEqual(readFileSync(f.paths.executable), f.next);
  assert.deepEqual(readFileSync(f.paths.previous), f.old);
  assert.deepEqual(f.lines, ['Worker build: old -> new.']);
  assert.equal(f.restarts.length, 1);
  assert.equal(spawnSync(f.paths.executable, ['version', '--json']).status, 0);
});

for (const change of ['commit', 'sha256'])
  test(`install compares ${change} even when the version matches`, async (t) => {
    const f = fixture(t, {
      version: 'old',
      commit: change === 'commit' ? 'new-commit' : 'old',
      marker: change,
    });
    await f.repair();
    assert.deepEqual(readFileSync(f.paths.executable), f.next);
    assert.deepEqual(readFileSync(f.paths.previous), f.old);
  });

test('a matching coordinator build leaves worker and rollback untouched while repairing services', async (t) => {
  const f = fixture(t, { version: 'old' });
  const inode = statSync(f.paths.executable).ino;
  await f.repair();
  assert.deepEqual(readFileSync(f.paths.executable), f.old);
  assert.equal(statSync(f.paths.executable).ino, inode);
  assert.equal(readFileSync(f.paths.previous, 'utf8'), 'earlier rollback');
  assert.deepEqual(f.requests, ['http://fixture.invalid:5300/cli/version']);
  assert.deepEqual(f.lines, ['Worker build: old is already current.']);
  assert.equal(f.restarts.length, 1);
});

for (const failure of ['download', 'checksum', 'seal', 'restart'])
  test(`failed ${failure} restores the previous working worker`, async (t) => {
    const f = fixture(t, { mac: failure === 'seal' });
    if (f.paths.app) writeFileSync(join(f.paths.app, 'seal'), 'old seal');
    writeFileSync(f.paths.supervisor, 'old supervisor');
    if (failure === 'download') f.artifact(new Error('download failed'));
    if (failure === 'checksum') f.artifact(Buffer.from('corrupt'));
    if (failure === 'seal') f.failSeal();
    if (failure === 'restart') {
      let first = true;
      f.options.restartServices = () => {
        if (first) {
          first = false;
          writeFileSync(f.paths.supervisor, 'new supervisor');
          throw new Error('restart failed');
        }
        f.restarts.push(readFileSync(f.paths.executable));
      };
    }
    await assert.rejects(f.repair(), /previous worker build was (kept|restored)/);
    assert.deepEqual(readFileSync(f.paths.executable), f.old);
    assert.equal(readFileSync(f.paths.supervisor, 'utf8'), 'old supervisor');
    assert.equal(readFileSync(f.paths.previous, 'utf8'), 'earlier rollback');
    if (f.paths.app) assert.equal(readFileSync(join(f.paths.app, 'seal'), 'utf8'), 'old seal');
    assert.equal(spawnSync(f.paths.executable, ['version', '--json']).status, 0);
    assert.ok(!f.lines.some((line) => line.includes(' -> ')));
    if (failure === 'restart') assert.deepEqual(f.restarts, [f.old]);
  });

test('a sealed Mac build is already current on the next repair', async (t) => {
  const f = fixture(t, { mac: true });
  await f.repair();
  const sealed = readFileSync(f.paths.executable),
    inode = statSync(f.paths.executable).ino;
  f.requests.length = 0;
  f.lines.length = 0;
  await f.repair();
  assert.deepEqual(readFileSync(f.paths.executable), sealed);
  assert.equal(statSync(f.paths.executable).ino, inode);
  assert.deepEqual(readFileSync(f.paths.previous), f.old);
  assert.deepEqual(f.requests, ['http://fixture.invalid:5300/cli/version']);
  assert.deepEqual(f.lines, ['Worker build: new is already current.']);
});

test('a repaired Mac worker runs through its supervisor and reports selfUpdate', async (t) => {
  const f = fixture(t, { mac: true });
  const heartbeat = join(f.root, 'heartbeat.json');
  const oldHeartbeat = process.env.TEST_HEARTBEAT;
  process.env.TEST_HEARTBEAT = heartbeat;
  t.after(() => {
    if (oldHeartbeat === undefined) delete process.env.TEST_HEARTBEAT;
    else process.env.TEST_HEARTBEAT = oldHeartbeat;
  });
  const controller = new AbortController();
  let running;
  f.options.restartServices = async () => {
    await linkWorkerSupervisor(f.root, { ...f.layout, run: () => ({ status: 0 }) });
    const args = serviceProgramArguments({
      agentDir: f.root,
      self: ['/unused/deploy'],
      ...f.layout,
    });
    assert.equal(args.agent[0], f.paths.supervisor);
    const executable = supervisedExecutable(args.agent[0], f.root, f.layout);
    running = superviseWorker({
      executable,
      root: f.root,
      version: 'new',
      signal: controller.signal,
    });
    for (let i = 0; i < 100 && !existsSync(heartbeat); i++) await delay(10);
  };
  try {
    await f.repair();
    assert.deepEqual(JSON.parse(readFileSync(heartbeat, 'utf8')), {
      version: 'new',
      selfUpdate: 1,
    });
  } finally {
    controller.abort();
    await running;
  }
});

// Exercise the existing CLI service seam with no launchd/systemd calls or real service files.
function executionService(platform, failure) {
  const source = readFileSync(new URL('./deploy.js', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function installExecutionAgentService('),
    source.indexOf('async function installRoleServices('),
  );
  const calls = [];
  const install = runInNewContext(`(${body.trim()})`, {
    linkWorkerSupervisor: () => {},
    dirname,
    resolve: join,
    agentConfigPath: () => '/fixture/agent.json',
    programArguments: () => ({ agent: ['/fixture/supervisor'] }),
    platform: () => platform,
    homedir: () => '/fixture',
    mkdirSync: () => {},
    writeFileSync: () => {},
    xmlEscape: String,
    systemdQuote: String,
    agentUser: () => ({ uid: 501 }),
    process: { getuid: () => (platform === 'darwin' ? 501 : 0), env: {} },
    runBounded: (command, args) => {
      calls.push([command, ...args]);
      return { status: args[0] === failure ? 1 : 0, stderr: 'fixture service failure' };
    },
  });
  return { install, calls };
}
test('Linux repair explicitly restarts an already enabled execution agent', async () => {
  const f = executionService('linux');
  await f.install();
  assert.ok(
    f.calls.some((call) => call.join(' ') === 'systemctl restart deploy-local-agent.service'),
  );
});
test('Mac repair rejects a failed execution-agent kickstart for rollback', async () => {
  const f = executionService('darwin', 'kickstart');
  await assert.rejects(f.install, /fixture service failure/);
});

test('a downloaded build with the right version but wrong commit is rejected before swapping', async (t) => {
  const f = fixture(t);
  f.manifest.commit = 'expected-commit';
  await assert.rejects(f.repair(), /does not match the coordinator release/);
  assert.deepEqual(readFileSync(f.paths.executable), f.old);
  assert.equal(readFileSync(f.paths.previous, 'utf8'), 'earlier rollback');
  assert.equal(f.restarts.length, 0);
});

test('a failed supervisor seal restores the complete Mac bundle and restarts without signing it again', async (t) => {
  const f = fixture(t, { mac: true });
  writeFileSync(f.paths.supervisor, 'old supervisor');
  writeFileSync(join(f.paths.app, 'seal'), 'old seal');
  const restarts = [];
  f.options.restartServices = ({ rollback }) => {
    restarts.push(rollback);
    if (!rollback) {
      writeFileSync(f.paths.supervisor, 'new unsealed supervisor');
      writeFileSync(join(f.paths.app, 'seal'), 'broken seal');
      throw new Error('supervisor seal failed');
    }
    assert.equal(readFileSync(f.paths.supervisor, 'utf8'), 'old supervisor');
    assert.equal(readFileSync(join(f.paths.app, 'seal'), 'utf8'), 'old seal');
  };
  await assert.rejects(f.repair(), /previous worker build was restored/);
  assert.deepEqual(restarts, [false, true]);
  assert.deepEqual(readFileSync(f.paths.executable), f.old);
});

test('manual repair clears an old automatic-update receipt before starting the new supervisor', async (t) => {
  const f = fixture(t);
  const receipt = join(f.root, 'data/worker-update.json');
  mkdirSync(dirname(receipt));
  writeFileSync(
    receipt,
    JSON.stringify({ state: 'starting', version: 'old', targetVersion: 'old' }),
  );
  f.options.restartServices = () => assert.equal(existsSync(receipt), false);
  await f.repair();
  assert.equal(existsSync(receipt), false);
});

test('a failed restart restores the prior automatic-update receipt too', async (t) => {
  const f = fixture(t);
  const receipt = join(f.root, 'data/worker-update.json');
  mkdirSync(dirname(receipt));
  const previous = JSON.stringify({ state: 'complete', version: 'old' });
  writeFileSync(receipt, previous);
  f.options.restartServices = ({ rollback }) => {
    if (!rollback) throw new Error('restart failed');
    assert.equal(readFileSync(receipt, 'utf8'), previous);
  };
  await assert.rejects(f.repair(), /previous worker build was restored/);
  assert.equal(readFileSync(receipt, 'utf8'), previous);
});

test('Mac repair does not re-sign the running supervisor while staging a new worker', async (t) => {
  const f = fixture(t, { mac: true });
  const seals = [];
  f.options.seal = (_app, options) => seals.push(options);
  await f.repair();
  assert.deepEqual(seals, [{ signSupervisor: false }]);
});

for (const fail of [false, true])
  test(`full repair ${fail ? 'restores' : 'clears'} an installed code pointer`, async (t) => {
    const f = fixture(t);
    const { installCodeBundle, readCurrentBundle } = await import('./code-bundle.mjs');
    const bytes = Buffer.from('module.exports = () => {};');
    const pointer = installCodeBundle({
      agentDir: f.root,
      version: 'code-before-repair',
      bytes,
      sha256: digest(bytes),
      size: bytes.length,
      launcherProtocol: 1,
      executableProtocol: 1,
    });
    f.options.restartServices = ({ rollback }) => {
      if (rollback) return;
      assert.equal(readCurrentBundle(f.root), null);
      if (fail) throw new Error('restart failed');
    };
    if (fail) await assert.rejects(f.repair(), /restart failed/);
    else await f.repair();
    assert.deepEqual(readCurrentBundle(f.root), fail ? pointer : null);
  });
