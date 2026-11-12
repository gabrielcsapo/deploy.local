import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentGraphDocker, AgentGraphExecutionInput } from '../agent-graph-runtime.ts';
import type { WorkerReleasePart } from './release-progress.ts';
import type { ReleaseNodeTransport } from './releases-remote.ts';
const root = mkdtempSync(join(tmpdir(), 'release-nodes-'));
process.env.DEPLOY_DATA_DIR = root;
const { executeReleaseAgentJob } = await import('./releases-worker.ts');
const { CoordinatorReleaseRuntime } = await import('./releases-runtime.ts');
const { saveDeployment, getSqlite, readDeploymentRecord, _resetDb } = await import('../store.ts');
const { db } = await import('../workspace/store.ts');
after(() => {
  _resetDb();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

class FakeNode implements AgentGraphDocker {
  containers = new Map<string, { app: string; component: string; running: boolean }>();
  calls: string[][] = [];
  networks = new Map<string, string>();
  failActivation = false;
  missingImage = false;
  async run(args: readonly string[], options?: { onOutput?: (output: string) => void }) {
    this.calls.push([...args]);
    let stdout = '';
    if (this.missingImage && args[0] === 'image' && args.length === 3)
      return { exitCode: 1, stdout: '', stderr: 'No such image' };
    if (args[0] === 'pull') {
      this.missingImage = false;
      options?.onOutput?.(`Pulling ${args[1]}\n`);
    }
    if (args[0] === 'image') stdout = `sha256:${'1'.repeat(64)}`;
    if (args[0] === 'network') {
      const name = args.at(-1)!;
      if (args[1] === 'inspect')
        return { exitCode: this.networks.has(name) ? 0 : 1, stdout: '', stderr: '' };
      if (args[1] === 'create')
        this.networks.set(
          name,
          args.find((arg) => arg.startsWith('deploy-sh.app='))!.slice('deploy-sh.app='.length),
        );
      if (args[1] === 'rm') this.networks.delete(name);
      if (args[1] === 'ls') {
        const app = args
          .find((arg) => arg.startsWith('label=deploy-sh.app='))!
          .slice('label=deploy-sh.app='.length);
        stdout = [...this.networks]
          .filter(([, owner]) => owner === app)
          .map(([name]) => name)
          .join('\n');
      }
      return { exitCode: 0, stdout, stderr: '' };
    }
    if (args[0] === 'ps') {
      const app = args
        .find((arg) => arg.startsWith('label=deploy-sh.app='))!
        .slice('label=deploy-sh.app='.length);
      stdout = [...this.containers]
        .filter(([, row]) => row.app === app)
        .map(([name, row]) => (args.at(-1)!.includes('Label') ? `${name}\t${row.component}` : name))
        .join('\n');
    }
    if (args[0] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const app = args
        .find((arg) => arg.startsWith('deploy-sh.app='))!
        .slice('deploy-sh.app='.length);
      if (this.failActivation && !app.startsWith('verify-'))
        return { exitCode: 1, stdout: '', stderr: 'activation failed' };
      const component = args
        .find((arg) => arg.startsWith('deploy-sh.component='))!
        .slice('deploy-sh.component='.length);
      this.containers.set(name, { app, component, running: false });
      stdout = name;
    }
    if (args[0] === 'inspect')
      stdout = this.containers.get(args.at(-1)!)?.running
        ? args.includes('{{.State.Running}}')
          ? 'true'
          : 'true healthy'
        : 'false';
    if (args[0] === 'port') stdout = '127.0.0.1:5188';
    if (args[0] === 'start' || args[0] === 'stop') {
      const row = this.containers.get(args.at(-1)!);
      if (row) row.running = args[0] === 'start';
    }
    if (args[0] === 'rm') this.containers.delete(args.at(-1)!);
    return { exitCode: 0, stdout, stderr: '' };
  }
}
function fixture() {
  const suffix = randomUUID().slice(0, 8);
  const computers = new Map([
    ['ser-' + suffix, new FakeNode()],
    ['bazzite-' + suffix, new FakeNode()],
  ]);
  const names = ['web-' + suffix, 'sync-' + suffix];
  const calls: string[] = [];
  const output: string[] = [];
  const progress: { phase: string; app: string; parts: WorkerReleasePart[] }[] = [];
  const results: { phase: string; parts?: WorkerReleasePart[]; verifyEmptyResources?: string[] }[] =
    [];
  const probes: { watch: AgentGraphExecutionInput['probePort']; silenceMs?: number } = {
    watch: async () => true,
  };
  for (const [index, [id]] of [...computers].entries()) {
    getSqlite()!
      .prepare('INSERT INTO nodes(id,name,address,enrolled_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(id, id, '127.0.0.1', new Date().toISOString(), Date.now());
    const directory = join(root, names[index]);
    mkdirSync(directory);
    writeFileSync(
      join(directory, 'deploy.yaml'),
      `apiVersion: deploy.local/v1\nkind: Application\ncomponents:\n  app:\n    image: test:1\n    role: ${index ? 'worker' : 'web'}\n    interfaces:\n      http: {port: 8080, protocol: http}\n    health: {interface: http, path: /}\nroutes:\n  public: {to: app.http}\n`,
    );
    saveDeployment({
      name: names[index],
      username: 'owner',
      directory,
      activeNodeId: id,
      desiredNodeId: id,
    });
  }
  const transport: ReleaseNodeTransport = async (node, application, payload, artifact, onParts) => {
    calls.push(`${payload.phase}:${application}`);
    if (payload.phase === 'quiesce')
      assert.equal(
        calls.filter((call) => call.startsWith('verify:')).length % 2,
        0,
        'every app verified before any app stopped',
      );
    const result = await executeReleaseAgentJob({
      root: join(root, node),
      job: { deploymentName: application, payload, artifactUrl: artifact ? '/source' : null },
      download: async (path) => {
        if (artifact) copyFileSync(artifact, path);
      },
      docker: computers.get(node)!,
      probePort: payload.phase === 'watch' ? probes.watch : async () => true,
      workerProbeMs: 0,
      watchSilenceMs: probes.silenceMs ?? 0,
      relay: async () => 5189,
      onProgress: (parts) => {
        progress.push({ phase: payload.phase, app: application, parts: structuredClone(parts) });
        onParts?.(parts);
      },
      onBuildOutput: (text) => output.push(`${application}: ${text}`),
    });
    results.push({
      phase: payload.phase,
      parts: result.parts,
      verifyEmptyResources: result.verifyEmptyResources,
    });
    return result;
  };
  const runtime = new CoordinatorReleaseRuntime({ remote: transport });
  const project = {
    id: suffix,
    name: suffix,
    apps: names.map((name, index) => ({
      id: name,
      name,
      kind: index ? ('worker' as const) : ('web' as const),
    })),
  };
  return {
    runtime,
    project,
    computers,
    calls,
    names,
    transport,
    output,
    progress,
    results,
    probes,
  };
}

async function watchFixture(components?: string) {
  const f = fixture();
  if (components)
    writeFileSync(
      join(root, f.names[0], 'deploy.yaml'),
      `apiVersion: deploy.local/v1\nkind: Application\ncomponents:\n${components}`,
    );
  const plan = await f.runtime.plan(f.project);
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  await f.runtime.activate(plan);
  return { ...f, plan, watch: () => f.runtime.watch(plan, 0) };
}

test('Watch does not fail a remote app that is silent for less than a minute', async () => {
  // The coordinator asks every five seconds. Forma answered nothing for 15 seconds during one
  // long query on 2026-11-12; three quick misses must not roll such an app back.
  const f = await watchFixture();
  f.probes.silenceMs = 60_000;
  f.probes.watch = async () => false;
  for (let i = 0; i < 5; i++) await f.watch();
  f.probes.watch = async () => true;
  await f.watch();
});
test('Watch fails a running but hung remote app only after three persisted misses', async (t) => {
  const f = await watchFixture();
  f.probes.watch = undefined;
  const signals: AbortSignal[] = [];
  t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    signals.push(options.signal!);
    // Even a transport that never settles cannot hold Watch past its probe budget.
    return new Promise<Response>(() => {});
  });
  await f.watch();
  await f.watch();
  await assert.rejects(f.watch(), /did not answer its health check/);
  assert.equal(signals.length, 5);
  assert(signals.every((signal) => signal.aborted));
  assert(
    [...f.computers.values()].every((node) =>
      [...node.containers.values()].every((c) => c.running),
    ),
  );
});

test('one slow remote Watch answer is tolerated and a success resets the miss streak', async () => {
  const f = await watchFixture();
  f.probes.watch = async () => new Promise<boolean>(() => {});
  await f.watch();
  f.probes.watch = async () => true;
  await f.watch();
  f.probes.watch = async () => false;
  await f.watch();
  await f.watch();
  await assert.rejects(f.watch(), /did not answer its health check/);
});

for (const check of [
  '',
  '    health: {interface: http}\n',
  '    health: {interface: http, path: /ready}\n',
]) {
  test(`remote Watch applies HTTP status rules with ${check.trim() || 'no declared check'}`, async (t) => {
    const f = await watchFixture(
      '  app:\n    image: test:1\n    role: web\n    interfaces:\n      http: {port: 8080, protocol: http}\n' +
        check,
    );
    f.probes.watch = undefined;
    const urls: string[] = [];
    let status = 404;
    t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
      urls.push(url);
      assert.equal(options.redirect, 'manual');
      // The second app remains healthy; only the first app's result is under test.
      return new Response(null, { status: urls.length % 2 ? status : 200 });
    });
    await f.watch();
    await f.watch();
    if (check.includes('path:')) await assert.rejects(f.watch(), /did not answer its health check/);
    else await f.watch();
    assert.equal(urls[0], `http://127.0.0.1:5188${check.includes('path:') ? '/ready' : '/'}`);
    // A 5xx response is a miss even for the default check.
    status = 503;
    if (!check.includes('path:')) {
      await f.watch();
      await f.watch();
      await assert.rejects(f.watch(), /did not answer its health check/);
    }
  });
}

