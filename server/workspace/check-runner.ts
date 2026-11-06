import { computerInstallConfig } from '../packages/builds.ts';
import { prepareAgentInstall } from './agent-packages.ts';
import { secretOutput } from '../../shared/package-install.mjs';
import { root } from './store.ts';
import { join } from 'node:path';
import { shellEnvironment } from './shell-environment.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { db, get, save, event, now } from './store.ts';
import { processGroupAlive } from './restart-recovery.ts';
const restartedCheckError =
  'The computer restarted during this check; run it again to get a result';
let closing = false;
const active = new Map<
  string,
  {
    child: ChildProcess;
    timer: ReturnType<typeof setTimeout>;
    killTimer?: ReturnType<typeof setTimeout>;
  }
>();
export function recoverChecks() {
  for (const row of db.prepare("SELECT * FROM records WHERE kind='check'").all() as any[]) {
    const check = JSON.parse(row.data);
    if (check.status === 'running') {
      // Checks run detached, so the command can outlive the worker; only a gone group is safe.
      if (processGroupAlive(check.pid) === false) {
        finish(row.owner, check.id, 'interrupted', null, restartedCheckError);
        continue;
      }
      save('check', row.owner, {
        ...check,
        status: 'unknown',
        error:
          'Worker restarted while this check was running; reconcile the previous process before another writer',
        updatedAt: now(),
      });
      const task = get('task', row.owner, check.taskId);
      save('task', row.owner, {
        ...task,
        status: 'blocked',
        revision: task.revision + 1,
        updatedAt: now(),
      });
      event(row.owner, check.taskId, null, 'check.unknown', { id: check.id });
    }
  }
}
function stop(checkId: string) {
  const current = active.get(checkId);
  if (!current) return;
  try {
    process.kill(-current.child.pid!, 'SIGTERM');
  } catch {}
  if (!current.killTimer)
    current.killTimer = setTimeout(() => {
      if (active.get(checkId) === current)
        try {
          process.kill(-current.child.pid!, 'SIGKILL');
        } catch {}
    }, 1000);
}
export function tickChecks() {
  if (closing) return;
  for (const row of db.prepare("SELECT * FROM records WHERE kind='check'").all() as any[]) {
    const check = JSON.parse(row.data);
    // Left running by a previous worker process: free the task once nothing of it remains. A
    // check without a recorded pid died while launching, so nothing can be checked and the
    // user's Stop resolves it.
    if (check.status === 'unknown') {
      const alive = processGroupAlive(check.pid);
      if (alive === false || (alive === null && check.stopRequested))
        finish(row.owner, check.id, 'interrupted', null, restartedCheckError);
      continue;
    }
    if (check.status === 'running' && check.stopRequested) {
      stop(check.id);
      continue;
    }
    if (check.status !== 'queued') continue;
    if (check.stopRequested) {
      finish(row.owner, check.id, 'interrupted', null, 'Stopped before launch');
      continue;
    }
    const task = get('task', row.owner, check.taskId);
    save('check', row.owner, { ...check, status: 'running', updatedAt: now() });
    event(row.owner, task.id, null, 'check.running', { id: check.id, command: check.command });
    void (async () => {
      const install = await prepareAgentInstall(
        () => computerInstallConfig(row.owner, 'local', task.projectId),
        {
          cwd: task.workspacePath,
          root: join(root, 'check-packages'),
          log: (line) => {
            const value = get('check', row.owner, check.id);
            save('check', row.owner, { ...value, output: (value.output || '') + line + '\n' });
          },
        },
      );
      if (closing || get('check', row.owner, check.id).stopRequested) {
        await install.cleanup();
        finish(row.owner, check.id, 'interrupted', null, 'Stopped before launch');
        return;
      }
      const child = spawn('/bin/sh', ['-lc', check.command], {
        cwd: task.workspacePath,
        detached: true,
        env: { ...shellEnvironment(), ...install.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => {
        const value = get('check', row.owner, check.id);
        save('check', row.owner, {
          ...value,
          timedOut: true,
          error: `Check exceeded ${check.timeoutMs} ms timeout`,
          updatedAt: now(),
        });
        stop(check.id);
      }, check.timeoutMs);
      active.set(check.id, { child, timer });
      save('check', row.owner, { ...get('check', row.owner, check.id), pid: child.pid });
      const output = (chunk: string) => {
        const value = get('check', row.owner, check.id);
        save('check', row.owner, {
          ...value,
          output: (value.output + chunk.toString()).slice(-256000),
          updatedAt: now(),
        });
        event(row.owner, task.id, null, 'check.output', {
          id: check.id,
          text: chunk.toString().slice(0, 32000),
        });
      };
      const redacted = secretOutput(install.secrets, output);
      child.stdout!.on('data', redacted.write);
      child.stderr!.on('data', redacted.write);
      child.once('error', (error) => finish(row.owner, check.id, 'failed', null, error.message));
      child.once('close', async (code) => {
        redacted.end();
        await install.cleanup();
        const value = get('check', row.owner, check.id);
        if (!['running', 'queued'].includes(value.status)) return;
        finish(
          row.owner,
          check.id,
          value.stopRequested
            ? 'interrupted'
            : value.timedOut || code !== 0
              ? 'failed'
              : 'succeeded',
          code,
          value.error,
        );
      });
    })().catch((error) => finish(row.owner, check.id, 'failed', null, error.message));
  }
}
function finish(
  owner: string,
  checkId: string,
  status: string,
  exitCode: number | null,
  error: string | null,
) {
  const current = active.get(checkId);
  if (current) {
    clearTimeout(current.timer);
    if (current.killTimer) clearTimeout(current.killTimer);
    active.delete(checkId);
  }
  const check = get('check', owner, checkId);
  save('check', owner, { ...check, status, exitCode, error, updatedAt: now() });
  const task = get('task', owner, check.taskId);
  save('task', owner, { ...task, status: 'review', revision: task.revision + 1, updatedAt: now() });
  event(owner, task.id, null, `check.${status}`, { id: checkId, status, exitCode, error });
}
export function stopChecks() {
  closing = true;
  for (const checkId of active.keys()) stop(checkId);
}
