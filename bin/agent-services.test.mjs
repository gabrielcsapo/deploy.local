import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  servicePlan,
  assertAgentJobAllowed,
  removeAgentDockerObjects,
  workerExecutablePaths,
  supervisedExecutable,
  serviceProgramArguments,
  linkWorkerSupervisor,
  sealWorkerBundle,
  removeBareWorkers,
  workerAppPath,
  workerAppInfoPlist,
  moveClashingWorker,
  restartWorkerService,
  workerRoot,
  servicePath,
  workerPlist,
  workerUnit,
  workerServiceFile,
} from './agent-services.mjs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  existsSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { installWorkerBuild } from './worker-update.mjs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkerConfig, enableWorkerTlsTrust } from './worker-runtime.mjs';
import { joinAgent, readAgentConfig } from './agent-enrollment.mjs';

const roles = { deploy: false, tasks: false, computer: false, browser: false };
test('every role combination installs the agent for apps or updates, and the task worker for tasks', () => {
  for (let mask = 0; mask < 16; mask++) {
    const selected = Object.fromEntries(
      Object.keys(roles).map((role, index) => [role, !!(mask & (1 << index))]),
    );
    assert.deepEqual(servicePlan(selected), {
      agent: selected.deploy || selected.tasks,
      worker: selected.tasks,
      apps: selected.deploy,
    });
  }
  assert.deepEqual(servicePlan({ ...roles, tasks: true }), {
    agent: true,
    worker: true,
    apps: false,
  });
  assert.deepEqual(servicePlan(undefined), { agent: true, worker: false, apps: true });
});
test('with Deploy apps off the agent refuses every job except its own update', () => {
  const tasksOnly = { ...roles, tasks: true };
  for (const type of ['deploy', 'project-release', 'restart', 'logs', 'backup', 'delete', 'x'])
    assert.throws(
      () => assertAgentJobAllowed({ type }, tasksOnly),
      /^Error: Deploy apps is off on this computer\.$/,
    );
  assert.doesNotThrow(() => assertAgentJobAllowed({ type: 'self-update' }, tasksOnly));
  for (const allowed of [{ ...roles, deploy: true }, undefined])
    assert.doesNotThrow(() => assertAgentJobAllowed({ type: 'deploy' }, allowed));
});
function agentDirectory(files = [], directories = []) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-dir-'));
  for (const name of directories) mkdirSync(join(dir, name));
  for (const name of files) writeFileSync(join(dir, name), name, { mode: 0o755 });
  return dir;
}
const linux = { platform: 'linux' };
test('worker executable uses a name that never clashes with the task state directory', () => {
  const cases = [
    [[], [], 'deploy-worker'],
    [['worker'], [], 'worker'], // older Linux install
    [[], ['worker'], 'deploy-worker'], // macOS task worker state, never an executable
    [['deploy-worker', 'worker'], [], 'deploy-worker'],
    [['deploy-worker'], ['worker'], 'deploy-worker'],
  ];
  for (const [files, directories, expected] of cases) {
    const dir = agentDirectory(files, directories);
    try {
      assert.deepEqual(workerExecutablePaths(dir, linux), {
        app: null,
        executable: join(dir, expected),
        supervisor: join(dir, `${expected}-supervisor`),
        previous: join(dir, `${expected}.previous`),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test('on Linux only a supervisor link with a worker build beside it supervises', () => {
  const dir = agentDirectory(['deploy-worker', 'deploy-worker-supervisor'], ['worker']);
  try {
    assert.equal(
      supervisedExecutable(join(dir, 'deploy-worker-supervisor'), dir, linux),
      join(dir, 'deploy-worker'),
    );
    writeFileSync(join(dir, 'worker-supervisor'), '');
    assert.equal(supervisedExecutable(join(dir, 'worker-supervisor'), dir, linux), null);
    assert.equal(supervisedExecutable(join(dir, 'deploy-worker'), dir, linux), null);
    assert.equal(supervisedExecutable('/usr/local/bin/deploy', dir, linux), null);
    rmSync(join(dir, 'worker'), { recursive: true });
    writeFileSync(join(dir, 'worker'), '');
    assert.equal(
      supervisedExecutable(join(dir, 'worker-supervisor'), dir, linux),
      join(dir, 'worker'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('on Linux the task worker service runs the swappable build, the agent the supervisor', () => {
  const self = ['/opt/homebrew/bin/node', '/repo/bin/deploy.js'];
  const dir = agentDirectory(['deploy-worker', 'deploy-worker-supervisor'], ['worker']);
  try {
    const args = serviceProgramArguments({ agentDir: dir, self, ...linux });
    assert.deepEqual(args, {
      agent: [join(dir, 'deploy-worker-supervisor')],
      worker: [join(dir, 'deploy-worker')],
    });
    const plist = workerPlist({ ...options, args: [...args.worker, 'worker', 'run'] });
    assert.match(
      plist,
      /<key>ProgramArguments<\/key><array><string>[^<]*\/deploy-worker<\/string><string>worker<\/string><string>run<\/string><\/array>/,
    );
    assert.doesNotMatch(plist, /supervisor/);
    rmSync(join(dir, 'deploy-worker-supervisor'));
    assert.deepEqual(serviceProgramArguments({ agentDir: dir, self, ...linux }), {
      agent: [join(dir, 'deploy-worker')],
      worker: [join(dir, 'deploy-worker')],
    });
    rmSync(join(dir, 'deploy-worker'));
    assert.deepEqual(serviceProgramArguments({ agentDir: dir, self, ...linux }), {
      agent: self,
      worker: self,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('on Linux installing links the supervisor to the current build without touching it otherwise', () => {
  const dir = agentDirectory(['deploy-worker'], ['worker']);
  try {
    const executable = join(dir, 'deploy-worker');
    const supervisor = linkWorkerSupervisor(dir, linux);
    assert.equal(supervisor, join(dir, 'deploy-worker-supervisor'));
    assert.equal(statSync(supervisor).ino, statSync(executable).ino);
    // An update swaps in a new inode; the next install moves the supervisor to it.
    rmSync(executable);
    writeFileSync(executable, 'new', { mode: 0o755 });
    assert.notEqual(statSync(supervisor).ino, statSync(executable).ino);
    linkWorkerSupervisor(dir, linux);
    assert.equal(statSync(supervisor).ino, statSync(executable).ino);
    assert.equal(readFileSync(supervisor, 'utf8'), 'new');
    const empty = agentDirectory([], ['worker']);
    assert.equal(linkWorkerSupervisor(empty, linux), null);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('a Mac build at the task state path moves to the new name; elsewhere it stays', () => {
  const dir = agentDirectory(['worker', 'worker-supervisor', 'worker.previous']);
  try {
    assert.equal(moveClashingWorker(dir, join(dir, 'elsewhere/worker')), false);
    assert.ok(existsSync(join(dir, 'worker')));
    assert.equal(moveClashingWorker(dir, join(dir, 'worker')), true);
    for (const [name, content] of [
      ['deploy-worker', 'worker'],
      ['deploy-worker-supervisor', 'worker-supervisor'],
      ['deploy-worker.previous', 'worker.previous'],
    ])
      assert.equal(readFileSync(join(dir, name), 'utf8'), content);
    assert.ok(!existsSync(join(dir, 'worker')));
    mkdirSync(join(dir, 'worker'));
    assert.equal(moveClashingWorker(dir, join(dir, 'worker')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
function macLayout() {
  const home = mkdtempSync(join(tmpdir(), 'mac-worker-'));
  const agentDir = join(home, 'Library/Application Support/deploy.local');
  const app = join(home, 'Applications/deploy.local Worker.app');
  const macos = join(app, 'Contents/MacOS');
  mkdirSync(join(agentDir, 'worker'), { recursive: true });
  mkdirSync(macos, { recursive: true });
  return { home, agentDir, app, macos, mac: { platform: 'darwin', app } };
}
test('a Mac keeps the worker in its app bundle, which an environment variable can move', () => {
  assert.equal(workerAppPath({}, '/Users/a'), '/Users/a/Applications/deploy.local Worker.app');
  assert.equal(workerAppPath({ DEPLOY_WORKER_APP: '/tmp/W.app' }, '/Users/a'), '/tmp/W.app');
  const { home, agentDir, app, macos, mac } = macLayout();
  try {
    // Bare builds from the previous install are never chosen on a Mac.
    for (const name of ['deploy-worker', 'deploy-worker-supervisor', 'worker-supervisor'])
      writeFileSync(join(agentDir, name), name);
    assert.deepEqual(workerExecutablePaths(agentDir, mac), {
      app,
      executable: join(macos, 'deploy-worker'),
      supervisor: join(macos, 'deploy-worker-supervisor'),
      previous: join(agentDir, 'deploy-worker-app.previous'),
    });
    const self = ['/usr/local/bin/deploy'];
    assert.deepEqual(serviceProgramArguments({ agentDir, self, ...mac }), {
      agent: self,
      worker: self,
    });
    writeFileSync(join(macos, 'deploy-worker'), 'build', { mode: 0o755 });
    writeFileSync(join(macos, 'deploy-worker-supervisor'), 'build', { mode: 0o755 });
    assert.deepEqual(serviceProgramArguments({ agentDir, self, ...mac }), {
      agent: [join(macos, 'deploy-worker-supervisor')],
      worker: [join(macos, 'deploy-worker')],
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('the app bundle supervisor supervises the bundle build', () => {
  const { home, agentDir, app, macos, mac } = macLayout();
  try {
    const supervisor = join(macos, 'deploy-worker-supervisor');
    writeFileSync(supervisor, '');
    assert.equal(supervisedExecutable(supervisor, agentDir, mac), null);
    writeFileSync(join(macos, 'deploy-worker'), '');
    assert.equal(supervisedExecutable(supervisor, agentDir, mac), join(macos, 'deploy-worker'));
    // launchd may name the bundle through a link; the real path still matches.
    symlinkSync(app, join(home, 'Linked.app'));
    assert.equal(
      supervisedExecutable(
        join(home, 'Linked.app/Contents/MacOS/deploy-worker-supervisor'),
        agentDir,
        mac,
      ),
      join(macos, 'deploy-worker'),
    );
    assert.equal(supervisedExecutable(join(macos, 'deploy-worker'), agentDir, mac), null);
    assert.equal(supervisedExecutable('/usr/local/bin/deploy', agentDir, mac), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
function recorder(status = () => 0) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: status(args), stderr: 'refused' };
  };
  return { calls, run };
}
test('sealing signs the supervisor with the app identifier, then the bundle, then verifies', () => {
  const { home, app, macos } = macLayout();
  try {
    const supervisor = join(macos, 'deploy-worker-supervisor');
    writeFileSync(join(macos, 'deploy-worker'), 'build');
    writeFileSync(supervisor, 'build');
    writeFileSync(join(macos, 'deploy-worker.stage-123'), 'partial');
    const { calls, run } = recorder();
    assert.equal(sealWorkerBundle(app, { run }), true);
    assert.deepEqual(calls, [
      ['codesign', '--force', '--sign', '-', '--identifier', 'local.deploy.worker', supervisor],
      ['codesign', '--force', '--sign', '-', app],
      ['codesign', '--verify', '--strict', '--deep', app],
    ]);
    assert.ok(!existsSync(join(macos, 'deploy-worker.stage-123')));
    const plist = readFileSync(join(app, 'Contents/Info.plist'), 'utf8');
    assert.equal(plist, workerAppInfoPlist());
    for (const expected of [
      '<key>CFBundleIdentifier</key><string>local.deploy.worker</string>',
      '<key>CFBundleExecutable</key><string>deploy-worker</string>',
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '<key>LSUIElement</key><true/>',
      '<key>LSMinimumSystemVersion</key><string>14.0</string>',
      '<key>CFBundleName</key><string>deploy.local Worker</string>',
      '<key>CFBundleDisplayName</key><string>deploy.local Worker</string>',
      '<key>NSLocalNetworkUsageDescription</key><string>deploy.local Worker connects to your deploy.local coordinator on this network to run coding tasks and build jobs.</string>',
    ])
      assert.ok(plist.includes(expected), expected);
    if (process.platform === 'darwin')
      assert.equal(spawnSync('plutil', ['-lint', join(app, 'Contents/Info.plist')]).status, 0);
    // An existing Info.plist is kept; a running supervisor is not re-signed.
    writeFileSync(join(app, 'Contents/Info.plist'), 'custom');
    calls.length = 0;
    sealWorkerBundle(app, { run, signSupervisor: false });
    assert.equal(readFileSync(join(app, 'Contents/Info.plist'), 'utf8'), 'custom');
    assert.deepEqual(calls, [
      ['codesign', '--force', '--sign', '-', app],
      ['codesign', '--verify', '--strict', '--deep', app],
    ]);
    // ifNeeded leaves a bundle that already verifies alone.
    calls.length = 0;
    assert.equal(sealWorkerBundle(app, { run, ifNeeded: true }), false);
    assert.deepEqual(calls, [['codesign', '--verify', '--strict', '--deep', app]]);
    const failing = recorder((args) => (args[0] === '--verify' ? 1 : 0));
    assert.throws(
      () => sealWorkerBundle(app, { run: failing.run }),
      /Worker app verification failed\. refused/,
    );
    assert.equal(failing.calls.length, 3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('on a Mac installing gives the supervisor a signed copy, never a hard link', () => {
  const { home, agentDir, app, macos, mac } = macLayout();
  try {
    const { calls, run } = recorder();
    assert.equal(linkWorkerSupervisor(agentDir, { ...mac, run }), null);
    assert.deepEqual(calls, []);
    const executable = join(macos, 'deploy-worker'),
      supervisor = join(macos, 'deploy-worker-supervisor');
    writeFileSync(executable, 'build-1', { mode: 0o755 });
    writeFileSync(supervisor, 'stale');
    assert.equal(linkWorkerSupervisor(agentDir, { ...mac, run }), supervisor);
    assert.equal(readFileSync(supervisor, 'utf8'), 'build-1');
    assert.notEqual(statSync(supervisor).ino, statSync(executable).ino);
    assert.equal(statSync(supervisor).mode & 0o777, 0o755);
    assert.deepEqual(
      calls.map((call) => call.slice(1, -1).join(' ')),
      [
        '--force --sign - --identifier local.deploy.worker',
        '--force --sign -',
        '--verify --strict --deep',
      ],
    );
    assert.deepEqual(
      calls.map((call) => call.at(-1)),
      [supervisor, app, app],
    );
    assert.deepEqual(readdirSync(macos).sort(), ['deploy-worker', 'deploy-worker-supervisor']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('a Mac install removes the bare builds the previous install left beside agent.json', () => {
  const { home, agentDir } = macLayout();
  try {
    for (const name of ['deploy-worker', 'deploy-worker-supervisor', 'deploy-worker.previous'])
      writeFileSync(join(agentDir, name), name);
    writeFileSync(join(agentDir, 'agent.json'), '{}');
    assert.deepEqual(removeBareWorkers(agentDir), [
      'deploy-worker',
      'deploy-worker-supervisor',
      'deploy-worker.previous',
    ]);
    // The task state directory and everything else stay.
    assert.deepEqual(readdirSync(agentDir).sort(), ['agent.json', 'worker']);
    rmSync(join(agentDir, 'worker'), { recursive: true });
    writeFileSync(join(agentDir, 'worker'), 'old build');
    writeFileSync(join(agentDir, 'worker-supervisor'), 'old build');
    assert.deepEqual(removeBareWorkers(agentDir), ['worker', 'worker-supervisor']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('an update keeps the replaced build outside the app bundle', () => {
  const { home, agentDir, macos } = macLayout();
  try {
    const path = join(macos, 'deploy-worker'),
      previous = join(agentDir, 'deploy-worker-app.previous');
    writeFileSync(path, 'old', { mode: 0o755 });
    const bytes = Buffer.from('new');
    installWorkerBuild({
      path,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length,
      version: '2',
      previous,
      platform: 'linux',
      probe: () => {},
    });
    assert.equal(readFileSync(path, 'utf8'), 'new');
    assert.equal(readFileSync(previous, 'utf8'), 'old');
    assert.deepEqual(readdirSync(macos), ['deploy-worker']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
test('after an update the task worker service restarts on the new build', () => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status: 0 };
  };
  const exists = () => true;
  assert.equal(
    restartWorkerService({ platform: 'darwin', user: { uid: 501, home: '/Users/a' }, exists, run }),
    true,
  );
  assert.equal(
    restartWorkerService({ platform: 'linux', user: { uid: 1000, home: '/home/a' }, exists, run }),
    true,
  );
  // The Linux execution agent is a root system service; it restarts the login user's unit.
  restartWorkerService({
    platform: 'linux',
    user: { uid: 1000, name: 'a', home: '/home/a' },
    exists,
    run,
  });
  assert.deepEqual(calls, [
    ['launchctl', 'kickstart', '-k', 'gui/501/sh.deploy.worker'],
    ['systemctl', '--user', 'restart', 'deploy-local-worker.service'],
    [
      'sudo',
      '-u',
      'a',
      'env',
      'XDG_RUNTIME_DIR=/run/user/1000',
      'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
      'systemctl',
      '--user',
      'restart',
      'deploy-local-worker.service',
    ],
  ]);
  calls.length = 0;
  const checked = [];
  assert.equal(
    restartWorkerService({
      platform: 'darwin',
      user: { uid: 501, home: '/Users/a' },
      exists: (file) => (checked.push(file), false),
      run,
    }),
    false,
  );
  assert.deepEqual(checked, ['/Users/a/Library/LaunchAgents/sh.deploy.worker.plist']);
  assert.deepEqual(calls, []);
  assert.throws(
    () =>
      restartWorkerService({
        platform: 'darwin',
        user: { uid: 501, home: '/Users/a' },
        exists,
        run: () => ({ status: 1, stderr: 'no such service' }),
      }),
    /Task worker restart failed\. no such service/,
  );
});
const root = '/Users/A & B/worker',
  configPath = '/Users/A & B/agent.json';
const path = servicePath(
  ['/Users/A & B/.tools/codex', '/Users/A & B/.providers/claude'],
  '/custom/bin:relative:',
  '/Users/A & B',
);
const options = {
  args: ['/Applications/A & B/deploy', 'worker', 'run'],
  root,
  configPath,
  logPath: '/Users/A & B/worker.log',
  path,
};
test('launchd worker is persistent, escapes XML, includes tools PATH, config and combined log', () => {
  const plist = workerPlist(options);
  assert.match(plist, /sh.deploy.worker/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  // Without it launchd throttles CPU and I/O, and jobs run several times slower.
  assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
  assert.match(plist, /A &amp; B/);
  assert.doesNotMatch(plist, /A & B/);
  assert.match(plist, /NODE_USE_SYSTEM_CA/);
  for (const directory of [
    '/usr/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/Users/A & B/.tools',
    '/Users/A & B/.providers',
  ])
    assert.ok(path.split(':').includes(directory));
  assert.ok(!path.split(':').includes('relative'));
  const directory = mkdtempSync(join(tmpdir(), 'worker-plist-'));
  try {
    const file = join(directory, 'worker.plist');
    writeFileSync(file, plist);
    if (process.platform === 'darwin') assert.equal(spawnSync('plutil', ['-lint', file]).status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('systemd worker is a user unit, survives failures and quotes specifiers and exec variables', () => {
  const unit = workerUnit({
    ...options,
    args: ['/home/A "B"/%tool/$deploy\\bin', 'worker', 'run'],
    root: '/home/A% B/worker',
  });
  assert.match(unit, /WantedBy=default.target/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /ExecStart="\/home\/A \\"B\\"\/%%tool\/\$\$deploy\\\\bin" "worker" "run"/);
  assert.match(unit, /WorkingDirectory="\/home\/A%% B\/worker"/);
  assert.match(unit, /Environment="PATH=/);
  assert.doesNotMatch(unit, /User=root|multi-user.target|workerToken|secret/);
  assert.equal(
    workerServiceFile({ home: '/home/owner' }, 'linux'),
    '/home/owner/.config/systemd/user/deploy-local-worker.service',
  );
  assert.equal(
    workerRoot('darwin', '/home/owner'),
    '/home/owner/Library/Application Support/deploy.local/worker',
  );
  assert.equal(workerRoot('linux', '/home/owner'), '/home/owner/.local/share/deploy.local/worker');
});
test('join saves coordinator-selected roles and worker credential even without explicit taskWorker', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'role-join-'));
  try {
    const file = join(directory, 'agent.json');
    const credential = {
      name: 'Mac',
      nodeId: 'fixture-node',
      secret: 'private-agent',
      workerId: 'fixture-worker',
      workerToken: 'private-worker',
      roles: { ...roles, tasks: true },
    };
    const config = await joinAgent({
      coordinatorUrl: 'https://deploy.local',
      code: 'fixture',
      configPath: file,
      request: async () => new Response(JSON.stringify(credential)),
    });
    assert.deepEqual(config.roles, credential.roles);
    assert.equal(readAgentConfig(file).workerToken, credential.workerToken);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadWorkerConfig(file, directory), {
      DEPLOY_COORDINATOR_URL: 'https://deploy.local',
      DEPLOY_WORKER_ID: 'fixture-worker',
      DEPLOY_WORKER_NAME: 'Mac',
      DEPLOY_WORKER_TOKEN: 'private-worker',
      DEPLOY_WORKER_ROOT: directory,
    });
    await assert.rejects(
      joinAgent({
        coordinatorUrl: 'https://deploy.local',
        code: 'fixture',
        configPath: file,
        request: async () =>
          new Response(JSON.stringify({ ...credential, workerToken: undefined })),
      }),
      /does not support/,
    );
    assert.equal(
      readAgentConfig(file).workerToken,
      credential.workerToken,
      'failed enrollment does not overwrite existing config',
    );
    writeFileSync(
      file,
      JSON.stringify({
        ...credential,
        coordinatorUrl: 'https://deploy.local',
        workerToken: undefined,
      }),
    );
    assert.throws(() => loadWorkerConfig(file), /No task-worker credential/);
    writeFileSync(file, '{broken');
    assert.throws(() => loadWorkerConfig(file), /not enrolled/);
    assert.throws(() => loadWorkerConfig(join(directory, 'missing')), /not enrolled/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('legacy enrollments remain execution-only and worker trust is inherited by tools', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'legacy-join-'));
  try {
    const file = join(directory, 'agent.json');
    const config = await joinAgent({
      coordinatorUrl: 'https://deploy.local',
      code: 'fixture',
      configPath: file,
      request: async () =>
        new Response(JSON.stringify({ name: 'Mac', nodeId: 'fixture', secret: 'private' })),
    });
    assert.deepEqual(servicePlan(config.roles), { agent: true, worker: false, apps: true });
    assert.throws(() => loadWorkerConfig(file), /No task-worker credential/);
    const env = {};
    enableWorkerTlsTrust(directory, env);
    assert.equal(env.NODE_USE_SYSTEM_CA, '1');
    for (const key of ['SSL_CERT_FILE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE'])
      assert.equal(env[key], env.NODE_EXTRA_CA_CERTS);
    assert.match(readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8'), /BEGIN CERTIFICATE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('worker run fails safely before starting without enrollment or worker credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'worker-command-'));
  try {
    const file = join(directory, 'agent.json');
    for (const config of [
      null,
      {
        coordinatorUrl: 'https://deploy.local',
        nodeId: 'fixture',
        name: 'fixture',
        secret: 'never-print-this-secret',
      },
    ]) {
      if (config) writeFileSync(file, JSON.stringify(config));
      const result = spawnSync(process.execPath, ['bin/deploy.js', 'worker', 'run'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: { ...process.env, DEPLOY_AGENT_CONFIG: file },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, config ? /No task-worker credential/ : /not enrolled/);
      assert.doesNotMatch(result.stderr + result.stdout, /never-print-this-secret/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Answers like the Docker CLI for one app's objects, so nothing here reaches a real daemon.
function fakeAgentDocker({ containers = [], networks = [], refuses = [], listingFails = false }) {
  const state = { containers: new Set(containers), networks: new Set(networks), calls: [] };
  state.docker = (args) => {
    state.calls.push(args.join(' '));
    if (args[0] === 'ps' || args[1] === 'ls') {
      if (listingFails) return { status: 1, stdout: '', stderr: 'Cannot connect to the daemon' };
      const filter = args[args.indexOf('--filter') + 1];
      const pool = args[0] === 'ps' ? state.containers : state.networks;
      const found = filter.startsWith('name=')
        ? [...pool].filter((name) => new RegExp(filter.slice(5)).test(`/${name}`))
        : filter === 'label=deploy-sh.app=web' || filter === 'label=deploy-sh.app-id=app-1'
          ? [...pool].filter((name) => name.startsWith('graph-'))
          : [];
      return { status: 0, stdout: found.map((name) => `${name}\n`).join(''), stderr: '' };
    }
    const pool = args[0] === 'rm' ? state.containers : state.networks;
    const names = args.slice(2);
    for (const name of names) if (!refuses.includes(name)) pool.delete(name);
    const refused = names.some((name) => refuses.includes(name));
    return { status: refused ? 1 : 0, stdout: '', stderr: refused ? 'has active endpoints' : '' };
  };
  return state;
}

test('removing an app from a computer takes graph and legacy containers, then networks', () => {
  const state = fakeAgentDocker({
    containers: ['graph-web-1', 'deploy-sh-web', 'deploy-sh-web-prev-1', 'deploy-sh-web2'],
    networks: ['graph-private', 'other-network'],
  });
  removeAgentDockerObjects({ deploymentName: 'web', docker: state.docker });
  assert.deepEqual([...state.containers], ['deploy-sh-web2']);
  assert.deepEqual([...state.networks], ['other-network']);
  const firstNetworkRemoval = state.calls.findIndex((call) => call.startsWith('network rm'));
  const lastContainerRemoval = state.calls.findLastIndex((call) => call.startsWith('rm -f'));
  assert.ok(lastContainerRemoval < firstNetworkRemoval);
});

test('removing an app from a computer also finds objects by application id', () => {
  const state = fakeAgentDocker({ containers: ['graph-web-1'], networks: ['graph-private'] });
  removeAgentDockerObjects({
    deploymentName: 'renamed',
    applicationId: 'app-1',
    docker: state.docker,
  });
  assert.equal(state.containers.size, 0);
  assert.equal(state.networks.size, 0);
});

test('removing an app with nothing left on the computer succeeds without removing anything', () => {
  const state = fakeAgentDocker({ containers: ['deploy-sh-web2'] });
  removeAgentDockerObjects({ deploymentName: 'web', docker: state.docker });
  assert.equal(
    state.calls.some((call) => call.startsWith('rm') || call.startsWith('network rm')),
    false,
  );
});

test('anything Docker keeps fails the removal by name', () => {
  const stuckContainer = fakeAgentDocker({ containers: ['graph-web-1'], refuses: ['graph-web-1'] });
  assert.throws(
    () => removeAgentDockerObjects({ deploymentName: 'web', docker: stuckContainer.docker }),
    /Could not remove graph-web-1/,
  );
  const stuckNetwork = fakeAgentDocker({ networks: ['graph-private'], refuses: ['graph-private'] });
  assert.throws(
    () => removeAgentDockerObjects({ deploymentName: 'web', docker: stuckNetwork.docker }),
    /Could not remove graph-private: has active endpoints/,
  );
});

test('a daemon that cannot answer is a failure, not an empty computer', () => {
  const state = fakeAgentDocker({ containers: ['graph-web-1'], listingFails: true });
  assert.throws(
    () => removeAgentDockerObjects({ deploymentName: 'web', docker: state.docker }),
    /Cannot connect to the daemon/,
  );
  assert.equal(state.containers.size, 1);
});
