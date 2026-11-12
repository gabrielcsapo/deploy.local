import { SupervisorRelay } from './supervisor-relay.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  stat,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { once } from 'node:events';
import {
  pointCurrent,
  promote,
  activationPlan,
  releaseCommand,
} from '../scripts/linux-release.mjs';

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
    await copyFile(
      new URL('./process-metrics.ts', import.meta.url),
      join(root, 'process-metrics.ts'),
    );
    await mkdir(join(root, 'v2'));
    await copyFile(
      new URL('./v2/coordinator-executor.ts', import.meta.url),
      join(root, 'v2/coordinator-executor.ts'),
    );
    const metrics = {
      sampledAt: Date.now(),
      windowMs: 60000,
      rssBytes: 1048576,
      heapUsedBytes: 1024,
      heapTotalBytes: 2048,
      eventLoopDelayMs: { p50: 20, p99: 201, max: 1001 },
    };
    for (const entry of [
      'server',
      'edge',
      'workspace-repository-worker',
      'workspace-pipeline-worker',
    ]) {
      await writeFile(
        join(root, `${entry}.js`),
        `const message = {type:'heartbeat',metrics:${JSON.stringify(metrics)}};process.send(message);process.send(message);setInterval(()=>process.send({type:'heartbeat'}),100);`,
      );
    }
    const child = spawn(process.execPath, [join(root, 'supervisor.ts')], {
      env: { ...process.env, DEPLOY_MDNS_ADDRESS: '127.0.0.1', DEPLOY_DATA_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout!.on('data', (chunk) => (logs += chunk));
    child.stderr!.on('data', (chunk) => (logs += chunk));
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
      await waitFor(() => states.at(-1)?.children?.every((entry: any) => entry.metrics));
      const initial = states.at(-1).children;
      for (const entry of initial) assert.deepEqual(entry.metrics, metrics);
      await waitFor(
        () => logs.split('\n').filter((line) => line.includes('event-loop')).length === 4,
      );
      assert.equal(
        logs.split('\n').filter((line) => line.includes('event-loop')).length,
        4,
        'duplicate samples log once per process',
      );
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
  await copyFile(
    new URL('./process-metrics.ts', import.meta.url),
    join(root, 'process-metrics.ts'),
  );
  await mkdir(join(root, 'v2'));
  await copyFile(
    new URL('./v2/coordinator-executor.ts', import.meta.url),
    join(root, 'v2/coordinator-executor.ts'),
  );
  // Never sends a heartbeat, like a build from before the watchdog: it must be left alone.
  for (const entry of ['server', 'workspace-repository-worker', 'workspace-pipeline-worker']) {
    await writeFile(
      join(root, `${entry}.js`),
      entry === 'server'
        ? `setInterval(()=>process.send({type:'heartbeat',metrics:'invalid'}),50);`
        : 'setInterval(() => {}, 1000);',
    );
  }
  // Sends one heartbeat, then blocks its event loop for good: alive, but wedged.
  await writeFile(
    join(root, 'edge.js'),
    "process.send({ type: 'heartbeat' }, () => { for (;;) {} });",
  );
  const child = spawn(process.execPath, [join(root, 'supervisor.ts')], {
    env: {
      ...process.env,
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      DEPLOY_DATA_DIR: root,
      DEPLOY_WATCHDOG_STALE_MS: '400',
    },
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

// Real supervisor, disposable fake children and Unix sockets only. No systemd,
// mDNS, production databases or network listeners participate in this test.
test(
  'release switching loads the selected control, preserves app sockets and rolls back failed control',
  { timeout: 25000 },
  async () => {
    const root = await realpath(await mkdtemp('/tmp/dl-switch-'));
    const releases = join(root, 'releases');
    const previous = join(releases, 'old'),
      next = join(releases, 'new'),
      bad = join(releases, 'bad');
    const current = join(root, 'current');
    const config = { current, releases, data: root, uid: process.getuid!() };
    const configFile = join(root, 'config.json');
    await writeFile(configFile, JSON.stringify(config));
    for (const release of [previous, next, bad]) {
      await mkdir(join(release, 'dist/v2'), { recursive: true });
      for (const file of [
        'supervisor.ts',
        'supervisor-relay.ts',
        'log-rotation.ts',
        'process-metrics.ts',
        'v2/coordinator-executor.ts',
      ])
        await copyFile(new URL(file, import.meta.url), join(release, 'dist', file));
      await writeFile(join(release, 'dist/supervisor.js'), 'same supervisor bundle');
      await writeFile(
        join(release, 'dist/edge.js'),
        `
      const { createServer } = require('node:net');
      createServer(socket => socket.on('data', () => socket.write('app:' + process.pid)))
        .listen(process.env.DEPLOY_DATA_DIR + '/app.sock');
    `,
      );
      for (const file of [
        'server.js',
        'workspace-pipeline-worker.js',
        'workspace-repository-worker.js',
      ]) {
        await writeFile(
          join(release, 'dist', file),
          release === bad && file === 'server.js'
            ? 'process.exit(1);'
            : `require('node:fs').writeFileSync(process.env.DEPLOY_DATA_DIR + '/${file}.json', JSON.stringify({pid:process.pid,cwd:process.cwd(),entry:__filename})); setInterval(()=>{},1000);`,
        );
      }
    }
    pointCurrent(current, previous);
    const launch = () =>
      spawn(process.execPath, [join(current, 'dist/supervisor.ts')], {
        cwd: current,
        env: {
          ...process.env,
          DEPLOY_MDNS_ADDRESS: '127.0.0.1',
          DEPLOY_DATA_DIR: root,
          DEPLOY_RELEASE_CONFIG: configFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    let child = launch();
    let exited = once(child, 'exit');
    let logs = '';
    const capture = () => {
      child.stdout!.on('data', (chunk) => (logs += chunk));
      child.stderr!.on('data', (chunk) => (logs += chunk));
    };
    capture();
    const waitFor = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          if (await check()) return;
        } catch {
          /* Startup has not written the file yet. */
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Supervisor fixture timed out: ${logs}`);
    };
    const identity = async (file = 'server.js') =>
      JSON.parse(await readFile(join(root, `${file}.json`), 'utf8'));
    let app: ReturnType<typeof connect> | undefined;
    try {
      await waitFor(async () => (await stat(join(root, 'supervisor-release.sock'))).isSocket());
      assert.equal((await stat(join(root, 'supervisor-release.sock'))).mode & 0o777, 0o600);
      await waitFor(
        async () => (await stat(join(root, 'app.sock'))).isSocket() && !!(await identity()).pid,
      );
      app = connect(join(root, 'app.sock'));
      await once(app, 'connect');
      const ping = async () => {
        const reply = once(app!, 'data');
        app!.write('request');
        return (await reply)[0].toString();
      };
      const edge = await ping();
      const original = await identity();
      await assert.rejects(releaseCommand(config, next), /selected configured release/);
      assert.equal((await identity()).pid, original.pid);
      const healthy = async (target: string) => {
        if (target === bad) throw new Error('bad control failed readiness');
        await waitFor(async () => (await identity()).cwd === target);
        for (const file of ['workspace-pipeline-worker.js', 'workspace-repository-worker.js'])
          await waitFor(async () => (await identity(file)).cwd === target);
        assert.equal((await identity()).entry, join(target, 'dist/server.js'));
        assert.equal(await ping(), edge);
      };
      const options = {
        current,
        validate() {},
        plan: activationPlan,
        restart() {
          assert.fail('must not restart supervisor or edge');
        },
        replaceControl: (target: string) => releaseCommand(config, target),
        healthy,
      };
      await promote({ ...options, release: next });
      assert.notEqual((await identity()).pid, original.pid);
      assert.equal(await ping(), edge);
      await assert.rejects(promote({ ...options, release: bad }), /restored/);
      assert.equal(await realpath(current), next);
      await healthy(next);
      // A caller cannot bypass runtime compatibility merely by changing current.
      await writeFile(join(bad, 'dist/edge.js'), 'different edge');
      pointCurrent(current, bad);
      await assert.rejects(releaseCommand(config, bad), /full service restart required/);
      pointCurrent(current, next);
      assert.equal(await ping(), edge);
      // Reboot uses the symlink, including in the presence of an old v2 pointer.
      await writeFile(
        join(root, 'coordinator-updates/active.json'),
        JSON.stringify({
          entry: join(previous, 'dist/server.js'),
          cwd: previous,
        }),
      );
      app.destroy();
      app = undefined;
      child.kill('SIGTERM');
      await exited;
      await rm(join(root, 'app.sock'), { force: true });
      child = launch();
      exited = once(child, 'exit');
      capture();
      const last = (await identity()).pid;
      await waitFor(async () => (await identity()).pid !== last && (await identity()).cwd === next);
    } finally {
      app?.destroy();
      child.kill('SIGTERM');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('supervisor release commands with in-memory processes and sockets', async () => {
  // VM modules let the real entry point run with fake OS resources. Run this
  // one case in a child because Node gates VM modules behind a startup flag.
  if (process.env.DEPLOY_SUPERVISOR_VM_TEST !== '1') {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DEPLOY_MDNS_ADDRESS: '127.0.0.1',
      DEPLOY_SUPERVISOR_VM_TEST: '1',
    };
    delete env.NODE_TEST_CONTEXT; // A nested runner must execute, not inherit the parent's IPC reporter.
    const runner = spawn(
      process.execPath,
      [
        '--experimental-vm-modules',
        '--test',
        '--test-name-pattern=in-memory processes and sockets',
        import.meta.filename,
      ],
      {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    runner.stdout.on('data', (chunk) => (output += chunk));
    runner.stderr.on('data', (chunk) => (output += chunk));
    const [code] = await once(runner, 'exit');
    assert.equal(code, 0, output);
    assert.match(output, /pass 1\b/);
    return;
  }
  const { SourceTextModule, SyntheticModule, createContext } = await import('node:vm');
  const { stripTypeScriptTypes } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { pathToFileURL } = await import('node:url');
  const { writeFileSync } = await import('node:fs');
  const root = await realpath(await mkdtemp('/tmp/dl-vm-'));
  const releases = join(root, 'releases');
  const previous = join(releases, 'old'),
    next = join(releases, 'new'),
    bad = join(releases, 'bad');
  const current = join(root, 'current'),
    configPath = join(root, 'config.json');
  for (const release of [previous, next, bad]) {
    await mkdir(join(release, 'dist'), { recursive: true });
    for (const name of [
      'supervisor.js',
      'edge.js',
      'server.js',
      'workspace-pipeline-worker.js',
      'workspace-repository-worker.js',
    ])
      await writeFile(join(release, 'dist', name), name);
  }
  pointCurrent(current, previous);
  await writeFile(
    configPath,
    JSON.stringify({ current, releases, data: root, uid: process.getuid!() }),
  );
  const processes: FakeChild[] = [];
  class FakeChild extends EventEmitter {
    pid = 100 + processes.length;
    stdout = new EventEmitter();
    stderr = new EventEmitter();
    alive = true;
    kills: string[] = [];
    entry: string;
    options: { cwd: string; env: Record<string, string> };
    constructor(entry: string, options: { cwd: string; env: Record<string, string> }) {
      super();
      this.entry = entry;
      this.options = options;
      processes.push(this);
      if (entry === join(bad, 'dist/server.js'))
        queueMicrotask(() => {
          this.alive = false;
          this.emit('exit', 1, null);
        });
    }
    kill(signal: string) {
      this.kills.push(signal);
      if (this.alive) {
        this.alive = false;
        queueMicrotask(() => this.emit('exit', 0, signal));
      }
      return true;
    }
  }
  const servers = new Map<string, FakeServer>();
  class FakeServer extends EventEmitter {
    connection?: (socket: FakeSocket) => void;
    constructor(connection?: (socket: FakeSocket) => void) {
      super();
      this.connection = connection;
    }
    listen(path: string, callback: () => void) {
      servers.set(path, this);
      writeFileSync(path, 'fake socket');
      callback();
    }
    close() {}
    unref() {}
  }
  class FakeSocket extends EventEmitter {
    response = '';
    setTimeout() {}
    pause() {}
    destroy() {}
    write() {}
    end(value: string) {
      this.response = value;
      this.emit('reply');
    }
  }
  const fakeProcess = Object.assign(new EventEmitter(), {
    env: { DEPLOY_DATA_DIR: root, DEPLOY_RELEASE_CONFIG: configPath },
    pid: 42,
    execPath: process.execPath,
    cwd: () => previous,
    getuid: () => process.getuid!(),
    exit() {
      assert.fail('supervisor must survive');
    },
  });
  const context = createContext({
    process: fakeProcess,
    console: { log() {}, error() {} },
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
  });
  let stagedEntry: string | undefined;
  const mocks: Record<string, Record<string, unknown>> = {
    'node:child_process': {
      spawn: (_exe: string, args: string[], options: FakeChild['options']) =>
        new FakeChild(args[0], options),
    },
    'node:net': {
      createServer: (callback: (socket: FakeSocket) => void) => new FakeServer(callback),
    },
    './process-metrics.ts': { processMetrics() {}, slowProcessLine() {} },
    './supervisor-relay.ts': {
      SupervisorRelay: class {
        receive() {}
      },
    },
    './log-rotation.ts': { rotateLogIfLarge() {} },
    './v2/coordinator-executor.ts': {
      CoordinatorExecutor: class {
        root = join(root, 'coordinator-updates');
        currentEntry: string;
        currentCwd = previous;
        busy = false;
        constructor(input: { entry: string }) {
          this.currentEntry = stagedEntry || input.entry;
        }
        async recover() {}
      },
      serveCoordinatorExecutor: async () => new FakeServer(),
    },
  };
  try {
    await mkdir(join(root, 'coordinator-updates'));
    const source = stripTypeScriptTypes(
      await readFile(new URL('./supervisor.ts', import.meta.url), 'utf8'),
    );
    const boot = async (release: string) => {
      const module = new SourceTextModule(source, {
        context,
        initializeImportMeta(meta) {
          meta.url = pathToFileURL(join(release, 'dist/supervisor.js')).href;
        },
      });
      await module.link(async (name) => {
        const exports = mocks[name] || (await import(name));
        return new SyntheticModule(
          Object.keys(exports),
          function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
          },
          { context },
        );
      });
      await module.evaluate();
    };
    await boot(previous);
    const edge = processes.find((proc) => proc.entry.endsWith('/edge.js'))!;
    assert.ok(edge);
    const command = async (release: string) => {
      const socket = new FakeSocket();
      servers.get(join(root, 'supervisor-release.sock'))!.connection!(socket);
      const replied = once(socket, 'reply');
      socket.emit('data', Buffer.from(JSON.stringify({ release }) + '\n'));
      await replied;
      const response = JSON.parse(socket.response);
      if (response.error) throw new Error(response.error);
      assert.equal(response.release, release);
      assert.equal(response.pid, 42);
    };
    await assert.rejects(command(next), /selected configured release/);
    const healthy = (release: string) => {
      assert.equal(edge.alive, true);
      assert.deepEqual(edge.kills, []);
      if (release === bad) throw new Error('replacement failed readiness');
      const running = processes.filter((proc) => proc.alive && proc !== edge);
      assert.equal(running.length, 3);
      for (const proc of running) {
        assert.equal(proc.options.cwd, release);
        assert.ok(proc.entry.startsWith(join(release, 'dist') + '/'));
      }
    };
    const options = {
      current,
      validate() {},
      plan: activationPlan,
      replaceControl: command,
      restart() {
        assert.fail('must preserve edge');
      },
      healthy,
    };
    await promote({ ...options, release: next });
    await assert.rejects(promote({ ...options, release: bad }), /restored/);
    assert.ok(processes.some((proc) => proc.entry === join(bad, 'dist/server.js') && !proc.alive));
    healthy(next);
    // Both edge and supervisor changes are rejected by the running supervisor,
    // even if a caller bypasses the updater's restart plan.
    for (const file of ['edge.js', 'supervisor.js']) {
      await writeFile(join(bad, 'dist', file), 'changed');
      pointCurrent(current, bad);
      await assert.rejects(command(bad), /full service restart required/);
      await writeFile(join(bad, 'dist', file), file);
    }
    assert.equal(processes.filter((proc) => proc.entry.endsWith('/edge.js')).length, 1);
    assert.deepEqual(edge.kills, []);
    // A later v2 staged update survives a reboot of the same Linux release,
    // but cannot override a newly selected Linux release on full restart.
    stagedEntry = join(root, 'coordinator-updates/builds/staged/server.js');
    pointCurrent(current, next);
    let count = processes.length;
    await boot(next);
    assert.ok(processes.slice(count).some((proc) => proc.entry === stagedEntry));
    pointCurrent(current, previous);
    count = processes.length;
    await boot(previous);
    assert.ok(
      processes.slice(count).some((proc) => proc.entry === join(previous, 'dist/server.js')),
    );
    assert.ok(processes.slice(count).every((proc) => proc.entry !== stagedEntry));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