test('Watch probes every HTTP component and keeps separate streaks when only the worker fails', async (t) => {
  const f = await watchFixture(
    ['app', 'worker']
      .map(
        (name) =>
          `  ${name}:\n    image: test:1\n    role: ${name === 'app' ? 'web' : 'worker'}\n    interfaces:\n      http: {port: 8080, protocol: http}\n    health: {interface: http, path: /${name}}\n`,
      )
      .join(''),
  );
  f.probes.watch = undefined;
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    return new Response(null, { status: path === '/worker' ? 503 : 200 });
  });
  await f.watch();
  await f.watch();
  await assert.rejects(f.watch(), /did not answer its health check/);
  assert.equal(paths.filter((path) => path === '/app').length, 3);
  assert.equal(paths.filter((path) => path === '/worker').length, 3);
});

for (const interfaces of [
  '',
  '    interfaces:\n      tcp: {port: 9000, protocol: tcp}\n',
  '    interfaces:\n      tcp: {port: 9000, protocol: tcp}\n      http: {port: 8080, protocol: http}\n    health: {interface: tcp}\n',
]) {
  test(`remote Watch retains container checks for non-HTTP components: ${interfaces.trim() || 'worker'}`, async () => {
    const f = await watchFixture(`  app:\n    image: test:1\n    role: worker\n${interfaces}`);
    const probes: string[] = [];
    f.probes.watch = async (_port, protocol) => {
      probes.push(protocol);
      return true;
    };
    await f.watch();
    // Only the fixture's second app has an HTTP check.
    assert.deepEqual(probes, ['http']);
    const first = [...f.computers.values()][0];
    for (const container of first.containers.values()) container.running = false;
    probes.length = 0;
    await assert.rejects(f.watch(), /stopped during Watch/);
    assert.deepEqual(probes, []);
  });
}

