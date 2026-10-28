import { ScreenshotRunner } from './screenshot-runtime.ts';
import { prepareAttachmentInput } from './attachment-input.ts';
import { InteractiveRunner } from './interactive-runtime.ts';
import { refreshCapabilities, workerCapabilities } from './worker-capabilities.ts';
import { hydrateLfs } from './lfs-checkout.ts';
import { gitEnvironment } from './repository-git.ts';
import { modelOptions } from './model-options.ts';
import {
  applyProviderConnections,
  providerEnvironment,
  providerRuntimeState,
  beginProviderLogin,
  providerLoginActive,
} from './provider-runtime.ts';
import { initializeScratchWorkspace } from './scratch.ts';
import { agentLaunch, agentModelEnvironment, coordinationInstructions } from './agent-launch.ts';
import { JobRunner } from './job-runner.ts';
import { inspectWorkspace } from './review.ts';
import { randomUUID } from 'node:crypto';
// HTTP worker pilot: provider credentials and working files remain on this machine.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname, platform, arch } from 'node:os';
const origin = process.env.DEPLOY_COORDINATOR_URL,
  token = process.env.DEPLOY_WORKER_TOKEN,
  workerId = process.env.DEPLOY_WORKER_ID;
if (!origin || !token || !workerId || workerId === 'local' || !process.env.DEPLOY_WORKER_ROOT)
  throw new Error(
    'Set DEPLOY_COORDINATOR_URL, DEPLOY_WORKER_TOKEN, DEPLOY_WORKER_ID, DEPLOY_WORKER_ROOT',
  );
void refreshCapabilities();
const capabilityTimer = setInterval(() => void refreshCapabilities(), 60000);
capabilityTimer.unref();
const instanceId = randomUUID();
const localRoot = resolve(process.env.DEPLOY_WORKER_ROOT);
mkdirSync(localRoot, { recursive: true, mode: 0o700 });
const statePath = resolve(localRoot, 'assignment.json'),
  lockPath = resolve(localRoot, 'worker.pid');
if (existsSync(lockPath)) {
  const pid = Number(readFileSync(lockPath, 'utf8'));
  try {
    process.kill(pid, 0);
    throw new Error('Worker already running');
  } catch (e: any) {
    if (e.code !== 'ESRCH') throw e;
  }
}
writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
let state: any = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null,
  child: ReturnType<typeof spawn> | null = null,
  busy = false;
