import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AppWorker } from '../src/app-worker.mjs';
import { render } from '../src/views.mjs';
import { trayModel } from '../src/model.mjs';
import { runBounded } from '../../bin/bounded-command.mjs';

const origin = 'https://deploy.local';
const config = {
  coordinatorUrl: origin,
  nodeId: 'node_imac',
  name: 'iMac',
  secret: 'private-secret',
  roles: { deploy: true },
};
const bytes = Buffer.from('verified worker build');
const manifest = {
  version: '2.0.0',
  commit: 'abc',
  targets: {
    'darwin-x64': { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  },
};
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = () => ({ status: 1, stdout: '', stderr: 'fake failure' });
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'app-worker-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const calls = [],
    requests = [],
    progress = [],
    sleeps = [];
  const flags = {
    loaded: false,
    running: false,
    docker: true,
    context: 'colima',
    offline: false,
    now: 0,
    ...options,
  };
  const put = async (path, content) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  };
  const client = {
    origin,
    request: async (path, request) => {
      requests.push([path, request]);
      if (flags.offline) throw new Error('unreachable');
      if (path === '/cli/version') return manifest;
      if (path === '/api/computers/enrollment') return { code: 'JOIN-CODE' };
      if (path === origin + '/api/agent/enroll') return { ...config };
      if (path === '/api/live')
        return {
          computers: [
            {
              id: config.nodeId,
              apps: [
                { appId: 'forma', name: 'forma', address: 'https://forma.local', state: 'healthy' },
              ],
            },
          ],
        };
      if (path === '/api/computers')
        return {
          computers: [
            {
              id: config.nodeId,
              nodeId: config.nodeId,
              name: 'iMac',
              online: flags.computerOnline !== false,
              roles: ['run-apps'],
              workerIds: [],
            },
          ],
        };
      if (path === '/api/computers/node_imac') return {};
      throw new Error('Unexpected request: ' + path);
    },
    download: async (path, destination, opts) => {
      requests.push([path, opts]);
      await writeFile(destination, flags.corrupt ? 'corrupt' : bytes);
    },
  };
  const run = async (command, args, opts) => {
    calls.push({ command, args, opts });
    if (flags.override) {
      const result = await flags.override(command, args, opts);
      if (result) return result;
    }
    if (command.endsWith('/launchctl')) {
      if (args[0] === 'print') {
        if (args[1].startsWith('system/'))
          return flags.systemRunning ? ok(flags.systemOutput || 'state = running') : fail();
        return flags.loaded ? ok(flags.running ? 'state = running' : 'state = waiting') : fail();
      }
      if (args[0] === 'bootout') {
        flags.loaded = false;
        flags.running = false;
      }
      if (args[0] === 'bootstrap' || args[0] === 'kickstart') {
        flags.loaded = true;
        flags.running = true;
      }
      return ok();
    }
    if (command === '/fake/docker')
      return args[0] === 'context' ? ok(flags.context) : flags.docker ? ok('27') : fail();
    if (
      command.endsWith('/codesign') ||
      command === '/fake/colima' ||
      command.endsWith('/osascript')
    )
      return ok();
    if (args[0] === 'version')
      return ok(
        JSON.stringify({
          version:
            flags.supervisorVersion && command.endsWith('-supervisor')
              ? flags.supervisorVersion
              : '2.0.0',
          commit: 'abc',
          launcherProtocol:
            flags.legacySupervisor &&
            command.endsWith('-supervisor') &&
            (await readFile(command, 'utf8')) === 'old supervisor'
              ? undefined
              : 1,
        }),
      );
    throw new Error('Unexpected command: ' + command);
  };
  const manager = new AppWorker({
    client,
    home,
    uid: 501,
    platform: 'darwin',
    arch: 'x64',
    darwinRelease: flags.darwinRelease || '22.0',
    waitReady: async () => {},
    name: 'iMac',
    run,
    systemFile: join(home, 'system/sh.deploy.agent.plist'),
    now: () => flags.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onProgress: (message) => progress.push(message),
  });
  manager.executable = async (name) =>
    flags.noDocker && name === 'docker' ? null : '/fake/' + name;
  const seed = async ({ current = false, legacy = false } = {}) => {
    await put(manager.configPath, JSON.stringify(config));
    await put(
      join(manager.root, 'data/relays.json'),
      JSON.stringify({ forma: { relayPort: 18342, localPort: 3017 } }),
    );
    if (current) {
      await put(manager.paths.executable, bytes);
      await put(manager.paths.supervisor, bytes);
      await put(manager.plist, `<plist>${manager.paths.supervisor} ${manager.configPath}</plist>`);
    }
    if (legacy) await put(manager.plist, '<plist>/old/deploy agent run</plist>');
    flags.loaded = true;
    flags.running = true;
  };
  return { manager, calls, requests, progress, sleeps, flags, seed, put, home };
}

