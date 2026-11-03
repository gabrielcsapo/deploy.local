import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  servicePlan,
  assertAgentJobAllowed,
  workerExecutablePaths,
  supervisedExecutable,
  serviceProgramArguments,
  linkWorkerSupervisor,
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
} from 'node:fs';
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
      assert.deepEqual(workerExecutablePaths(dir), {
        executable: join(dir, expected),
        supervisor: join(dir, `${expected}-supervisor`),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test('only a supervisor link with a worker build beside it supervises', () => {
  const dir = agentDirectory(['deploy-worker', 'deploy-worker-supervisor'], ['worker']);
  try {
    assert.equal(
      supervisedExecutable(join(dir, 'deploy-worker-supervisor'), dir),
      join(dir, 'deploy-worker'),
    );
    writeFileSync(join(dir, 'worker-supervisor'), '');
    assert.equal(supervisedExecutable(join(dir, 'worker-supervisor'), dir), null);
    assert.equal(supervisedExecutable(join(dir, 'deploy-worker'), dir), null);
    assert.equal(supervisedExecutable('/usr/local/bin/deploy', dir), null);
    rmSync(join(dir, 'worker'), { recursive: true });
    writeFileSync(join(dir, 'worker'), '');
    assert.equal(supervisedExecutable(join(dir, 'worker-supervisor'), dir), join(dir, 'worker'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('the task worker service runs the swappable build, the agent runs the supervisor', () => {
  const self = ['/opt/homebrew/bin/node', '/repo/bin/deploy.js'];
  const dir = agentDirectory(['deploy-worker', 'deploy-worker-supervisor'], ['worker']);
  try {
    const args = serviceProgramArguments({ agentDir: dir, self });
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
    assert.deepEqual(serviceProgramArguments({ agentDir: dir, self }), {
      agent: [join(dir, 'deploy-worker')],
      worker: [join(dir, 'deploy-worker')],
    });
    rmSync(join(dir, 'deploy-worker'));
    assert.deepEqual(serviceProgramArguments({ agentDir: dir, self }), {
      agent: self,
      worker: self,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('installing links the supervisor to the current build without touching it otherwise', () => {
  const dir = agentDirectory(['deploy-worker'], ['worker']);
  try {
    const executable = join(dir, 'deploy-worker');
    const supervisor = linkWorkerSupervisor(dir);
    assert.equal(supervisor, join(dir, 'deploy-worker-supervisor'));
    assert.equal(statSync(supervisor).ino, statSync(executable).ino);
    // An update swaps in a new inode; the next install moves the supervisor to it.
    rmSync(executable);
    writeFileSync(executable, 'new', { mode: 0o755 });
    assert.notEqual(statSync(supervisor).ino, statSync(executable).ino);
    linkWorkerSupervisor(dir);
    assert.equal(statSync(supervisor).ino, statSync(executable).ino);
    assert.equal(readFileSync(supervisor, 'utf8'), 'new');
    const empty = agentDirectory([], ['worker']);
    assert.equal(linkWorkerSupervisor(empty), null);
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