let preparation: AbortController | undefined;
function persist() {
  writeFileSync(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
  renameSync(statePath + '.tmp', statePath);
}
if (state && !state.terminal) {
  state.terminal = {
    status: 'unknown',
    error:
      'Remote worker restarted; previous process must be reconciled before assigning another writer',
  };
  persist();
}
async function request(path: string, body: any) {
  const response = await fetch(origin + '/api/workspace' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-deploy-worker-id': workerId!,
      'x-deploy-worker-token': token!,
    },
    body: JSON.stringify({ ...body, instanceId }),
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || String(response.status));
  return value;
}
const gitEnv = {
  ...gitEnvironment(),
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`,
  GIT_CONFIG_KEY_1: 'http.followRedirects',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_VALUE_0:
    'Authorization: Basic ' +
    Buffer.from('workspace-worker.' + workerId + ':' + token).toString('base64'),
};
function git(cwd: string, args: string[]) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: gitEnv,
  });
  if (result.status !== 0) throw new Error(result.stderr || 'Git failed');
  return result.stdout.trim();
}
function emit(type: string, payload: any) {
  if (!state) return;
  state.events.push({ sequence: ++state.sequence, type, payload });
  persist();
  if (statSync(statePath).size > 16 * 1024 * 1024) {
    try {
      process.kill(-child!.pid!, 'SIGTERM');
    } catch {}
    state.terminal = { status: 'failed', error: 'Worker event spool exceeded 16 MiB; run stopped' };
    persist();
  }
}
function terminate() {
  preparation?.abort();
  if (!child) return;
  try {
    process.kill(-child.pid!, 'SIGTERM');
    const pid = child.pid!;
    setTimeout(() => {
      if (child?.pid === pid)
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {}
    }, 3000).unref();
  } catch {}
}
async function start(assignment: any) {
  state = {
    ...assignment,
    workspacePath: resolve(localRoot, 'tasks', assignment.task.id),
    sequence: 0,
    events: [],
    terminal: null,
  };
  persist();
  try {
    if (!existsSync(state.workspacePath)) {
      mkdirSync(state.workspacePath, { recursive: true });
      if (!assignment.project) {
        const baseline = initializeScratchWorkspace(state.workspacePath);
        if (baseline !== assignment.task.baseRevision)
          throw new Error('Conversation baseline mismatch');
      } else {
        git(state.workspacePath, [
          'clone',
          origin + '/api/workspace/git/' + assignment.project.id,
          '.',
        ]);
        try {
          git(state.workspacePath, ['cat-file', '-e', `${assignment.task.baseRevision}^{commit}`]);
        } catch {
          git(state.workspacePath, [
            'fetch',
            'origin',
            assignment.task.sourceRef || assignment.task.baseRevision,
          ]);
          if (
            git(state.workspacePath, ['rev-parse', 'FETCH_HEAD']) !== assignment.task.baseRevision
          )
            throw new Error('Task source revision changed');
        }
        git(state.workspacePath, [
          'checkout',
          '-b',
          `task/${assignment.task.id}`,
          assignment.task.baseRevision,
        ]);
      }
    }
    if (assignment.project) {
      preparation = new AbortController();
      await hydrateLfs(
        state.workspacePath,
        origin + '/api/workspace/git/' + assignment.project.id,
        {
          signal: preparation.signal,
          timeout: 600000,
          authentication: { origin: origin!, header: gitEnv.GIT_CONFIG_VALUE_0 },
        },
      );
      preparation = undefined;
    }
    if (state.stopRequested) throw new Error('Task stopped during workspace preparation');
    const inputs = state.run.attachments?.length
      ? await screenshotRequest('attachments', { runId: state.run.id })
      : { attachments: [] };
    const attachmentPrompt = prepareAttachmentInput(state.workspacePath, inputs.attachments || []);
    const launch = agentLaunch(state.run);
    child = spawn(launch.executable, launch.args, {
      cwd: state.workspacePath,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              ![
                'DEPLOY_WORKER_TOKEN',
                'DEPLOY_WORKSPACE_TOKEN',
                'DEPLOY_WORKSPACE_USERNAME',
              ].includes(key),
          ),
        ),
        DEPLOY_AGENT_URL: origin + '/api/workspace/agent/tools',
        DEPLOY_AGENT_TOKEN: assignment.agentToken,
        DEPLOY_AGENT_SESSION_ID: state.run.sessionId || '',
        ...providerEnvironment(state.run.adapter),
        ...agentModelEnvironment(state.run, {
          ...process.env,
          ...providerEnvironment(state.run.adapter),
        }),
        DEPLOY_MODEL_SESSION_FILE: resolve(localRoot, 'model-sessions', `${state.task.id}.json`),
      },
    });
    state.pid = child.pid;
    persist();
    child.stdin!.end(state.run.prompt + attachmentPrompt + coordinationInstructions);
    let buffer = '',
      stderr = '';
    child.stdout!.on('data', (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'thread.started') state.run.sessionId = value.thread_id;
          emit(value.type || 'provider.event', value);
          if (
            ['item.updated', 'item.completed'].includes(value.type) &&
            value.item?.type === 'agent_message' &&
            typeof value.item.text === 'string'
          )
            emit('message', {
              providerItemId: value.item.id,
              role: 'assistant',
              adapter: state.run.adapter,
              content: value.item.text,
              createdAt: new Date().toISOString(),
            });
        } catch {
          emit('provider.output', { text: line });
        }
      }
    });
    child.stderr!.on('data', (chunk) => (stderr = (stderr + chunk).slice(-10000)));
    child.once('error', (error) => {
      state.terminal = { status: 'failed', error: error.message };
      persist();
      child = null;
    });
    child.once('close', (code) => {
      state.terminal = state.terminal || {
        status: state.stopRequested ? 'interrupted' : code === 0 ? 'succeeded' : 'failed',
        error: code === 0 ? null : stderr || `Agent exited ${code}`,
      };
      persist();
      child = null;
    });
  } catch (error: any) {
    preparation = undefined;
    state.terminal = {
      status: state.stopRequested ? 'interrupted' : 'failed',
      error: error.message,
    };
    persist();
  }
}
const jobs = new JobRunner(
  resolve(localRoot, 'jobs'),
  (action, body) => request(`/workers/${workerId}/jobs/${action}`, body),
  {
    origin,
    header:
      'Authorization: Basic ' +
      Buffer.from('workspace-worker.' + workerId + ':' + token).toString('base64'),
  },
);
const interactive = new InteractiveRunner((action, body) =>
  request(`/workers/${workerId}/controls/${action}`, body),
);
async function screenshotRequest(action: string, body: any) {
  const response = await fetch(origin + '/api/v2/screenshots/worker/' + action, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-deploy-worker-id': workerId!,
      'x-deploy-worker-token': token!,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || String(response.status));
  return value;
}
const screenshots = new ScreenshotRunner(screenshotRequest);
const screenshotTimer = setInterval(() => void screenshots.tick(), 500);
const interactiveTimer = setInterval(() => void interactive.tick(), 500);
const jobTimer = setInterval(
  () => void jobs.tick().catch((error) => console.error('Job worker:', error.message)),
  1000,
);
let configurationFailed = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const providers = providerRuntimeState();
    await request('/workers/register', {
      workerId,
      name: process.env.DEPLOY_WORKER_NAME || hostname(),
      version: process.env.DEPLOY_VERSION || undefined,
      screenSupported: platform() === 'darwin' && Boolean(process.env.DEPLOY_DESKTOP_HELPER),
      platform: platform(),
      architecture: arch(),
      capabilities: workerCapabilities(),
      checkpointJobs: ['linux', 'darwin'].includes(platform()),
      modelOptions: process.env.DEPLOY_MANAGED_WORKER === '1' ? providers.options : modelOptions(),
      providers: providers.usage,
      connections: providers.reports,
      configurationFailed,
      compatible: providers.available('compatible'),
      claude:
        process.env.DEPLOY_MANAGED_WORKER === '1'
          ? providers.available('claude')
          : spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0,
      codex:
        process.env.DEPLOY_MANAGED_WORKER === '1'
          ? providers.available('codex')
          : spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0,
    });
    if (!state && process.env.DEPLOY_MANAGED_WORKER === '1') {
      const configuration = await request(`/workers/${workerId}/provider-config`, {});
      try {
        await applyProviderConnections(configuration.connections, localRoot);
        configurationFailed = false;
      } catch (error) {
        configurationFailed = true;
        throw error;
      }
      beginProviderLogin(configuration.login, (body) =>
        request(`/workers/${workerId}/provider-login`, body),
      );
      if (providerLoginActive()) return;
    }
    if (state) {
      let batch: any[] = [],
        size = 0;
      for (const entry of state.events) {
        const n = JSON.stringify(entry).length;
        if (size + n > 64000 && batch.length) break;
        batch.push(entry);
        size += n;
      }
      const ack = await request(`/workers/${workerId}/events`, {
        runId: state.run.id,
        generation: state.run.generation,
        events: batch,
      });
      state.events = state.events.filter((e: any) => e.sequence > ack.acknowledgedSequence);
      if (ack.stopRequested) {
        state.stopRequested = true;
        terminate();
      }
      persist();
      if (state.terminal && !state.events.length) {
        let diff: any;
        try {
          diff = inspectWorkspace(state.workspacePath, state.task.baseRevision, 50000);
        } catch {}
        await request(`/workers/${workerId}/complete`, {
          runId: state.run.id,
          generation: state.run.generation,
          ...state.terminal,
          sessionId: state.run.sessionId,
          workspacePath: state.workspacePath,
          diff,
        });
        if (state.terminal.status === 'unknown') {
          console.error('Writer state unknown; stopping. Inspect assignment.json before recovery.');
          process.exitCode = 1;
          clearInterval(timer);
          return;
        }
        state = null;
        persist();
      }
      return;
    }
    const assignment = await request(`/workers/${workerId}/poll`, {});
    if (assignment.run) {
      if (
        assignment.run.status !== 'starting' ||
        assignment.run.assignedInstanceId !== instanceId
      ) {
        console.error('Coordinator has an unresolved previous assignment; no new process started');
        return;
      }
      void start(assignment);
    }
  } catch (error: any) {
    console.error('Worker disconnected:', error.message);
  } finally {
    busy = false;
  }
}
const timer = setInterval(() => void tick(), 1000);
void tick();
console.log(`HTTP workspace worker ${workerId} ready`);
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  terminate();
  clearInterval(jobTimer);
  clearInterval(interactiveTimer);
  clearInterval(screenshotTimer);
  screenshots.shutdown();
  void interactive.shutdown();
  jobs.shutdown();
  clearInterval(timer);
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('disconnect', shutdown);