test('two fake computers stage copies, verify the whole project, switch and roll back', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  assert(f.names.every((name) => !readDeploymentRecord(name)!.containerId));
  await f.runtime.activate(first);
  await f.runtime.migrate(first);
  await f.runtime.watch(first, 0);
  const previous = f.names.map((name) => readDeploymentRecord(name)!.containerId);
  const next = await f.runtime.plan(f.project);
  await f.runtime.prepare(next);
  await f.runtime.verify(next);
  assert.deepEqual(
    f.names.map((name) => readDeploymentRecord(name)!.containerId),
    previous,
  );
  await f.runtime.activate(next);
  assert(
    f.names.every((name, index) => readDeploymentRecord(name)!.containerId !== previous[index]),
  );
  const rollback = f.runtime.fork(first);
  await f.runtime.prepare(rollback);
  await f.runtime.verify(rollback);
  await f.runtime.rollback(next, rollback);
  await f.runtime.watch(rollback, 0);
  assert(f.calls.some((call) => call.startsWith('activate:sync')));
});
test('a release removes its test network and keeps the one the app runs on', async () => {
  const f = fixture();
  const testNetworks = () =>
    [...f.computers.values()].flatMap((node) =>
      [...node.networks.values()].filter((app) => app.startsWith('verify-')),
    );
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  assert.deepEqual(testNetworks(), []);
  assert(
    [...f.computers.values()].every((node) =>
      node.calls.some((call) => call[0] === 'network' && call[1] === 'rm'),
    ),
    'each computer made a test network and removed it',
  );
  await f.runtime.activate(first);
  assert.equal([...f.computers.values()].flatMap((node) => [...node.networks]).length, 2);
});
test('a release on another computer hands back its pull and build output', async () => {
  const f = fixture();
  [...f.computers.values()][0].missingImage = true;
  const plan = await f.runtime.plan(f.project);
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  assert.deepEqual(f.output, [`${f.names[0]}: Pulling test:1\n`]);
});
test('a release job carries its plan ID, which is how its build log is found', async () => {
  const f = fixture();
  const seen: string[] = [];
  const runtime = new CoordinatorReleaseRuntime({
    remote: async (node, application, payload, artifact) => {
      seen.push(payload.releaseId);
      return f.transport(node, application, payload, artifact);
    },
  });
  const plan = await runtime.plan(f.project);
  await runtime.prepare(plan);
  assert.ok(seen.length);
  assert.ok(seen.every((id) => id === (plan.runtime as { id: string }).id));
});
test('a failed switch on the second computer restores both original processes and routes', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  await f.runtime.activate(first);
  const previous = f.names.map((name) => readDeploymentRecord(name)!.containerId);
  const next = await f.runtime.plan(f.project);
  await f.runtime.prepare(next);
  await f.runtime.verify(next);
  [...f.computers.values()][1].failActivation = true;
  await assert.rejects(f.runtime.activate(next), /activation failed/);
  assert.deepEqual(
    f.names.map((name) => readDeploymentRecord(name)!.containerId),
    previous,
  );
  for (const [index, node] of [...f.computers.values()].entries())
    assert(node.containers.get(previous[index]!)!.running);
});
test('coordinator recovery aborts a remote partial switch before route publication', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  await f.runtime.activate(first);
  const next = await f.runtime.plan(f.project);
  await f.runtime.prepare(next);
  await f.runtime.verify(next);
  let switches = 0;
  const interrupted = new CoordinatorReleaseRuntime({
    remote: async (...args) => {
      if (args[2].phase === 'activate' && ++switches === 2)
        throw Object.assign(new Error('coordinator lost'), { requiresRecovery: true });
      if (args[2].phase === 'abort') throw new Error('coordinator lost');
      return f.transport(...args);
    },
  });
  await assert.rejects(interrupted.activate(next), /recovery/);
  const recovered = new CoordinatorReleaseRuntime({ remote: f.transport });
  assert.equal(await recovered.recover(next), 'aborted');
  for (const [index, node] of [...f.computers.values()].entries())
    assert(node.containers.get(readDeploymentRecord(f.names[index])!.containerId!)!.running);
});

