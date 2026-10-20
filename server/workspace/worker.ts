import { claimWorker } from './worker-lease.ts';
import { InteractiveRunner } from './interactive-runtime.ts';
import { interactiveWorker } from './interactive.ts';
import { refreshCapabilities, workerCapabilities } from './worker-capabilities.ts';
import { recoverChecks, tickChecks, stopChecks } from './check-runner.ts';
import { closeTasksForMergedPulls } from './project-collaboration.ts';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { agentLaunch, agentModelEnvironment, coordinationInstructions } from './agent-launch.ts';
import { coordinationApi } from './coordination-api.ts';
import { issueAgentToken, jobCommand } from './coordination.ts';
import { JobRunner } from './job-runner.ts';
import { resolve } from 'node:path';
import { root } from './store.ts';
// Independent ordinary-user worker. Run separately from the coordinator.
import { spawn } from 'node:child_process';
import { db, get, save, event, id, now } from './store.ts';
claimWorker('local');
const active = new Map<string, ReturnType<typeof spawn>>();
for (const row of db.prepare("SELECT * FROM records WHERE kind='run'").all() as any[]) {
  const r = JSON.parse(row.data);
  if ((!r.workerId || r.workerId === 'local') && ['starting', 'running'].includes(r.status)) {
    save('run', row.owner, {
      ...r,
      status: 'unknown',
      error: 'Worker restarted; inspect the previous process before allowing another writer',
      updatedAt: now(),
    });
    const t = get('task', row.owner, r.taskId);
    save('task', row.owner, { ...t, status: 'blocked', revision: t.revision + 1 });
    event(row.owner, r.taskId, r.id, 'run.unknown', {});
  }
}
recoverChecks();
closeTasksForMergedPulls();
const refreshInventory = () =>
  refreshCapabilities().then(() =>
    save('worker-inventory', 'system', {
      id: 'local',
      capabilities: workerCapabilities(),
      checkedAt: now(),
    }),
  );