test('detect none / command-line / desktop / leftover and no credentials in results', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.manager.detect()).install, 'none');
  await f.seed();
  assert.equal((await f.manager.detect()).install, 'command-line');
  await f.manager.mark();
  assert.equal((await f.manager.detect()).install, 'desktop');
  await f.put(f.manager.systemFile, 'leftover');
  const detected = await f.manager.detect();
  assert.deepEqual(detected.leftover, [{ path: f.manager.systemFile, needsPassword: true }]);
  assert.equal(JSON.stringify(detected).includes(config.secret), false);
  // With no worker of this user's running, a steady all-users worker is the one in use.
  f.flags.loaded = false;
  f.flags.running = false;
  f.flags.systemRunning = true;
  assert.deepEqual((await f.manager.detect()).leftover, []);
  await assert.rejects(f.manager.takeOver(), /all-users worker is still running/);
  assert.equal(
    f.calls.some((c) => c.args[0] === 'bootout'),
    false,
  );
});

test('detect never claims another coordinator; install never overwrites its enrollment', async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.put(
    f.manager.configPath,
    JSON.stringify({ ...config, coordinatorUrl: 'https://elsewhere.local' }),
  );
  assert.equal((await f.manager.detect()).install, 'none');
  await assert.rejects(f.manager.install(), /already has a worker/);
  await assert.rejects(f.manager.repair(), /No worker for this coordinator/);
  assert.equal(f.requests.length, 0);
});

test('install uses owner join code API, shared redemption, verified download and one login service', async (t) => {
  const f = await fixture(t);
  const result = await f.manager.install();
  assert.equal(result.install, 'desktop');
  assert.equal(result.service.running, true);
  assert.deepEqual(f.requests[0], [
    '/api/computers/enrollment',
    { method: 'POST', body: { name: 'iMac' } },
  ]);
  const redemption = f.requests.find(([path]) => path.endsWith('/api/agent/enroll'));
  assert.equal(redemption[1].body.code, 'JOIN-CODE');
  assert.deepEqual(redemption[1].body.roles, {
    deploy: true,
    tasks: false,
    computer: false,
    browser: false,
  });
  assert.equal(JSON.parse(await readFile(f.manager.configPath)).nodeId, config.nodeId);
  assert.ok(f.requests.some(([path]) => path === '/cli?os=darwin&arch=x64&version=2.0.0'));
  assert.equal(f.calls.filter((c) => c.args[0] === 'bootstrap').length, 1);
  assert.equal(
    f.calls.some((c) => c.command === 'deploy' || c.args[0] === 'bootout'),
    false,
  );
  assert.match(await readFile(f.manager.plist, 'utf8'), /DEPLOY_DATA_DIR/);
});

test('take-over of current build preserves enrollment, ports and a running service without restart', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  const original = await readFile(f.manager.configPath);
  const relays = await readFile(join(f.manager.root, 'data/relays.json'));
  const result = await f.manager.takeOver();
  assert.equal(result.nodeId, config.nodeId);
  assert.deepEqual(await readFile(f.manager.configPath), original);
  assert.deepEqual(await readFile(join(f.manager.root, 'data/relays.json')), relays);
  assert.equal(
    f.requests.some(([path]) => path.includes('enroll')),
    false,
  );
  assert.equal(
    f.calls.some((c) => ['bootout', 'bootstrap', 'kickstart'].includes(c.args[0])),
    false,
  );
});