test('remote irreversible migrations retain cold backups and restore them only when supplied', async () => {
  const f = fixture();
  const first = await f.runtime.plan(f.project);
  await f.runtime.prepare(first);
  await f.runtime.verify(first);
  await f.runtime.activate(first);
  for (const [index, [node]] of [...f.computers].entries()) {
    writeFileSync(join(root, node, 'volumes', f.names[index], 'value'), 'before');
    const manifest = join(root, f.names[index], 'deploy.yaml');
    writeFileSync(
      manifest,
      readFileSync(manifest, 'utf8') +
        'jobs:\n  migrate:\n    component: app\n    command: [migrate, up]\n    execution: perSite\n',
    );
  }
  const next = await f.runtime.plan(f.project);
  await f.runtime.prepare(next);
  await f.runtime.verify(next);
  const backup = await f.runtime.backup(next);
  await f.runtime.activate(next);
  await f.runtime.migrate(next);
  for (const [index, [node]] of [...f.computers].entries())
    writeFileSync(join(root, node, 'volumes', f.names[index], 'value'), 'after');
  const target = f.runtime.fork(first);
  await f.runtime.prepare(target);
  await f.runtime.verify(target, backup);
  await assert.rejects(f.runtime.rollback(next, target), /backup missing/);
  await f.runtime.rollback(next, target, backup);
  await f.runtime.watch(target, 0);
  for (const [index, [node]] of [...f.computers].entries())
    assert.equal(
      readFileSync(join(root, node, 'volumes', f.names[index], 'value'), 'utf8'),
      'before',
    );
});

