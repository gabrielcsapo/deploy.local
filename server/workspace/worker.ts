import { runAgentContext } from './agent-context-store.ts';
import { workerRoleEnabled } from './computer-role-policy.ts';
import { writeNodeSnapshot } from './node-status.ts';
import { nodeCapabilities } from './node-permissions.ts';
import { controlPaused } from './node-control.ts';
import { hostname } from 'node:os';
import { uploadRecording } from './recording-upload.ts';
import { createReadStream } from 'node:fs';
import { attachmentBytes, createAttachment } from './attachments.ts';
import { materializeImages, rewriteMedia, readWorkspaceMedia } from './media-files.ts';
import { basename } from 'node:path';
import { claimWorker } from './worker-lease.ts';
import { InteractiveRunner } from './interactive-runtime.ts';
import { interactiveWorker } from './interactive.ts';
import { refreshCapabilities, workerCapabilities } from './worker-capabilities.ts';
import { recoverChecks, tickChecks, stopChecks } from './check-runner.ts';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { agentLaunch, agentModelEnvironment } from './agent-launch.ts';
import { coordinationApi } from './coordination-api.ts';
import { issueAgentToken, jobCommand } from './coordination.ts';
import { JobRunner } from './job-runner.ts';
import { resolve } from 'node:path';
import { root } from './store.ts';
// Independent ordinary-user worker. Run separately from the coordinator.
import { spawn } from 'node:child_process';
import { db, get, list, save, event, id, now } from './store.ts';
import { captureTurnCheckpoint } from './turn-checkpoint.ts';
import { releaseQueuedMessage } from './queued-message.ts';
const checkpoint = (cwd: string) => {
  try {
    return captureTurnCheckpoint(cwd);
  } catch {
    return null;
  }
};
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
    releaseQueuedMessage(row.owner, r.taskId, 'unknown');
  }
}
recoverChecks();
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
        new InteractiveRunner(
          async (action, body) =>
            interactiveWorker(row.owner, 'local', action, { ...body, instanceId }),
          {
            uploadRecording: (session, path) =>
              uploadRecording(createReadStream(path), row.owner, 'local', session.id, instanceId),
          },
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
  writeNodeSnapshot({
    enrolled: true,
    coordinatorUrl: process.env.DEPLOY_COORDINATOR_URL || null,
    workerId: 'local',
    workerName: hostname(),
    online: true,
    runningTaskCount: active.size,
    capabilities:
      interactiveRunners.values().next().value?.capabilities() ||
      nodeCapabilities(
        {
          worker: { id: 'local', name: hostname(), platform: process.platform, status: 'online' },
          managed: false,
          targets: [],
          fresh: false,
          browserProjects: [],
        },
        controlPaused(),
      ),
  });
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
    if (!workerRoleEnabled(row.owner, 'local', 'tasks')) continue;
    if (run.stopRequested) {
      finish(row.owner, run, 'interrupted', null);
      continue;
    }
    const task = get('task', row.owner, run.taskId);
    if (task.workspaceStatus && task.workspaceStatus !== 'ready') continue;
    Object.assign(run, runAgentContext(row.owner, run));
    // The turn diff compares this tree with the one captured when the run ends.
    save('run', row.owner, {
      ...run,
      status: 'starting',
      startCheckpoint: checkpoint(task.workspacePath),
      updatedAt: now(),
    });
    let images;
    try {
      images = materializeImages(
        (run.attachmentIds || [])
          .filter(
            (attachmentId: string) => get('attachment', row.owner, attachmentId).kind === 'image',
          )
          .map((attachmentId: string) => {
            const { row: attachment, data } = attachmentBytes(row.owner, attachmentId);
            return {
              id: attachmentId,
              data: data.toString('base64'),
              mimeType: attachment.mimeType,
            };
          }),
      );
    } catch (failure: any) {
      void finish(row.owner, run, 'failed', `Image input unavailable: ${failure.message}`);
      continue;
    }
    const launch = agentLaunch({ ...run, imagePaths: images.paths });
    const agentToken = issueAgentToken({ owner: row.owner, taskId: task.id, runId: run.id });
    const child = spawn(launch.executable, launch.args, {
      cwd: task.workspacePath,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...launch.env,
        DEPLOY_IMAGE_PATHS: JSON.stringify(images.paths),
        DEPLOY_AGENT_URL: toolUrl,
        DEPLOY_AGENT_TOKEN: agentToken,
        DEPLOY_AGENT_SESSION_ID: run.sessionId || '',
        ...agentModelEnvironment(run),
        DEPLOY_MODEL_SESSION_FILE: resolve(root, 'model-sessions', `${task.id}.json`),
      },
    });
    active.set(run.id, child);
    save('run', row.owner, {
      ...get('run', row.owner, run.id),
      status: 'running',
      pid: child.pid,
      updatedAt: now(),
    });
    event(row.owner, run.taskId, run.id, 'run.running', {});
    event(row.owner, run.taskId, run.id, 'agent.instructions', {
      delivery: launch.instructionDelivery,
      capturedAt: run.agentContextAt,
    });
    child.stdin.end(run.prompt);
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
              runId: run.id,
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
      images!.cleanup();
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
const finishing = new Set<string>();
async function finish(owner: string, run: any, status: string, error: string | null) {
  if (finishing.has(run.id)) return;
  finishing.add(run.id);
  try {
    const task = get('task', owner, run.taskId);
    const last = list('message', owner)
      .filter(
        (m) =>
          m.taskId === task.id &&
          m.role === 'assistant' &&
          (m.runId === run.id || m.id.startsWith(run.id + ':')),
      )
      .at(-1);
    if (last) {
      const media = await rewriteMedia(last.content, task, async (path, caption) =>
        createAttachment(owner, task.id, readWorkspaceMedia(task.workspacePath, path), {
          operationId:
            `${run.id}:media:` +
            createHash('sha256')
              .update(JSON.stringify([path, caption]))
              .digest('hex'),
          name: basename(path),
          caption,
          source: 'agent',
          runId: run.id,
          messageId: last.id,
          kind: 'image',
        }),
      );
      const message = { ...last, ...media, runId: run.id };
      save('message', owner, message);
      event(owner, task.id, run.id, 'message', message);
    }
    const latest = get('run', owner, run.id);
    if (latest.stopRequested) status = 'interrupted';
    const updatedTask = get('task', owner, task.id);
    save('run', owner, {
      ...latest,
      status,
      error,
      checkpoint: checkpoint(task.workspacePath),
      updatedAt: now(),
    });
    save('task', owner, {
      ...updatedTask,
      status: status === 'failed' ? 'failed' : 'review',
      revision: updatedTask.revision + 1,
      updatedAt: now(),
    });
    event(owner, run.taskId, run.id, `run.${status}`, { status, error });
    releaseQueuedMessage(owner, run.taskId, status);
  } finally {
    finishing.delete(run.id);
  }
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