test('take-over of old program attempts a start immediately after stopping, preserves relay bytes', async (t) => {
  const f = await fixture(t);
  await f.seed({ legacy: true });
  await f.manager.takeOver();
  const commands = f.calls.filter((c) => c.command.endsWith('/launchctl')).map((c) => c.args[0]);
  assert.equal(commands[commands.indexOf('bootout') + 1], 'bootstrap');
  assert.ok(commands.includes('kickstart'));
  assert.match(await readFile(join(f.manager.root, 'data/relays.json'), 'utf8'), /18342/);
});

test('repair verifies checksum before executing, retains enrollment after failure and reuses it on retry', async (t) => {
  const f = await fixture(t, { corrupt: true });
  await assert.rejects(f.manager.install(), /checksum or size mismatch/);
  await access(f.manager.configPath);
  assert.equal(
    f.calls.some((c) => c.args[0] === 'version' || c.args[0] === 'bootout'),
    false,
  );
  assert.equal((await f.manager.detect()).install, 'command-line');
  f.flags.corrupt = false;
  await f.manager.repair();
  assert.equal(f.requests.filter(([path]) => path === '/api/computers/enrollment').length, 1);
  assert.equal((await f.manager.detect()).install, 'desktop');
});

test('failed service replacement restores the previous plist and immediately starts it', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true, legacy: true });
  // Force a build change and fail all starts until ensureWorkerBuild restores the old plist.
  await f.put(f.manager.paths.executable, 'older build');
  const original = await readFile(f.manager.plist);
  f.flags.override = async (command, args) => {
    if (command.endsWith('/launchctl') && ['bootstrap', 'kickstart'].includes(args[0])) {
      if (!(await readFile(f.manager.plist)).equals(original)) return fail();
    }
  };
  await assert.rejects(f.manager.repair(), /previous worker build was restored/);
  assert.equal(f.flags.running, true);
  assert.deepEqual(await readFile(f.manager.plist), original);
  assert.equal(await readFile(f.manager.paths.executable, 'utf8'), 'older build');
  assert.match(await readFile(join(f.manager.root, 'data/relays.json'), 'utf8'), /18342/);
});

test('Colima restart reports progress, uses long limits and retries first failed start after 5 seconds', async (t) => {
  const f = await fixture(t);
  let starts = 0;
  f.flags.override = (command, args) =>
    command === '/fake/colima' && args[0] === 'start' && ++starts === 1 ? fail() : undefined;
  await f.manager.restartDocker();
  const calls = f.calls.filter((c) => c.command === '/fake/colima');
  assert.deepEqual(
    calls.map((c) => c.args),
    [['stop', '--force'], ['start'], ['start']],
  );
  assert.deepEqual(
    calls.map((c) => c.opts.timeoutMs),
    [60000, 180000, 180000],
  );
  assert.deepEqual(f.sleeps, [5000]);
  assert.ok(f.progress.includes('Starting Colima again…'));
  f.flags.context = 'desktop-linux';
  await assert.rejects(f.manager.restartDocker(), /restarted by hand/);
  assert.equal(f.calls.filter((c) => c.command === '/fake/colima').length, 3);
});

test('hung command is killed without blocking and a timed-out Colima stop still attempts start', async (t) => {
  let killed;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = (signal) => {
    killed = signal;
  };
  const result = await runBounded('/fake/hung', [], { timeoutMs: 5, start: () => child });
  assert.equal(result.timedOut, true);
  assert.equal(killed, 'SIGKILL');
  const f = await fixture(t);
  f.flags.override = (command, args) =>
    command === '/fake/colima' && args[0] === 'stop' ? result : undefined;
  await f.manager.restartDocker();
  assert.ok(f.calls.some((c) => c.command === '/fake/colima' && c.args[0] === 'start'));
});