test('remote Verify migrations off keeps app verification and activation migrations', async () => {
  const f = fixture();
  for (const name of f.names) {
    const path = join(root, name, 'deploy.yaml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8') +
        'jobs:\n  migrate:\n    component: app\n    command: [migrate, up]\n    execution: perSite\n    beforeTraffic: true\n',
    );
  }
  const plan = await f.runtime.plan(f.project);
  plan.verifyMigrations = false;
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  const jobs = () =>
    [...f.computers.values()]
      .flatMap((computer) => computer.calls)
      .filter((args) => args[0] === 'run' && args.some((arg) => arg.startsWith('deploy-sh.job=')));
  assert.equal(jobs().length, 0);
  await f.runtime.activate(plan);
  await f.runtime.migrate(plan);
  assert.equal(jobs().length, 2);
});

test('Verify emits real parts in order, including open parts, and returns their timings', async () => {
  const f = fixture();
  const plan = await f.runtime.plan(f.project);
  await f.runtime.prepare(plan);
  await f.runtime.verify(plan);
  const names = ['copy data', 'build image', 'start', 'wait for health'];
  for (const app of f.names) {
    const reports = f.progress.filter((entry) => entry.phase === 'verify' && entry.app === app);
    const final = reports.at(-1)!.parts;
    assert.deepEqual(
      final.map((part) => part.name),
      names,
    );
    for (let index = 0; index < final.length; index++) {
      const part = final[index];
      assert.ok(part.endedAt);
      assert.ok(part.endedAt >= part.startedAt);
      if (index) assert.ok(part.startedAt >= final[index - 1].endedAt!);
      assert.ok(
        reports.some(
          ({ parts }) => parts.length === index + 1 && !Object.hasOwn(parts[index], 'endedAt'),
        ),
      );
    }
  }
  for (const result of f.results.filter((entry) => entry.phase === 'verify'))
    assert.deepEqual(
      result.parts?.map((part) => part.name),
      names,
    );
  assert.ok(
    f.results
      .filter((entry) => entry.phase === 'prepare')
      .every((entry) => entry.parts?.length === 0),
  );
  await f.runtime.activate(plan);
  for (const result of f.results.filter((entry) => entry.phase === 'activate'))
    assert.deepEqual(
      result.parts?.map((part) => part.name),
      names.slice(1),
    );
});

