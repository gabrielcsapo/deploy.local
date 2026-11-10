import { SupervisorRelay } from './supervisor-relay.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';

test(
  'supervisor starts each service once and restarts only the failed child',
  { timeout: 15000 },
  async () => {
    // Short paths also fit the macOS Unix socket path limit.
    const root = await mkdtemp('/tmp/deploy-supervisor-');
    await copyFile(new URL('./supervisor.ts', import.meta.url), join(root, 'supervisor.ts'));
    await copyFile(
      new URL('./supervisor-relay.ts', import.meta.url),
      join(root, 'supervisor-relay.ts'),
    );
    await copyFile(new URL('./log-rotation.ts', import.meta.url), join(root, 'log-rotation.ts'));
    await mkdir(join(root, 'v2'));
    await copyFile(
      new URL('./v2/coordinator-executor.ts', import.meta.url),
      join(root, 'v2/coordinator-executor.ts'),
    );
    for (const entry of [
      'server',
      'edge',
      'workspace-repository-worker',
      'workspace-pipeline-worker',
    ]) {
      await writeFile(join(root, `${entry}.js`), 'setInterval(() => {}, 1000);');
    }
    const child = spawn(process.execPath, [join(root, 'supervisor.ts')], {
      env: { ...process.env, DEPLOY_DATA_DIR: root },
      stdio: 'ignore',
    });
    const exited = once(child, 'exit');
    let socket: ReturnType<typeof connect> | undefined;
    const states: any[] = [];
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Supervisor state timed out');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      await waitFor(() => {
        if (socket) return true;
        const attempt = connect(join(root, 'supervisor.sock'));
        attempt.once('error', () => attempt.destroy());
        attempt.once('connect', () => {
          if (socket) return attempt.destroy();
          socket = attempt;
          let buffer = '';
          attempt.on('data', (chunk) => {
            buffer += chunk.toString();
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              states.push(JSON.parse(buffer.slice(0, end)));
              buffer = buffer.slice(end + 1);
            }
          });
        });
        return false;
      });
      await waitFor(() => states.some((state) => state.children?.every((entry: any) => entry.pid)));
      const initial = states.at(-1).children;
      assert.deepEqual(initial.map((entry: any) => entry.name).sort(), [
        'control',
        'edge',
        'pipelines',
        'repositories',
      ]);
      // Deployment notices are broadcast live, while only fleet state is replayed.
      const deployment = {
        type: 'deployment',
        name: 'app',
        status: 'running',
        nodeId: 'a',
        nodeName: 'A',
        username: 'owner',
        at: 123,
      };
      socket!.write(JSON.stringify(deployment) + '\n');
      await waitFor(() => states.some((state) => state.type === 'deployment'));
      assert.deepEqual(
        states.find((state) => state.type === 'deployment'),
        deployment,
      );
      socket!.write(JSON.stringify({ type: 'fleet', running: 1 }) + '\n');
      await waitFor(() => states.some((state) => state.type === 'fleet'));
      const observer = connect(join(root, 'supervisor.sock'));
      const replay: any[] = [];
      let replayBuffer = '';
      observer.on('data', (chunk) => {
        replayBuffer += chunk.toString();
        let newline;
        while ((newline = replayBuffer.indexOf('\n')) >= 0) {
          replay.push(JSON.parse(replayBuffer.slice(0, newline)));
          replayBuffer = replayBuffer.slice(newline + 1);
        }
      });
      try {
        await waitFor(() => replay.some((state) => state.type === 'fleet'));
        assert.deepEqual(
          replay.map((state) => state.type),
          ['status', 'fleet'],
        );
        socket!.write(JSON.stringify({ ...deployment, status: 'failed' }) + '\n');
        await waitFor(() => replay.some((state) => state.type === 'deployment'));
        assert.equal(replay.find((state) => state.type === 'deployment').status, 'failed');
      } finally {
        observer.destroy();
      }
      const repository = initial.find((entry: any) => entry.name === 'repositories');
      process.kill(repository.pid, 'SIGKILL');
      await waitFor(() =>
        states.some((state) =>
          state.children?.some(
            (entry: any) =>
              entry.name === 'repositories' && entry.pid && entry.pid !== repository.pid,
          ),
        ),
      );
      const restarted = states.findLast((state) => state.children)?.children;
      for (const entry of initial.filter((candidate: any) => candidate.name !== 'repositories')) {
        assert.equal(
          restarted.find((candidate: any) => candidate.name === entry.name).pid,
          entry.pid,
        );
      }
    } finally {
      socket?.destroy();
      child.kill('SIGTERM');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('supervisor relays deployment notices live and retains only the latest fleet sample', () => {
  const lines: string[] = [];
  const relay = new SupervisorRelay((line) => lines.push(line));
  const deployment = JSON.stringify({ type: 'deployment', name: 'app', status: 'running' }) + '\n';
  relay.receive(deployment);
  assert.deepEqual(lines, [deployment]);
  assert.equal(relay.fleetLine, null);
  const fleet = JSON.stringify({ type: 'fleet', running: 1 }) + '\n';
  relay.receive(fleet);
  relay.receive(deployment);
  for (const line of ['malformed', 'null', '{}', '{"type":"status"}', '{"type":"unknown"}'])
    relay.receive(line);
  assert.deepEqual(lines, [deployment, fleet, deployment]);
  assert.equal(relay.fleetLine, fleet);
});

test('supervisor restarts a child whose heartbeat stops', { timeout: 15000 }, async () => {
  const root = await mkdtemp('/tmp/deploy-supervisor-');
  await copyFile(new URL('./supervisor.ts', import.meta.url), join(root, 'supervisor.ts'));
  await copyFile(
    new URL('./supervisor-relay.ts', import.meta.url),
    join(root, 'supervisor-relay.ts'),
  );
  await copyFile(new URL('./log-rotation.ts', import.meta.url), join(root, 'log-rotation.ts'));
  await mkdir(join(root, 'v2'));
  await copyFile(
    new URL('./v2/coordinator-executor.ts', import.meta.url),
    join(root, 'v2/coordinator-executor.ts'),
  );
  // Never sends a heartbeat, like a build from before the watchdog: it must be left alone.
  for (const entry of ['server', 'workspace-repository-worker', 'workspace-pipeline-worker']) {
    await writeFile(join(root, `${entry}.js`), 'setInterval(() => {}, 1000);');
  }
  // Sends one heartbeat, then blocks its event loop for good: alive, but wedged.
  await writeFile(
    join(root, 'edge.js'),
    "process.send({ type: 'heartbeat' }, () => { for (;;) {} });",
  );
  const child = spawn(process.execPath, [join(root, 'supervisor.ts')], {
    env: { ...process.env, DEPLOY_DATA_DIR: root, DEPLOY_WATCHDOG_STALE_MS: '400' },
    stdio: 'ignore',
  });
  const exited = once(child, 'exit');
  const states: any[] = [];
  let socket: ReturnType<typeof connect> | undefined;
  try {
    const deadline = Date.now() + 10000;
    const restartsOf = (name: string) =>
      states.findLast((state) => state.children)?.children.find((entry: any) => entry.name === name)
        ?.restarts ?? 0;
    while (restartsOf('edge') < 2) {
      if (Date.now() > deadline) throw new Error('The wedged child was not restarted');
      if (!socket) {
        const attempt = connect(join(root, 'supervisor.sock'));
        attempt.once('error', () => attempt.destroy());
        attempt.once('connect', () => {
          if (socket) return attempt.destroy();
          socket = attempt;
          let buffer = '';
          attempt.on('data', (chunk) => {
            buffer += chunk.toString();
            let end;
            while ((end = buffer.indexOf('\n')) >= 0) {
              states.push(JSON.parse(buffer.slice(0, end)));
              buffer = buffer.slice(end + 1);
            }
          });
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const last = states.findLast((state) => state.children).children;
    assert.equal(last.find((entry: any) => entry.name === 'edge').lastExit.signal, 'SIGKILL');
    for (const name of ['control', 'pipelines', 'repositories'])
      assert.equal(last.find((entry: any) => entry.name === name).restarts, 0);
  } finally {
    socket?.destroy();
    child.kill('SIGTERM');
    await exited;
    await rm(root, { recursive: true, force: true });
  }
});
