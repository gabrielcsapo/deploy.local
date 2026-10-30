import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  servicePlan,
  workerRoot,
  servicePath,
  workerPlist,
  workerUnit,
  workerServiceFile,
} from './agent-services.mjs';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkerConfig, enableWorkerTlsTrust } from './worker-runtime.mjs';
import { joinAgent, readAgentConfig } from './agent-enrollment.mjs';

const roles = { deploy: false, tasks: false, computer: false, browser: false };
test('all role combinations install only the requested execution and task services', () => {
  for (let mask = 0; mask < 16; mask++) {
    const selected = Object.fromEntries(
      Object.keys(roles).map((role, index) => [role, !!(mask & (1 << index))]),
    );
    assert.deepEqual(servicePlan(selected), { agent: selected.deploy, worker: selected.tasks });
  }
  assert.deepEqual(servicePlan(undefined), { agent: true, worker: false });
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
    assert.deepEqual(servicePlan(config.roles), { agent: true, worker: false });
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
