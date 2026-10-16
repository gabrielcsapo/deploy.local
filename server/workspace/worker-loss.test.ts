import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-worker-loss-'));
const { get, list } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { startRun } = await import('./service.ts');

test('abrupt worker loss preserves files, fences the orphan writer and never redispatches', async () => {
  const executable = join(process.env.DEPLOY_DATA_DIR!, 'agent');
  writeFileSync(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
process.stdin.resume();
process.stdin.on('end',()=>{
 fs.appendFileSync('launches.txt','launched\\n');
 fs.writeFileSync('partial.txt','work before interruption');
 console.log(JSON.stringify({type:'thread.started',thread_id:'retained-session'}));
 setInterval(()=>{},1000);
});
`,
    { mode: 0o700 },
  );
  const children: ReturnType<typeof spawn>[] = [];
  let agentPid: number | undefined;
  const worker = () => {
    const child = spawn(process.execPath, ['server/workspace/worker.ts'], {
      env: { ...process.env, DEPLOY_CODEX_BIN: executable },
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  };
  async function waitFor(predicate: () => boolean) {
    const until = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > until) throw new Error('Worker loss acceptance timed out');
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  try {
    const project = createProject('alice', { name: 'Interrupted work' });
    const task = createTask('alice', { projectId: project.id, title: 'Keep partial files' });
    const run = startRun('alice', task.id, { revision: 0, content: 'Work' });
    const first = worker();
    await waitFor(() => existsSync(join(task.workspacePath, 'partial.txt')));
    agentPid = get('run', 'alice', run.id).pid;
    await waitFor(() => get('run', 'alice', run.id).sessionId === 'retained-session');
    const exited = once(first, 'exit');
    first.kill('SIGKILL');
    await exited;
    assert.doesNotThrow(
      () => process.kill(agentPid!, 0),
      'orphan agent is still potentially writing',
    );
    worker();
    await waitFor(() => get('run', 'alice', run.id).status === 'unknown');
    assert.equal(get('task', 'alice', task.id).status, 'blocked');
    assert.equal(get('run', 'alice', run.id).sessionId, 'retained-session');
    assert.throws(
      () =>
        startRun('alice', task.id, {
          revision: get('task', 'alice', task.id).revision,
          content: 'Try again',
        }),
      /active run/,
    );
    assert.equal(readFileSync(join(task.workspacePath, 'launches.txt'), 'utf8'), 'launched\n');
    assert.equal(
      readFileSync(join(task.workspacePath, 'partial.txt'), 'utf8'),
      'work before interruption',
    );
    assert.equal(list('run', 'alice').length, 1);
  } finally {
    if (agentPid) {
      try {
        process.kill(-agentPid, 'SIGKILL');
      } catch {
        /* Already exited. */
      }
    }
    await Promise.all(
      children
        .filter((c) => c.exitCode === null && c.signalCode === null)
        .map(async (child) => {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }),
    );
  }
});