test('status uses local node identity, caches probes for 15 seconds and derives all four states', async (t) => {
  const f = await fixture(t);
  await f.seed();
  assert.equal((await f.manager.status()).state, 'running');
  const count = f.calls.length;
  await f.manager.status();
  assert.equal(f.calls.length, count);
  f.flags.docker = false;
  f.flags.now = 15001;
  assert.equal((await f.manager.status()).state, 'docker-not-answering');
  f.flags.now += 120000;
  assert.equal(
    (await f.manager.status()).sentence,
    'Docker on this Mac has not answered for 2 min',
  );
  f.flags.running = false;
  assert.equal((await f.manager.status(true)).state, 'service-stopped');
  f.flags.offline = true;
  const status = await f.manager.status(true);
  assert.equal(status.state, 'cannot-reach-coordinator');
  assert.equal(status.apps[0].name, 'forma');
  assert.equal(JSON.stringify(status).includes(config.secret), false);
});

test('leftover removal rejects arbitrary paths and active primary services before any administrator command', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  await f.manager.mark();
  for (const path of [f.manager.plist, f.manager.configPath, '/tmp/injected; rm -rf /'])
    await assert.rejects(f.manager.removeLeftover(path), /Only the unused/);
  assert.equal(
    f.calls.some((c) => c.command.endsWith('/osascript')),
    false,
  );
  // Only the filesystem observation is faked; the actual fixed-path guard and AppleScript run.
  f.manager.systemFile = '/Library/LaunchDaemons/sh.deploy.agent.plist';
  f.manager.detect = async () => ({
    install: 'desktop',
    service: { running: true },
    leftover: [{ path: f.manager.systemFile, needsPassword: true }],
  });
  f.manager.status = async () => ({});
  await f.manager.removeLeftover(f.manager.systemFile);
  const calls = f.calls.filter((c) => c.command.endsWith('/osascript'));
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /with administrator privileges/);
  assert.doesNotMatch(calls[0].args[1], /agent.json|relays.json/);
});

test('Run apps off only changes coordinator admission, preserves other roles and never stops service', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  await f.manager.mark();
  await f.manager.setEnabled(false);
  assert.deepEqual(f.requests.find(([path]) => path === '/api/computers/node_imac')[1], {
    method: 'PATCH',
    body: { roles: [] },
  });
  assert.equal(
    f.calls.some((c) => ['bootout', 'kickstart'].includes(c.args[0])),
    false,
  );
});

test('unsupported systems do not inspect or start any service', async (t) => {
  const f = await fixture(t);
  for (const platform of ['linux', 'win32']) {
    f.manager.platform = platform;
    assert.equal((await f.manager.detect()).supported, false);
    await assert.rejects(f.manager.install(), /not supported here yet/);
  }
  assert.equal(f.calls.length, 0);
});

const setupState = {
  page: 'setup',
  platform: 'darwin',
  arch: 'x64',
  name: 'iMac',
  origin,
  coordinatorName: 'SER',
  roles: { runApps: true },
  appWorker: {
    install: 'desktop',
    name: 'iMac',
    enabled: true,
    state: 'running',
    sentence: 'Docker is answering',
    docker: { found: true, answering: true, runtime: 'colima' },
    apps: [{ name: 'forma', address: 'https://forma.local', state: 'healthy' }],
    computer: { online: true },
    leftover: [],
  },
};
test('SetupRunApps and SetupTakeOver use approved copy, truthful Docker states and separate leftover removal', () => {
  const html = render(setupState);
  for (const text of [
    'Colima is running on this Mac',
    'They keep running when you quit this app and start again after a restart.',
    'This app installs the worker and looks after it',
    'Use the screen is not supported in this Intel build yet.',
  ])
    assert.ok(html.includes(text));
  assert.match(html, /name="runApps"[^>]*checked/);
  const absent = render({ ...setupState, appWorker: { docker: { found: false } } });
  assert.match(absent, /Install Docker on this Mac/);
  assert.match(absent, /name="runApps"[^>]*disabled/);
  assert.doesNotMatch(absent, /name="runApps"[^>]*checked/);
  const local = {
    ...setupState.appWorker,
    install: 'command-line',
    leftover: [{ path: '/Library/LaunchDaemons/sh.deploy.agent.plist', needsPassword: true }],
  };
  const takeover = render({ ...setupState, page: 'takeover', appWorker: local });
  for (const text of [
    'already helps, from the command line',
    'forma',
    'keeps answering during the move',
    'Nothing changes until you choose.',
    'Leave it as it is',
    'Move it to this app',
    '/Library/LaunchDaemons/sh.deploy.agent.plist',
  ])
    assert.ok(takeover.includes(text));
  assert.doesNotMatch(takeover, /value="remove-leftover"/);
  assert.match(
    render({ ...setupState, appWorker: { ...local, install: 'desktop' } }),
    /value="remove-leftover"/,
  );
});

