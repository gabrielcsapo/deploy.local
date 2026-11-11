import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentGraphDocker } from '../agent-graph-runtime.ts';
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
  const transport: ReleaseNodeTransport = async (node, application, payload, artifact) => {
    calls.push(`${payload.phase}:${application}`);
    if (payload.phase === 'quiesce')
      assert.equal(
        calls.filter((call) => call.startsWith('verify:')).length % 2,
        0,
        'every app verified before any app stopped',
      );
    return executeReleaseAgentJob({
      root: join(root, node),
      job: { deploymentName: application, payload, artifactUrl: artifact ? '/source' : null },
      download: async (path) => {
        if (artifact) copyFileSync(artifact, path);
      },
      docker: computers.get(node)!,
      probePort: async () => true,
      workerProbeMs: 0,
      relay: async () => 5189,
      onBuildOutput: (text) => output.push(`${application}: ${text}`),
    });
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
  return { runtime, project, computers, calls, names, transport, output };
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