test('release heartbeat covers a quiet download every thirty seconds and stops on failure', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_800_000_000_000 });
  const reports: number[] = [];
  let downloading!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => (downloading = resolve));
  const blocked = new Promise<void>((resolve) => (finish = resolve));
  const operation = executeReleaseAgentJob({
    root: join(root, 'heartbeat'),
    job: {
      deploymentName: 'quiet',
      payload: { version: 1, releaseId: 'quiet', phase: 'prepare' },
      artifactUrl: '/source',
    },
    download: async () => {
      downloading();
      await blocked;
      throw new Error('download interrupted');
    },
    docker: new FakeNode(),
    relay: async () => 0,
    onProgress: async (parts) => {
      assert.deepEqual(parts, []);
      reports.push(Date.now());
      if (reports.length === 1) throw new Error('coordinator temporarily unavailable');
    },
  });
  const rejected = assert.rejects(operation, /download interrupted/);
  await started;
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(30_000);
    // Flush the serialized asynchronous reports without advancing the real clock.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(
    reports,
    [0, 30_000, 60_000, 90_000].map((time) => 1_800_000_000_000 + time),
  );
  finish();
  await rejected;
  const count = reports.length;
  t.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reports.length, count);
});

test('a failed Verify includes the ended operation in its final error receipt', async () => {
  const f = fixture();
  const plan = await f.runtime.plan(f.project);
  await f.runtime.prepare(plan);
  const node = [...f.computers.values()][0];
  const run = node.run.bind(node);
  node.run = async (args, options) =>
    args[0] === 'create'
      ? { exitCode: 1, stdout: '', stderr: 'cannot create copy' }
      : run(args, options);
  await assert.rejects(f.runtime.verify(plan), (error: any) => {
    assert.match(error.message, /cannot create copy/);
    assert.deepEqual(
      error.parts.map((part: WorkerReleasePart) => part.name),
      ['copy data', 'build image', 'start'],
    );
    assert.ok(error.parts.every((part: WorkerReleasePart) => part.endedAt));
    assert.deepEqual(f.progress.at(-1)!.parts, error.parts);
    return true;
  });
});

test('remote worker timings reach the persisted project release steps', async () => {
  const { ProjectReleaseService, releaseById } = await import('./releases.ts');
  const f = fixture();
  const service = new ProjectReleaseService(f.runtime, { watchMs: 0 });
  const release = service.ship('owner', f.project, { source: { kind: 'ship', ref: 'main' } });
  await service.settled();
  const saved = releaseById('owner', release.id);
  assert.equal(saved.state, 'live');
  assert.deepEqual(
    saved.steps.find((step) => step.name === 'verify')!.parts?.map((part) => [part.app, part.name]),
    f.names.flatMap((app) =>
      ['copy data', 'build image', 'start', 'wait for health'].map((name) => [app, name]),
    ),
  );
  assert.ok(
    saved.steps.find((step) => step.name === 'verify')!.parts?.every((part) => part.endedAt),
  );
});