test('TrayRunsApps and TrayNeedsRepair preserve board content and show a local failure dot without inventing decisions', () => {
  const state = { ...setupState, page: 'tray', online: true };
  const html = render(state);
  for (const text of [
    'Running 1 app',
    'forma · healthy',
    'Run apps',
    'Docker is answering',
    'Apps keep running. Tasks wait until you open the app again.',
  ])
    assert.ok(html.includes(text));
  assert.doesNotMatch(html, /Take new tasks|Repair the worker/);
  const failing = {
    ...state,
    appWorker: {
      ...state.appWorker,
      state: 'docker-not-answering',
      sentence: 'Docker on this Mac has not answered for 2 min',
    },
  };
  const repair = render(failing);
  for (const text of [
    'forma is not answering',
    'Docker on this Mac has not answered for 2 min',
    'Restart Docker',
    'Stops and starts Colima. forma comes back by itself.',
    'Repair the worker',
    'Installs it again from SER. Apps and addresses stay.',
  ])
    assert.ok(repair.includes(text));
  assert.equal(trayModel({ ...failing, online: false }).icon, 'failing');
  assert.equal(trayModel(failing).count, 0);
  assert.doesNotMatch(
    render({ ...failing, appWorker: { ...failing.appWorker, state: 'service-stopped' } }),
    /Restart Docker/,
  );
});

test('the desktop can reach the coordinator while its service cannot; that is not healthy', async (t) => {
  const f = await fixture(t, { computerOnline: false });
  await f.seed({ current: true });
  assert.equal((await f.manager.status()).state, 'cannot-reach-coordinator');
});

test('app-worker bundles shared install modules for the packaged app without repository-relative imports', async () => {
  const { build } = createRequire(import.meta.resolve('vite'))('esbuild');
  const result = await build({
    entryPoints: [new URL('../src/app-worker.mjs', import.meta.url).pathname],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  });
  assert.match(result.outputFiles[0].text, /ensureWorkerBuild/);
  assert.doesNotMatch(result.outputFiles[0].text, /from ["']\.\.\/\.\.\/bin\//);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  assert.ok(pkg.build.files.includes('build/app-worker.mjs'));
  assert.match(pkg.scripts['package:mac:x64'], /--mac --x64 --dir/);
});

test('repair replaces a broken supervisor atomically and restarts the loaded service', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  await f.put(f.manager.paths.supervisor, 'broken supervisor');
  f.flags.override = async (command, args) =>
    command === f.manager.paths.supervisor &&
    args[0] === 'version' &&
    (await readFile(command, 'utf8')) === 'broken supervisor'
      ? fail()
      : undefined;
  await f.manager.repair();
  assert.deepEqual(await readFile(f.manager.paths.supervisor), bytes);
  assert.equal(f.calls.filter((c) => c.args[0] === 'kickstart').length, 1);
  assert.equal(
    f.calls.some((c) => c.args[0] === 'bootout'),
    false,
  );
});

test('a system-wide copy that keeps failing beside a healthy worker is a leftover, not a blocker', async (t) => {
  const f = await fixture(t);
  await f.seed();
  f.flags.loaded = true;
  f.flags.running = true;
  await f.put(f.manager.systemFile, 'leftover');
  f.flags.systemRunning = true;
  // What launchd prints between two failed starts of a copy whose folder is gone.
  f.flags.systemOutput =
    '\tstate = running\n\tprogram = /usr/local/bin/deploy\n\truns = 18402\n\tpid = 75171\n\tlast exit code = 2\n';
  const detected = await f.manager.detect();
  assert.equal(detected.install, 'command-line');
  assert.deepEqual(detected.leftover, [{ path: f.manager.systemFile, needsPassword: true }]);
  // Steady and alone, a system-wide worker is the one in use and still blocks a move.
  f.flags.loaded = false;
  f.flags.running = false;
  f.flags.systemOutput = '\tstate = running\n\truns = 1\n\tlast exit code = (never exited)\n';
  assert.deepEqual((await f.manager.detect()).leftover, []);
  await assert.rejects(f.manager.takeOver(), /all-users worker is still running/);
});

test('a kept supervisor older than the worker is told which version to expect, and restarted once', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  // The night this was found: supervisor 7427f45 kept, worker replaced by 87c956e, no update
  // record. The supervisor then replaced the worker every 60 seconds.
  f.flags.supervisorVersion = '1.9.0';
  await f.manager.takeOver();
  const record = JSON.parse(
    await readFile(join(f.manager.root, 'data/worker-update.json'), 'utf8'),
  );
  assert.equal(record.state, 'complete');
  assert.equal(record.version, '2.0.0');
  assert.ok(f.calls.some((c) => c.args[0] === 'kickstart'));
  // Once they agree, another repair neither rewrites the record nor restarts the worker.
  f.calls.length = 0;
  await f.manager.repair();
  assert.equal(
    f.calls.some((c) => ['kickstart', 'bootout'].includes(c.args[0])),
    false,
  );
});