void refreshInventory();
const capabilityTimer = setInterval(() => void refreshInventory(), 60000);
capabilityTimer.unref();
const instanceId = randomUUID();
const toolServer = createServer(coordinationApi);
await new Promise<void>((ready) => toolServer.listen(0, '127.0.0.1', ready));
const toolUrl = `http://127.0.0.1:${(toolServer.address() as any).port}/api/workspace/agent/tools`;
const jobRunners = new Map<string, JobRunner>();
const interactiveRunners = new Map<string, InteractiveRunner>();
const interactiveTimer = setInterval(() => {
  for (const row of db
    .prepare("SELECT DISTINCT owner FROM records WHERE kind='task'")
    .all() as any[]) {
    if (!interactiveRunners.has(row.owner))
      interactiveRunners.set(
        row.owner,
        new InteractiveRunner(async (action, body) =>
          interactiveWorker(row.owner, 'local', action, { ...body, instanceId }),
        ),
      );
    void interactiveRunners.get(row.owner)!.tick();
  }
}, 500);
let shuttingDown = false;
function tick() {
  if (shuttingDown) return;
  tickChecks();
  for (const row of db
    .prepare("SELECT DISTINCT owner FROM records WHERE kind='job'")
    .all() as any[]) {
    if (!jobRunners.has(row.owner))
      jobRunners.set(
        row.owner,
        new JobRunner(
          resolve(root, 'jobs', Buffer.from(row.owner).toString('hex')),
          async (action, body) => jobCommand(row.owner, 'local', action, { ...body, instanceId }),
        ),
      );
    void jobRunners
      .get(row.owner)!
      .tick()
      .catch((error) => console.error('Local job:', error.message));
  }
  db.prepare('UPDATE worker SET heartbeat=? WHERE id=?').run(now(), 'local');
  for (const row of db.prepare("SELECT * FROM records WHERE kind='run'").all() as any[]) {
    const run = JSON.parse(row.data);
    if (run.workerId && run.workerId !== 'local') continue;
    if (run.stopRequested && active.has(run.id)) {
      const child = active.get(run.id)!;
      try {
        process.kill(-child.pid!, 'SIGTERM');
        if (!run.killAfter) save('run', row.owner, { ...run, killAfter: Date.now() + 3000 });
        else if (Date.now() > run.killAfter) process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      continue;
    }
    if (run.status !== 'queued' || active.has(run.id)) continue;
    if (run.stopRequested) {
      finish(row.owner, run, 'interrupted', null);
      continue;
    }
    const task = get('task', row.owner, run.taskId);
    if (task.workspaceStatus && task.workspaceStatus !== 'ready') continue;
    save('run', row.owner, { ...run, status: 'starting', updatedAt: now() });
    const launch = agentLaunch(run);
    const agentToken = issueAgentToken({ owner: row.owner, taskId: task.id, runId: run.id });
    const child = spawn(launch.executable, launch.args, {
      cwd: task.workspacePath,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DEPLOY_AGENT_URL: toolUrl,
        DEPLOY_AGENT_TOKEN: agentToken,
        DEPLOY_AGENT_SESSION_ID: run.sessionId || '',
        ...agentModelEnvironment(run),
        DEPLOY_MODEL_SESSION_FILE: resolve(root, 'model-sessions', `${task.id}.json`),
      },
    });
    active.set(run.id, child);
    save('run', row.owner, { ...run, status: 'running', pid: child.pid, updatedAt: now() });
    event(row.owner, run.taskId, run.id, 'run.running', {});
    child.stdin.end(run.prompt + coordinationInstructions);
    let buffer = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        try {
          const data = JSON.parse(line);
          event(row.owner, run.taskId, run.id, data.type || 'provider.event', data);
          if (data.type === 'thread.started') {
            const current = get('run', row.owner, run.id);
            save('run', row.owner, { ...current, sessionId: data.thread_id });
          }
          if (
            ['item.updated', 'item.completed'].includes(data.type) &&
            data.item?.type === 'agent_message' &&
            typeof data.item.text === 'string'
          ) {
            const msg = {
              id: data.item.id ? `${run.id}:item:${data.item.id}` : id(),
              taskId: run.taskId,
              role: 'assistant',
              adapter: run.adapter,
              content: data.item.text,
              createdAt: now(),
            };
            save('message', row.owner, msg);
            event(row.owner, run.taskId, run.id, 'message', msg);
          }
        } catch {
          event(row.owner, run.taskId, run.id, 'provider.output', { text: line });
        }
      }
    });
    child.stderr.on('data', (data) => {
      stderr = (stderr + data).slice(-10000);
    });
    child.once('error', (error) => {
      active.delete(run.id);
      finish(row.owner, run, 'failed', error.message);
    });
    child.once('close', (code) => {
      active.delete(run.id);
      const current = get('run', row.owner, run.id);
      if (['failed', 'interrupted', 'succeeded'].includes(current.status)) return;
      finish(
        row.owner,
        run,
        current.stopRequested ? 'interrupted' : code === 0 ? 'succeeded' : 'failed',
        current.stopRequested || code === 0 ? null : stderr || `Agent exited ${code}`,
      );
    });
  }
}
function finish(owner: string, run: any, status: string, error: string | null) {
  const current = get('run', owner, run.id);
  save('run', owner, { ...current, status, error, updatedAt: now() });
  const task = get('task', owner, run.taskId);
  save('task', owner, {
    ...task,
    status: status === 'failed' ? 'failed' : 'review',
    revision: task.revision + 1,
    updatedAt: now(),
  });
  event(owner, run.taskId, run.id, `run.${status}`, { status, error });
}
const workerTimer = setInterval(tick, 500);
tick();
console.log('Workspace worker ready (local, ordinary user)');
process.on('SIGTERM', () => {
  shuttingDown = true;
  clearInterval(workerTimer);
  clearInterval(interactiveTimer);
  for (const runner of interactiveRunners.values()) void runner.shutdown();
  stopChecks();
  for (const runner of jobRunners.values()) runner.shutdown();
  toolServer.close();
  for (const child of active.values())
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {}
  setTimeout(() => process.exit(0), 1500);
});