for (const mode of ['mixed', 'all-empty', 'default', 'backup'] as const) {
  test(`Verify resource data: ${mode}`, async () => {
    const { createHash } = await import('node:crypto');
    const { observeReleaseParts } = await import('./release-progress.ts');
    const f = fixture();
    const resources = ['data', 'uploads', 'media', 'database'];
    const empty = mode === 'default' ? [] : mode === 'all-empty' ? resources : ['data', 'media'];
    // Spell out the established paths so this test catches drift in the shared mapping.
    const folder = (name: string) => (['data', 'uploads'].includes(name) ? name : `graph/${name}`);
    for (const [index, [node]] of [...f.computers].entries()) {
      const app = f.names[index];
      const path = join(root, app, 'deploy.yaml');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          '    health:',
          `    mounts:
${resources.map((name) => `      /${name}: {resource: ${name}}`).join('\n')}
    health:`,
        ) +
          `resources:
${resources.map((name) => `  ${name}: {type: volume${empty.includes(name) ? ', verify: empty' : ''}}`).join('\n')}
`,
      );
      const volumes = join(root, node, 'volumes', app);
      for (const name of resources) {
        mkdirSync(join(volumes, folder(name)), { recursive: true });
        writeFileSync(join(volumes, folder(name), 'value'), name);
      }
      if (mode !== 'all-empty') {
        writeFileSync(join(volumes, 'unclaimed'), 'keep root entry');
        mkdirSync(join(volumes, 'graph', 'unclaimed'));
        writeFileSync(join(volumes, 'graph', 'unclaimed', 'value'), 'keep graph entry');
      }
    }
    const plan = await f.runtime.plan(f.project);
    await f.runtime.prepare(plan);
    const backup = mode === 'backup' ? await f.runtime.backup(plan) : undefined;
    const step: import('../../shared/v2/contracts.ts').Release['steps'][number] = {
      name: 'verify',
      state: 'running',
    };
    let persisted = '';
    observeReleaseParts(plan, step, () => {
      persisted = JSON.stringify(step);
    });
    await f.runtime.verify(plan, backup);
    assert.deepEqual(
      JSON.parse(persisted).verifyEmptyResources,
      f.names.flatMap((app) =>
        (backup ? [] : [...empty].sort()).map((resource) => ({ app, resource })),
      ),
    );
    for (const [index, [node, computer]] of [...f.computers].entries()) {
      const app = f.names[index];
      const releaseId = (plan.runtime as { id: string }).id;
      const key = createHash('sha256').update(`${releaseId}:${app}`).digest('hex').slice(0, 20);
      const copy = join(root, node, 'project-releases', key, 'data');
      const volumes = join(root, node, 'volumes', app);
      for (const name of resources) {
        const target = join(copy, folder(name));
        assert.deepEqual(readdirSync(target), !backup && empty.includes(name) ? [] : ['value']);
        if (backup || !empty.includes(name))
          assert.equal(readFileSync(join(target, 'value'), 'utf8'), name);
        assert.equal(readFileSync(join(volumes, folder(name), 'value'), 'utf8'), name);
        assert.ok(
          computer.calls.some(
            (args) => args[0] === 'create' && args.includes(`type=bind,src=${target},dst=/${name}`),
          ),
          `Verify mounts the expected folder for ${name}`,
        );
      }
      if (mode !== 'all-empty') {
        assert.equal(readFileSync(join(copy, 'unclaimed'), 'utf8'), 'keep root entry');
        assert.equal(
          readFileSync(join(copy, 'graph', 'unclaimed', 'value'), 'utf8'),
          'keep graph entry',
        );
      }
      const final = f.progress
        .filter((entry) => entry.phase === 'verify' && entry.app === app)
        .at(-1)!.parts;
      assert.equal(
        final.filter((part) => part.name === 'copy data').length,
        mode === 'all-empty' ? 0 : 1,
      );
    }
    for (const result of f.results.filter((entry) => entry.phase === 'verify'))
      assert.deepEqual(result.verifyEmptyResources, backup ? [] : [...empty].sort());
  });
}

test('Verify stores empty resource names beside parts in the release record', async () => {
  const { ProjectReleaseService, releaseById } = await import('./releases.ts');
  const f = fixture();
  for (const name of f.names) {
    const path = join(root, name, 'deploy.yaml');
    writeFileSync(
      path,
      readFileSync(path, 'utf8') + 'resources:\n  media: {type: volume, verify: empty}\n',
    );
  }
  const service = new ProjectReleaseService(f.runtime, { watchMs: 0 });
  const release = service.ship('owner', f.project, { source: { kind: 'ship', ref: 'main' } });
  await service.settled();
  const saved = releaseById('owner', release.id);
  assert.equal(saved.state, 'live');
  const verify = saved.steps.find((step) => step.name === 'verify')!;
  assert.deepEqual(
    verify.verifyEmptyResources,
    f.names.map((app) => ({ app, resource: 'media' })),
  );
  assert.ok(verify.parts?.length);
  assert.ok(verify.parts.every((part) => part.name !== 'copy data'));
});