test('the task row is about tasks: apps this computer runs are not repeated as items', async () => {
  const { render } = await import('../src/views.mjs');
  const html = render({
    page: 'tray',
    platform: 'darwin',
    online: true,
    name: 'imac',
    worker: { state: 'Ready for tasks', roles: { takeTasks: true } },
    appWorker: {
      install: 'desktop',
      state: 'running',
      apps: [{ name: 'forma', state: 'healthy' }],
      docker: { runtime: 'colima', answering: true },
    },
    tray: {
      inbox: [],
      live: { summary: { running: 1 }, computers: [] },
      computers: [
        {
          id: 'n',
          name: 'imac',
          online: true,
          roles: ['run-apps', 'take-tasks'],
          doing: [{ id: 'forma', kind: 'app', name: 'forma', state: 'running' }],
        },
      ],
    },
  });
  assert.match(html, /Running 1 app/);
  assert.doesNotMatch(html, /items/);
  assert.match(html, /Ready for tasks/);
});

test('a stopped Colima is still Colima: Docker falls back to its default context', async (t) => {
  const f = await fixture(t);
  await f.seed({ current: true });
  f.flags.context = 'default';
  f.flags.docker = false;
  assert.equal((await f.manager.docker()).runtime, 'other');
  await f.put(join(f.home, '.colima/default/colima.yaml'), 'vmType: vz\n');
  const docker = await f.manager.docker();
  assert.equal(docker.runtime, 'colima');
  assert.equal(docker.answering, false);
  await f.manager.restartDocker();
  assert.ok(f.calls.some((c) => c.command === '/fake/colima' && c.args[0] === 'start'));
});

test('macOS 15 reports the existing Repair state, and Repair replaces only a non-capable supervisor', async (t) => {
  const f = await fixture(t, { darwinRelease: '24.0', legacySupervisor: true });
  await f.seed({ current: true });
  await f.put(f.manager.paths.supervisor, 'old supervisor');
  await f.manager.mark();
  assert.equal((await f.manager.status(true)).state, 'needs-repair');
  assert.match(
    render({ ...setupState, page: 'tray', online: true, appWorker: await f.manager.status() }),
    /Repair the worker/,
  );
  await f.manager.repair();
  assert.deepEqual(await readFile(f.manager.paths.supervisor), bytes);
  assert.equal(await readFile(f.manager.paths.supervisor + '.previous', 'utf8'), 'old supervisor');
  assert.equal((await f.manager.status(true)).state, 'running');
  assert.equal(f.calls.filter((c) => c.args[0] === 'kickstart').length, 1);
  f.calls.length = 0;
  await f.manager.repair();
  assert.equal(
    f.calls.some((c) => c.args.includes('--identifier') || c.args[0] === 'kickstart'),
    false,
  );
});
