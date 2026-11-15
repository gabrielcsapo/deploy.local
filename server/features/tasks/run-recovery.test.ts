import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-run-recovery-'));
await import('../../test-ports.ts');
const { workerCommand } = await import('../../workspace/protocol.ts');
const { get, list, save, events } = await import('../../workspace/store.ts');
const { createTask } = await import('../../workspace/test-repository.ts');
const { startRun, stopRun, setTaskOutcome } = await import('../../workspace/service.ts');
const { markRunStopped, recoveryView } = await import('./run-recovery.ts');
const { restartInterruptedError, processGroupAlive } = await import('./restart-recovery.ts');

const owner = 'recovery';
const register = (workerId: string, instanceId: string) => {
  // The previous process stopped heartbeating, so a new one may take the identity.
  const previous = list('worker', owner).find((worker) => worker.id === workerId);
  if (previous) save('worker', owner, { ...previous, heartbeat: new Date(0).toISOString() });
  return workerCommand(owner, '/workers/register', {
    workerId,
    instanceId,
    platform: 'linux',
    codex: true,
  });
};
const poll = (workerId: string, instanceId: string, extra: any = {}) =>
  workerCommand(owner, `/workers/${workerId}/poll`, { instanceId, ...extra });
const complete = (workerId: string, instanceId: string, run: any, body: any) =>
  workerCommand(owner, `/workers/${workerId}/complete`, {
    instanceId,
    runId: run.id,
    generation: run.generation,
    ...body,
  });
const goOffline = (workerId: string) =>
  save('worker', owner, {
    ...get('worker', owner, workerId),
    heartbeat: new Date(Date.now() - 60000).toISOString(),
  });

/** A run that instance `first` was running when it restarted as `second`. */
function restartedRun(workerId: string, process: 'alive' | 'unverified' = 'unverified') {
  register(workerId, `${workerId}-first`);
  const task = createTask(owner, { title: `Task on ${workerId}`, workerId });
  startRun(owner, task.id, { revision: 0, content: 'Build the thing' });
  const claimed = poll(workerId, `${workerId}-first`).run;
  assert.equal(claimed.status, 'starting');
  workerCommand(owner, `/workers/${workerId}/events`, {
    instanceId: `${workerId}-first`,
    runId: claimed.id,
    generation: claimed.generation,
    events: [{ sequence: 1, type: 'thread.started', payload: { thread_id: 'session-1' } }],
  });
  register(workerId, `${workerId}-second`);
  complete(workerId, `${workerId}-second`, claimed, {
    status: 'unknown',
    error: 'Remote worker restarted; previous process must be reconciled',
    process,
  });
  const run = get('run', owner, claimed.id);
  assert.equal(run.status, 'unknown');
  assert.equal(get('task', owner, task.id).status, 'blocked');
  return { task: get('task', owner, task.id), run };
}

test('a restarted worker with no assignment state attests absence and is freed', () => {
  const { task, run } = restartedRun('attest');
  assert.equal(run.recovery.process, 'unverified');
  // Before resolution the task keeps its single writer slot.
  assert.throws(
    () => startRun(owner, task.id, { revision: task.revision, content: 'Again' }),
    /active run/,
  );
  assert.throws(
    () => setTaskOutcome(owner, task.id, 'close', { revision: task.revision }),
    /Stop the task/,
  );
  register('attest', 'attest-third');
  const result = poll('attest', 'attest-third', { noAssignment: true });
  assert.equal(result.run, null);
  const resolved = get('run', owner, run.id);
  assert.equal(resolved.status, 'interrupted');
  assert.equal(resolved.error, restartInterruptedError);
  assert.equal(resolved.recovery.method, 'worker-attested');
  assert.equal(resolved.recovery.attestedBy, 'attest-third');
  assert.equal(resolved.updatedAt, run.updatedAt, 'duration ends at the restart');
  assert.equal(get('task', owner, task.id).status, 'review');
  assert.equal(recoveryView(owner, resolved)?.state, 'resolved');
  // The composer works again and resumes the provider session.
  const next = startRun(owner, task.id, {
    revision: get('task', owner, task.id).revision,
    content: 'Carry on',
  });
  assert.equal(next.sessionId, 'session-1');
  assert.equal(next.prompt, 'Carry on');
  const claimed = poll('attest', 'attest-third', { noAssignment: true }).run;
  assert.equal(claimed.id, next.id);
  assert.equal(claimed.assignedInstanceId, 'attest-third');
});

