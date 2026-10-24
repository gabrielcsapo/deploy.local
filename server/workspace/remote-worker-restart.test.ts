import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const data = mkdtempSync(join(tmpdir(), 'deploy-remote-restart-'));
process.env.DEPLOY_DATA_DIR = data;
const { get, list, save } = await import('./store.ts');
const { workerCommand } = await import('./protocol.ts');
const { enrollWorker, workerAuthentication } = await import('./credentials.ts');
const { workspaceApi } = await import('./api.ts');
const { createTask } = await import('./test-repository.ts');
const { startRun } = await import('./service.ts');
const { markRunStopped } = await import('./run-recovery.ts');
const { restartInterruptedError, restartUnknownError } = await import('./restart-recovery.ts');
const owner = 'restart';

async function until<T>(read: () => T | undefined | false, timeout = 20000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((done) => setTimeout(done, 100));
  }
}

const server = createServer((req, res) => {
  const worker = workerAuthentication(req);
  if (worker) return void workspaceApi(req, res, worker.owner, worker.workerId);
  res.writeHead(401);
  res.end('{}');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
test.after(() => server.close());

/** A coordinator run claimed by an earlier process, and that process's assignment file. */
function leftover(workerId: string, assignment: Record<string, unknown>) {
  const enrollment = enrollWorker(owner, { workerId });
  workerCommand(owner, '/workers/register', { workerId, instanceId: 'before-restart' });
  save('worker', owner, {
    ...get('worker', owner, workerId),
    heartbeat: new Date(0).toISOString(),
  });
  const task = createTask(owner, { title: 'Interrupted by a restart', workerId });
  startRun(owner, task.id, { revision: 0, content: 'Work' });
  const run = workerCommand(owner, `/workers/${workerId}/poll`, {
    instanceId: 'before-restart',
  }).run;
  const root = join(data, workerId);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'assignment.json'),
    JSON.stringify({
      run,
      task: get('task', owner, task.id),
      project: null,
      workspacePath: join(root, 'tasks', task.id),
      sequence: 0,
      events: [],
      terminal: null,
      ...assignment,
    }),
  );
  const child = spawn(process.execPath, [resolve('server/workspace/remote-worker.ts')], {
    env: {
      ...process.env,
      DEPLOY_COORDINATOR_URL: origin,
      DEPLOY_WORKER_ID: workerId,
      DEPLOY_WORKER_TOKEN: enrollment.workerToken,
      DEPLOY_WORKER_ROOT: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { task, run, root, child, output: () => output };
}
const archived = (root: string) =>
  readdirSync(root).filter((name) => name.startsWith('assignment.json.resolved-'));

test('a worker whose agent died with it reports the run interrupted and archives it', async () => {
  const dead = spawnSync('true').pid;
  const { task, run, root, child, output } = leftover('dead-agent', { pid: dead });
  try {
    const resolved = await until(() => {
      const current = get('run', owner, run.id);
      return current.status === 'interrupted' && current;
    });
    assert.equal(resolved.error, restartInterruptedError);
    assert.equal(resolved.recovery.method, 'worker-attested');
    assert.equal(get('task', owner, task.id).status, 'review');
    await until(() => archived(root).length === 1);
    assert.equal(existsSync(join(root, 'assignment.json')), false);
    const kept = JSON.parse(readFileSync(join(root, archived(root)[0]), 'utf8'));
    assert.equal(kept.run.id, run.id);
    // The worker keeps polling for work instead of exiting.
    await until(() => /archived its assignment/.test(output()));
    assert.equal(child.exitCode, null);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close');
  }
});

test('a surviving agent holds the run until it exits; then the worker resolves it', async () => {
  const agent = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const { task, run, root, child, output } = leftover('live-agent', { pid: agent.pid });
  try {
    const waiting = await until(() => {
      const current = get('run', owner, run.id);
      return current.status === 'unknown' && current;
    });
    assert.equal(waiting.recovery.process, 'alive');
    assert.equal(get('task', owner, task.id).status, 'blocked');
    assert.throws(
      () =>
        markRunStopped(owner, task.id, {
          revision: get('task', owner, task.id).revision,
          confirm: true,
        }),
      /still running/,
    );
    await until(() => /is still running; no new work starts/.test(output()));
    assert.equal(archived(root).length, 0);
    process.kill(-agent.pid!, 'SIGKILL');
    await until(() => get('run', owner, run.id).status === 'interrupted');
    await until(() => archived(root).length === 1);
    assert.equal(child.exitCode, null);
  } finally {
    try {
      process.kill(-agent.pid!, 'SIGKILL');
    } catch {}
    child.kill('SIGTERM');
    await once(child, 'close');
  }
});

test('an unknown assignment left by an older build archives once the user marks it stopped', async () => {
  const { task, run, root, child, output } = leftover('older-build', {
    terminal: { status: 'unknown', error: restartUnknownError },
  });
  try {
    await until(() => get('run', owner, run.id).status === 'unknown');
    await until(() => /could not be reconciled/.test(output()));
    // The worker stays online but holds the writer slot rather than exiting.
    assert.equal(child.exitCode, null);
    assert.equal(archived(root).length, 0);
    await until(() => get('run', owner, run.id).recovery?.process === 'unverified');
    markRunStopped(owner, task.id, {
      revision: get('task', owner, task.id).revision,
      confirm: true,
    });
    await until(() => archived(root).length === 1);
    assert.equal(get('run', owner, run.id).recovery.method, 'user-confirmed');
    // Freed: the next message reaches this worker as a new assignment.
    const next = startRun(owner, task.id, {
      revision: get('task', owner, task.id).revision,
      content: 'Continue',
    });
    await until(() => get('run', owner, next.id).status !== 'queued');
    assert.equal(
      list('run', owner).find((row) => row.id === next.id)?.assignedInstanceId,
      get('worker', owner, 'older-build').instanceId,
    );
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close');
  }
});
