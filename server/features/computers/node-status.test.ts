import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNodeStatus, writeNodeSnapshot, readNodeSnapshot } from './node-status.ts';
import { nodeCapabilities } from './node-permissions.ts';
import { controlPaused, setControlPaused } from './node-control.ts';
const config = { coordinatorUrl: 'https://coordinator.test', workerId: 'worker', name: 'Linux' };
const helper = async () => ({
  available: true,
  reason: '',
  inputAllowed: false,
  sessionType: 'wayland',
  grantStored: false,
  screenLock: { locks: true },
});
test('unenrolled and offline status are honest; helper decisions reuse node permissions', async () => {
  const none = await readNodeStatus({ snapshot: null, paused: false, platform: 'linux' });
  assert.equal(none.enrolled, false);
  assert.equal(none.online, false);
  assert.equal(none.runningTaskCount, null);
  const status = await readNodeStatus({
    config,
    snapshot: null,
    helper,
    paused: true,
    platform: 'linux',
  });
  assert.equal(status.enrolled, true);
  assert.equal(status.online, false);
  assert.equal(status.capabilities.capture.state, 'needs-action');
  assert.match(status.capabilities.capture.reason, /Approve/);
  assert.match(status.capabilities.capture.fix, /setup/);
  assert.equal(status.capabilities.input.state, 'needs-action');
  assert.match(status.capabilities.input.fix, /allow-input/);
  assert.equal(status.capabilities.screenLock.state, 'needs-action');
  assert.equal(status.capabilities.controlPaused.state, 'needs-action');
});
test('worker snapshots carry real task counts; stale or mismatched snapshots never report online', async () => {
  const capabilities = nodeCapabilities({
    worker: { id: 'worker', name: 'Linux', platform: 'linux', status: 'online' },
    fresh: true,
    managed: false,
    browserProjects: [],
    targets: [],
  });
  const snapshot = {
    ...config,
    enrolled: true,
    online: true,
    reportedAt: 1000,
    runningTaskCount: 2,
    workerName: 'Linux',
    capabilities,
  };
  const status = await readNodeStatus({ config, snapshot, now: 1001, paused: false });
  assert.equal(status.online, true);
  assert.equal(status.runningTaskCount, 2);
  for (const override of [{ now: 20000 }, { config: { ...config, workerId: 'other' } }]) {
    const offline = await readNodeStatus({
      config,
      snapshot,
      now: 1001,
      paused: false,
      ...override,
    });
    assert.equal(offline.online, false);
    assert.equal(offline.runningTaskCount, null);
  }
  const directory = mkdtempSync(join(tmpdir(), 'node-status-'));
  try {
    const path = join(directory, 'status.json');
    writeNodeSnapshot(status, path);
    assert.equal(readNodeSnapshot(path).runningTaskCount, 2);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /secret|token/);
    const pausePath = join(directory, 'paused');
    setControlPaused(true, pausePath);
    assert.equal(controlPaused(pausePath), true);
    setControlPaused(false, pausePath);
    assert.equal(controlPaused(pausePath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('Mac capabilities use detected helper permissions; missing information remains unknown', () => {
  const inputs = {
    worker: { id: 'mac', name: 'Mac', platform: 'darwin', status: 'online' },
    fresh: true,
    managed: false,
    browserProjects: [],
    targets: [
      {
        id: 'display-1',
        kind: 'computer',
        permissions: { screenRecording: true, accessibility: false, unlocked: true },
      },
    ],
  };
  assert.equal(nodeCapabilities(inputs).capture.state, 'ok');
  assert.equal(nodeCapabilities(inputs).input.state, 'needs-action');
  assert.match(nodeCapabilities({ ...inputs, targets: [] }).screenLock.reason, /Unknown/);
});

test('CLI and Node enrollment share the same request and private credential storage without exposing tokens', async () => {
  const { joinAgent, readAgentConfig } = await import('../../../bin/agent-enrollment.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'node-enrollment-'));
  try {
    const path = join(directory, 'agent.json');
    const result = await joinAgent({
      coordinatorUrl: 'https://coordinator.test',
      code: 'one-use-code',
      taskWorker: true,
      configPath: path,
      request: async (url, options) => {
        assert.equal(url, 'https://coordinator.test/api/agent/enroll');
        assert.equal(options.redirect, 'error');
        const body = JSON.parse(String(options.body));
        assert.equal(body.taskWorker, true);
        assert.equal(body.code, 'one-use-code');
        return new Response(
          JSON.stringify({
            nodeId: 'node',
            name: 'Linux',
            secret: 'private-node-secret',
            workerId: 'worker',
            workerToken: 'private-worker-token',
          }),
        );
      },
    });
    assert.equal(readAgentConfig(path)?.workerId, 'worker');
    const publicStatus = await readNodeStatus({ config: result, snapshot: null, paused: false });
    assert.doesNotMatch(JSON.stringify(publicStatus), /private-|secret|token/);
    await assert.rejects(
      joinAgent({ coordinatorUrl: 'https://other.test/path', code: '', configPath: path }),
      /origin/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Electron-backed coding tools explicitly keep their MCP subprocesses in headless Node mode', async () => {
  const { agentLaunch } = await import('../../workspace/agent-launch.ts');
  const { nodeRuntimeEnvironment } = await import('../../workspace/node-runtime.ts');
  assert.deepEqual(nodeRuntimeEnvironment({}), {});
  assert.deepEqual(nodeRuntimeEnvironment({ ELECTRON_RUN_AS_NODE: '1' }), {
    ELECTRON_RUN_AS_NODE: '1',
  });
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    assert(
      agentLaunch({ adapter: 'codex' }).args.some((argument) =>
        argument.includes('ELECTRON_RUN_AS_NODE="1"'),
      ),
    );
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});

test('SEA workers launch embedded adapters and MCP commands, while source workers retain scripts', async () => {
  const { workerEntry } = await import('../../workspace/worker-entry.ts');
  for (const name of ['mcp', 'claude-agent', 'compatible-agent']) {
    assert.deepEqual(workerEntry(name, true), ['worker', name]);
    assert.deepEqual(workerEntry(name, false, 'file:///repo/server/workspace/worker-entry.ts'), [
      `/repo/server/workspace/${name}.ts`,
    ]);
    assert.deepEqual(workerEntry(name, false, 'file:///app/workspace-remote-worker.js'), [
      `/app/workspace-${name}.js`,
    ]);
  }
});

test('git subprocesses retain worker CA trust while rejecting repository redirects and disabled verification', async () => {
  const { gitEnvironment } = await import('../../workspace/repository-git.ts');
  const saved = {
    GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO,
    GIT_DIR: process.env.GIT_DIR,
    GIT_SSL_NO_VERIFY: process.env.GIT_SSL_NO_VERIFY,
  };
  try {
    process.env.GIT_SSL_CAINFO = '/worker/system-ca.pem';
    process.env.GIT_DIR = '/another/repository';
    process.env.GIT_SSL_NO_VERIFY = '1';
    const environment = gitEnvironment();
    assert.equal(environment.GIT_SSL_CAINFO, '/worker/system-ca.pem');
    assert.equal(environment.GIT_DIR, undefined);
    assert.equal(environment.GIT_SSL_NO_VERIFY, undefined);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