test('the process that started a run, or another worker, cannot attest its restart', () => {
  const { run } = restartedRun('owner-only');
  // A process that registered after the restart report but holds the original instance id.
  register('owner-only', 'owner-only-first');
  assert.equal(poll('owner-only', 'owner-only-first', { noAssignment: true }).run.id, run.id);
  assert.throws(
    () =>
      complete('owner-only', 'owner-only-first', run, {
        status: 'interrupted',
        error: restartInterruptedError,
      }),
    /cannot resolve its restart/,
  );
  register('bystander', 'bystander-1');
  assert.equal(poll('bystander', 'bystander-1', { noAssignment: true }).run, null);
  assert.throws(
    () => complete('bystander', 'bystander-1', run, { status: 'interrupted' }),
    /Stale worker assignment/,
  );
  assert.equal(get('run', owner, run.id).status, 'unknown');
});

test('repeated unknown reports are idempotent and a verified exit resolves the run', () => {
  const { task, run } = restartedRun('reporter', 'alive');
  const revision = get('task', owner, task.id).revision;
  const recorded = events(owner, 0, task.id).length;
  complete('reporter', 'reporter-second', run, { status: 'unknown', process: 'alive' });
  assert.equal(get('task', owner, task.id).revision, revision);
  assert.equal(events(owner, 0, task.id).length, recorded);
  // While the computer says the agent still runs, the user cannot mark it stopped.
  const view = recoveryView(owner, get('run', owner, run.id));
  assert.equal(view?.state, 'process-running');
  assert.equal(view?.canMarkStopped, false);
  assert.throws(() => markRunStopped(owner, task.id, { revision, confirm: true }), /still running/);
  assert.throws(
    () => complete('reporter', 'reporter-second', run, { status: 'succeeded' }),
    /only be reported as interrupted/,
  );
  // The worker saw the agent's process group exit.
  complete('reporter', 'reporter-second', run, {
    status: 'interrupted',
    error: restartInterruptedError,
    sessionId: 'session-1',
  });
  const resolved = get('run', owner, run.id);
  assert.equal(resolved.status, 'interrupted');
  assert.equal(resolved.recovery.method, 'worker-attested');
  assert.equal(get('task', owner, task.id).status, 'review');
  // A late report from the waiting worker learns the run was resolved.
  assert.equal(
    complete('reporter', 'reporter-second', run, { status: 'unknown' }).status,
    'interrupted',
  );
});

test('older workers that cannot attest fall back to Stop once they poll statelessly', () => {
  const { task, run } = restartedRun('legacy');
  register('legacy', 'legacy-third');
  // An older build polls without noAssignment: the run stays assigned and nothing new starts.
  assert.equal(poll('legacy', 'legacy-third').run.id, run.id);
  const waiting = get('run', owner, run.id);
  assert.equal(waiting.status, 'unknown');
  assert.equal(waiting.recovery.idleInstanceId, 'legacy-third');
  const view = recoveryView(owner, waiting);
  assert.equal(view?.state, 'needs-confirmation');
  assert.equal(view?.canMarkStopped, true);
  assert.match(view!.detail, /can't confirm that on its own/);
  const stopped = stopRun(owner, task.id, { revision: get('task', owner, task.id).revision });
  assert.equal(stopped.status, 'review');
  const resolved = get('run', owner, run.id);
  assert.equal(resolved.status, 'interrupted');
  assert.equal(resolved.recovery.method, 'stopped-after-restart');
  assert.equal(poll('legacy', 'legacy-third').run, null);
});

test('Stop pressed before an older worker returns resolves on its first stateless poll', () => {
  const { task, run } = restartedRun('later');
  goOffline('later');
  stopRun(owner, task.id, { revision: task.revision });
  assert.equal(get('run', owner, run.id).status, 'unknown');
  const view = recoveryView(owner, get('run', owner, run.id));
  assert.equal(view?.state, 'waiting-for-computer');
  assert.equal(view?.stopRequested, true);
  register('later', 'later-third');
  assert.equal(poll('later', 'later-third').run, null);
  assert.equal(get('run', owner, run.id).recovery.method, 'stopped-after-restart');
});

test('an offline computer can be marked stopped only by explicit confirmation', () => {
  const { task, run } = restartedRun('offline');
  goOffline('offline');
  const view = recoveryView(owner, get('run', owner, run.id));
  assert.equal(view?.state, 'waiting-for-computer');
  assert.equal(view?.canMarkStopped, true);
  assert.match(view!.title, /Interrupted — the computer restarted during this run/);
  assert.throws(() => markRunStopped(owner, task.id, { revision: task.revision }), /Confirm/);
  assert.throws(
    () => markRunStopped(owner, task.id, { revision: task.revision - 1, confirm: true }),
    /Task changed/,
  );
  const saved = markRunStopped(owner, task.id, { revision: task.revision, confirm: true });
  assert.equal(saved.status, 'review');
  const resolved = get('run', owner, run.id);
  assert.equal(resolved.status, 'interrupted');
  assert.equal(resolved.recovery.method, 'user-confirmed');
  assert.equal(resolved.recovery.confirmedBy, owner);
  assert.throws(
    () => markRunStopped(owner, task.id, { revision: saved.revision, confirm: true }),
    /no interrupted run/,
  );
  // An offline worker that last reported the agent alive cannot be overridden.
  const alive = restartedRun('offline-alive', 'alive');
  goOffline('offline-alive');
  assert.equal(recoveryView(owner, alive.run)?.canMarkStopped, false);
});

test('a turn lost before its session started hands the conversation to the next turn', () => {
  register('lost', 'lost-first');
  const task = createTask(owner, { title: 'Lost turn', workerId: 'lost' });
  startRun(owner, task.id, { revision: 0, content: 'First request' });
  const claimed = poll('lost', 'lost-first').run;
  register('lost', 'lost-second');
  assert.equal(poll('lost', 'lost-second', { noAssignment: true }).run, null);
  assert.equal(get('run', owner, claimed.id).recovery.previousStatus, 'starting');
  const next = startRun(owner, task.id, {
    revision: get('task', owner, task.id).revision,
    content: 'Second request',
  });
  assert.equal(next.sessionId, null);
  assert.match(next.prompt, /interrupted when the computer restarted/);
  assert.match(next.prompt, /user: First request/);
  assert.match(next.prompt, /Current user instruction:\nSecond request$/);
});

test('process group liveness is definitive only when the group is gone', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  assert.equal(processGroupAlive(undefined), null);
  assert.equal(processGroupAlive(1), null);
  assert.equal(processGroupAlive(spawnSync('true').pid), false);
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    assert.equal(processGroupAlive(sleeper.pid), true);
  } finally {
    process.kill(-sleeper.pid!, 'SIGKILL');
  }
});

test('checks left running by a restart resolve instead of wedging the task', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { recoverChecks, tickChecks } = await import('../../workspace/check-runner.ts');
  const { activeCheck } = await import('./checks.ts');
  const check = (taskId: string, extra: any) =>
    save('check', owner, {
      id: `check-${taskId}`,
      taskId,
      command: 'sleep 30',
      status: 'running',
      output: '',
      exitCode: null,
      error: null,
      timeoutMs: 60000,
      ...extra,
    });
  const dead = createTask(owner, { title: 'Check whose command died' });
  check(dead.id, { pid: spawnSync('true').pid });
  const sleeper = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  const live = createTask(owner, { title: 'Check whose command survived' });
  check(live.id, { pid: sleeper.pid });
  const launching = createTask(owner, { title: 'Check that died while launching' });
  check(launching.id, {});
  try {
    recoverChecks();
    assert.equal(get('check', owner, `check-${dead.id}`).status, 'interrupted');
    assert.equal(get('task', owner, dead.id).status, 'review');
    assert.equal(activeCheck(owner, dead.id), undefined);
    assert.equal(get('check', owner, `check-${live.id}`).status, 'unknown');
    assert.equal(get('task', owner, live.id).status, 'blocked');
    tickChecks();
    assert.equal(get('check', owner, `check-${live.id}`).status, 'unknown');
    process.kill(-sleeper.pid!, 'SIGKILL');
    await until(() => processGroupAlive(sleeper.pid) === false);
    tickChecks();
    assert.equal(get('check', owner, `check-${live.id}`).status, 'interrupted');
    assert.equal(get('task', owner, live.id).status, 'review');
    // Without a pid nothing can be verified, so it waits for the user's Stop.
    tickChecks();
    assert.equal(get('check', owner, `check-${launching.id}`).status, 'unknown');
    stopRun(owner, launching.id, { revision: get('task', owner, launching.id).revision });
    tickChecks();
    assert.equal(get('check', owner, `check-${launching.id}`).status, 'interrupted');
    startRun(owner, launching.id, {
      revision: get('task', owner, launching.id).revision,
      content: 'Try again',
    });
  } finally {
    try {
      process.kill(-sleeper.pid!, 'SIGKILL');
    } catch {}
  }
});

async function until(read: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!read()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((done) => setTimeout(done, 50));
  }
}
