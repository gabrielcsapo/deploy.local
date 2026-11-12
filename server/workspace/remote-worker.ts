import { gitStringSync } from '../git.ts';
import { prepareAgentInstall, agentEnvironment } from './agent-packages.ts';
import { secretOutput } from '../../shared/package-install.mjs';
import { executeBaseUpdate, prepareBaseUpdateWorkspace } from './update-base-worker.ts';
import { claimRemoteWorker } from './remote-worker-lease.ts';
import { watchWorkerParent } from './worker-process.ts';
import { startTerminalWorker } from './terminal-worker.ts';
import { workerBuild, agentTools } from './worker-update.ts';
import { writeNodeSnapshot } from './node-status.ts';
import { createReadStream } from 'node:fs';
import { prepareAgentImages, attachFinalMedia } from './agent-media.ts';
import { configureMacDesktopHelper } from './mac-desktop.ts';
import { ScreenshotRunner } from './screenshot-runtime.ts';
import { prepareAttachmentInput } from './attachment-input.ts';
import { InteractiveRunner } from './interactive-runtime.ts';
import {
  probeTool,
  toolNames,
  refreshCapabilities,
  workerCapabilities,
} from './worker-capabilities.ts';
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
import { restoreTaskCheckpoint, recordCheckpointBase } from './checkpoint.ts';
import { agentLaunch, agentModelEnvironment } from './agent-launch.ts';
import { JobRunner } from './job-runner.ts';
import { inspectWorkspace, summaryPatchLimit, workspaceFilePatches } from './review.ts';
import { refreshCommitBaseline } from './commit-baseline.ts';
import { cloneTaskRepository, needsClone } from './task-clone.ts';
import { captureTurnCheckpoint, diffTurnCheckpoints, turnFilePatch } from './turn-checkpoint.ts';
import { randomUUID } from 'node:crypto';
import {
  processGroupAlive,
  restartInterruptedError,
  restartUnknownError,
} from './restart-recovery.ts';
// HTTP worker pilot: provider credentials and working files remain on this machine.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname, platform, arch } from 'node:os';
import { clipEvent } from './event-clip.ts';
/** 'fetch failed' alone hides the reason (TLS trust, DNS, refused, network privacy). Codes and
 * messages from the cause chain carry no credentials. */
function describeError(error: any) {
  const parts = [error?.message];
  for (let cause = error?.cause, depth = 0; cause && depth < 3; cause = cause.cause, depth++)
    parts.push([cause.code, cause.message].filter(Boolean).join(' '));
  return parts.filter(Boolean).join(' — ');
}

const origin = process.env.DEPLOY_COORDINATOR_URL,
  token = process.env.DEPLOY_WORKER_TOKEN,
  workerId = process.env.DEPLOY_WORKER_ID;
if (!origin || !token || !workerId || workerId === 'local' || !process.env.DEPLOY_WORKER_ROOT)
  throw new Error(
    'Set DEPLOY_COORDINATOR_URL, DEPLOY_WORKER_TOKEN, DEPLOY_WORKER_ID, DEPLOY_WORKER_ROOT',
  );
configureMacDesktopHelper();
void refreshCapabilities();
const capabilityTimer = setInterval(() => void refreshCapabilities(), 60000);
capabilityTimer.unref();
const instanceId = randomUUID();
const localRoot = resolve(process.env.DEPLOY_WORKER_ROOT);
mkdirSync(localRoot, { recursive: true, mode: 0o700 });
const statePath = resolve(localRoot, 'assignment.json'),
  lockPath = resolve(localRoot, 'worker.pid');
const releaseLease = claimRemoteWorker(lockPath);
process.on('exit', releaseLease);
let state: any = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null,
  child: ReturnType<typeof spawn> | null = null,
  busy = false;
let preparation: AbortController | undefined;
function persist() {
  writeFileSync(statePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
  renameSync(statePath + '.tmp', statePath);
}
// A previous process of this worker was running an agent when it stopped. Agents run in their
// own process group, so they can outlive the worker: only report the run as interrupted when that
// group is verifiably gone, otherwise hold the assignment (and the task's writer slot) until the
// coordinator resolves it.
if (state && !state.terminal) {
  const alive = processGroupAlive(state.pid);
  state.recovered = true;
  state.terminal =
    alive === false
      ? { status: 'interrupted', error: restartInterruptedError, restarted: true }
      : { status: 'unknown', error: restartUnknownError, process: alive ? 'alive' : 'unverified' };
  persist();
} else if (state?.terminal?.status === 'unknown' && !state.recovered) {
  // Left by an older worker build, which stopped here instead of waiting for resolution.
  state.recovered = true;
  persist();
}
let nextUnknownReport = 0,
  unknownWarned = false;
/** Keep the resolved assignment for inspection instead of deleting it. */
function archiveRecoveredAssignment() {
  const target = `${statePath}.resolved-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  renameSync(statePath, target);
  state = null;
  unknownWarned = false;
  console.log(`Previous run resolved by the coordinator; archived its assignment as ${target}`);
}
async function request(path: string, body: any) {
  const response = await fetch(origin + '/api/workspace' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-deploy-worker-id': workerId!,
      'x-deploy-worker-token': token!,
    },
    body: JSON.stringify({ ...body, instanceId, build: workerBuild, agentTools }),
    signal: AbortSignal.timeout(path.includes('/base-updates/prepare') ? 300000 : 10000),
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
const git = (cwd: string, args: string[]) =>
  gitStringSync(cwd, args, { timeout: 60000, maxBuffer: 1024 * 1024, env: gitEnv, trim: 'both' });
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
  let install: Awaited<ReturnType<typeof prepareAgentInstall>> | undefined;
  state = {
    ...assignment,
    workspacePath: resolve(
      localRoot,
      'tasks',
      assignment.task.id +
        (assignment.task.workspaceGeneration ? '-' + assignment.task.workspaceGeneration : ''),
    ),
    sequence: 0,
    events: [],
    terminal: null,
  };
  persist();
  try {
    if (assignment.project ? needsClone(state.workspacePath) : !existsSync(state.workspacePath)) {
      mkdirSync(state.workspacePath, { recursive: true });
      if (!assignment.project) {
        const baseline = initializeScratchWorkspace(state.workspacePath);
        if (baseline !== assignment.task.baseRevision)
          throw new Error('Conversation baseline mismatch');
      } else {
        const initialRevision =
          assignment.task.resumeBaseRevision ||
          assignment.task.workspaceCommit?.commit ||
          assignment.task.baseRevision;
        await cloneTaskRepository(
          state.workspacePath,
          origin + '/api/workspace/git/' + assignment.project.id,
          { env: gitEnv },
        );
        try {
          git(state.workspacePath, ['cat-file', '-e', `${initialRevision}^{commit}`]);
        } catch {
          git(state.workspacePath, [
            'fetch',
            'origin',
            assignment.taskCheckpointBaseRef || assignment.task.sourceRef || initialRevision,
          ]);
          if (git(state.workspacePath, ['rev-parse', 'FETCH_HEAD']) !== initialRevision)
            throw new Error('Task source revision changed');
        }
        git(state.workspacePath, ['checkout', '-b', `task/${assignment.task.id}`, initialRevision]);
      }
    }
    if (assignment.taskCheckpoint)
      restoreTaskCheckpoint(assignment.taskCheckpoint, state.workspacePath);
    if (assignment.project) {
      // Checkpoints are a delta over the commit the coordinator prepared this clone from.
      // Recorded on every start so clones made before delta checkpoints also get it.
      recordCheckpointBase(
        state.workspacePath,
        assignment.task.workspaceCommit?.commit || assignment.task.baseRevision,
      );
      if (
        await refreshCommitBaseline(
          state.workspacePath,
          state.task,
          origin + '/api/workspace/git/' + assignment.project.id,
          {
            origin: origin!,
            header: gitEnv.GIT_CONFIG_VALUE_0,
          },
        )
      )
        state.baselineDiff = inspectWorkspace(
          state.workspacePath,
          state.task.baseRevision,
          summaryPatchLimit,
        );
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
    // The coordinator cannot read this workspace, so the turn diff is computed here at the end.
    try {
      state.startCheckpoint = captureTurnCheckpoint(state.workspacePath);
    } catch {
      state.startCheckpoint = null;
    }
    persist();
    const mediaEndpoint = origin + '/api/workspace/agent/tools';
    const images = await prepareAgentImages(
      state.run.attachmentIds,
      mediaEndpoint,
      assignment.agentToken,
    );
    // v2 composer attachments (files and marked-up screenshots) are written into the workspace.
    const inputs = state.run.attachments?.length
      ? await screenshotRequest('attachments', { runId: state.run.id })
      : { attachments: [] };
    const attachmentImagePaths: string[] = [];
    const attachmentPrompt = prepareAttachmentInput(
      state.workspacePath,
      inputs.attachments || [],
      attachmentImagePaths,
    );
    install = await prepareAgentInstall(
      () =>
        request(`/workers/${workerId}/jobs/packages`, {
          runId: state.run.id,
          generation: state.run.generation,
        }),
      {
        cwd: state.workspacePath,
        root: resolve(localRoot, 'agent-packages'),
        log: (line) => emit('provider.output', { text: line + '\n' }),
      },
    );
    if (state.stopRequested) throw new Error('Task stopped during package preparation');
    const launch = agentLaunch(
      {
        ...state.run,
        imagePaths: [...images.paths, ...attachmentImagePaths],
      },
      install.env,
    );
    child = spawn(launch.executable, launch.args, {
      cwd: state.workspacePath,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...agentEnvironment(process.env, install.env),
        ...install.env,
        ...launch.env,
        DEPLOY_IMAGE_PATHS: JSON.stringify(images.paths),
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
    emit('agent.instructions', {
      delivery: launch.instructionDelivery,
      capturedAt: state.run.agentContextAt,
    });
    child.stdin!.end(state.run.prompt + attachmentPrompt);
    let buffer = '',
      stderr = '';
    const stdout = secretOutput(install.secrets, (chunk) => {
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
          ) {
            state.lastMessage = {
              providerItemId: value.item.id,
              role: 'assistant',
              adapter: state.run.adapter,
              content: value.item.text,
              createdAt: new Date().toISOString(),
            };
            emit('message', {
              providerItemId: value.item.id,
              role: 'assistant',
              adapter: state.run.adapter,
              content: value.item.text,
              createdAt: new Date().toISOString(),
            });
          }
        } catch {
          emit('provider.output', { text: line });
        }
      }
    });
    const errorOutput = secretOutput(install.secrets, (chunk) => {
      stderr = (stderr + chunk).slice(-10000);
    });
    child.stdout!.on('data', stdout.write);
    child.stderr!.on('data', errorOutput.write);
    child.once('error', (error) => {
      state.processError = error.message;
      persist();
    });
    child.once('close', async (code) => {
      stdout.end();
      errorOutput.end();
      await install?.cleanup();
      images.cleanup();
      if (state.lastMessage) {
        try {
          const media = await attachFinalMedia(
            state.lastMessage.content,
            { ...state.task, workspacePath: state.workspacePath },
            mediaEndpoint,
            assignment.agentToken,
          );
          emit('message', { ...state.lastMessage, ...media });
        } catch (error: any) {
          emit('media.error', { error: error.message });
        }
      }
      state.terminal = state.terminal || {
        status: state.stopRequested
          ? 'interrupted'
          : code === 0 && !state.processError
            ? 'succeeded'
            : 'failed',
        error: state.processError || (code === 0 ? null : stderr || `Agent exited ${code}`),
      };
      persist();
      child = null;
    });
  } catch (error: any) {
    await install?.cleanup();
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
  {
    // Raw streaming over the worker credential; files never pass through JSON or the agent.
    uploadArtifact: async (job, file, body, signal) => {
      const url = new URL(`${origin}/api/workspace/workers/${workerId}/jobs/${job.id}/artifacts`);
      url.search = new URLSearchParams({
        generation: job.generation,
        path: file.path,
        caption: file.caption,
      }).toString();
      const response = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization:
            'Basic ' + Buffer.from(`workspace-worker.${workerId}:${token}`).toString('base64'),
          'x-worker-instance': instanceId,
          'Content-Type': 'application/octet-stream',
        },
        body,
        duplex: 'half',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      } as unknown as RequestInit);
      const value = await response.json().catch(() => null);
      if (!response.ok) throw new Error(value?.error || `Artifact upload HTTP ${response.status}`);
      return value;
    },
  },
);
const interactive = new InteractiveRunner(
  (action, body) => request(`/workers/${workerId}/controls/${action}`, body),
  {
    uploadRecording: async (session, path) => {
      const response = await fetch(
        `${origin}/api/workspace/workers/${workerId}/controls/${session.id}/recording`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            Authorization:
              'Basic ' + Buffer.from(`workspace-worker.${workerId}:${token}`).toString('base64'),
            'x-worker-instance': instanceId,
            'Content-Type': 'video/webm',
          },
          body: createReadStream(path),
          duplex: 'half',
          signal: AbortSignal.timeout(600000),
        } as unknown as RequestInit,
      );
      if (!response.ok) throw new Error(`Recording upload HTTP ${response.status}`);
    },
  },
);
const stopTerminals = startTerminalWorker({
  root: localRoot,
  origin: origin!,
  token: token!,
  workerId: workerId!,
  instanceId,
});
let updatingWorkspace = false;
const baseUpdateTimer = setInterval(async () => {
  if (updatingWorkspace) return;
  updatingWorkspace = true;
  try {
    const { operations } = await request(`/workers/${workerId}/base-updates/poll`, {});
    for (const operation of operations) {
      try {
        await prepareBaseUpdateWorkspace(
          resolve(
            localRoot,
            'tasks',
            operation.taskId +
              (operation.workspaceGeneration ? '-' + operation.workspaceGeneration : ''),
          ),
          operation,
          origin + '/api/workspace/git/' + operation.projectId,
          { origin: origin!, header: gitEnv.GIT_CONFIG_VALUE_0 },
        );
        await executeBaseUpdate(
          resolve(
            localRoot,
            'tasks',
            operation.taskId +
              (operation.workspaceGeneration ? '-' + operation.workspaceGeneration : ''),
          ),
          operation,
          origin + '/api/workspace/git/' + operation.projectId,
          (action, body) => request(`/workers/${workerId}/base-updates/${action}`, body),
          { origin: origin!, header: gitEnv.GIT_CONFIG_VALUE_0 },
        );
      } catch (error: any) {
        await request(`/workers/${workerId}/base-updates/fail`, {
          id: operation.id,
          generation: operation.generation,
          error: error.message,
        });
      }
    }
  } catch (error) {
    console.error('Workspace update:', describeError(error));
  } finally {
    updatingWorkspace = false;
  }
}, 1000);
baseUpdateTimer.unref();
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
  () => void jobs.tick().catch((error) => console.error('Job worker:', describeError(error))),
  1000,
);
let configurationFailed = false;
let toolAnswers: Record<string, boolean> = {};
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const providers = providerRuntimeState();
    const registered = await request('/workers/register', {
      toolAnswers,
      workerId,
      name: process.env.DEPLOY_WORKER_NAME || hostname(),
      nodeId: process.env.DEPLOY_NODE_ID || undefined,
      version: process.env.DEPLOY_VERSION || undefined,
      screenSupported: platform() === 'darwin' && Boolean(process.env.DEPLOY_DESKTOP_HELPER),
      platform: platform(),
      architecture: arch(),
      capabilities: workerCapabilities(),
      terminalDisabled: process.env.DEPLOY_TERMINAL === '0',
      nodeCapabilities: interactive.capabilities(),
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
    toolAnswers = {};
    // Registration is the heartbeat even while a task runs, so busy computers answer too.
    await Promise.all(
      toolNames(registered.toolProbes ?? []).map(async (tool) => {
        toolAnswers[tool] = await probeTool(tool);
      }),
    );
    writeNodeSnapshot({
      enrolled: true,
      coordinatorUrl: origin!,
      workerId: workerId!,
      workerName: process.env.DEPLOY_WORKER_NAME || hostname(),
      online: true,
      runningTaskCount: state && !state.terminal ? 1 : 0,
      capabilities: interactive.capabilities(),
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
      if (state.terminal?.status === 'unknown') {
        if (Date.now() < nextUnknownReport) return;
        // The previous agent may have exited since the last report.
        const alive = processGroupAlive(state.pid);
        state.terminal =
          alive === false
            ? { status: 'interrupted', error: restartInterruptedError, restarted: true }
            : { ...state.terminal, process: alive ? 'alive' : 'unverified' };
        persist();
      }
      let batch: any[] = [],
        size = 0;
      for (const queued of state.events) {
        const entry = clipEvent(queued);
        const n = JSON.stringify(entry).length;
        if (size + n > 64000 && batch.length) break;
        batch.push(entry);
        size += n;
      }
      const ack = await request(`/workers/${workerId}/events`, {
        runId: state.run.id,
        generation: state.run.generation,
        events: batch,
        baselineCommit: state.task.workspaceCommit?.commit,
        workspaceDiff: state.baselineDiff,
      });
      state.events = state.events.filter((e: any) => e.sequence > ack.acknowledgedSequence);
      delete state.baselineDiff;
      if (ack.repositoryTask && !updatingWorkspace) {
        const task = ack.repositoryTask;
        const refreshed =
          task.baseUpdate &&
          ['queued', 'preparing', 'prepared', 'failed'].includes(task.baseUpdate.status)
            ? false
            : await refreshCommitBaseline(
                state.workspacePath,
                task,
                origin + '/api/workspace/git/' + task.projectId,
                {
                  origin: origin!,
                  header: gitEnv.GIT_CONFIG_VALUE_0,
                },
              );
        if (refreshed || task.workspaceCommit?.commit !== state.task.workspaceCommit?.commit)
          state.baselineDiff = inspectWorkspace(
            state.workspacePath,
            task.baseRevision,
            summaryPatchLimit,
          );
        state.task = task;
      }
      if (ack.stopRequested) {
        state.stopRequested = true;
        terminate();
      }
      persist();
      if (state.terminal?.status === 'unknown' && state.unknownReported && !state.events.length) {
        const run = await request(`/workers/${workerId}/complete`, {
          runId: state.run.id,
          generation: state.run.generation,
          ...state.terminal,
        });
        settleUnknown(run);
        return;
      }
      if (state.terminal && !state.events.length && !child) {
        let diff: any,
          checkpoint: string | null = null,
          turnDiff: any,
          filePatches: any,
          turnFilePatches: any;
        try {
          diff = inspectWorkspace(state.workspacePath, state.task.baseRevision, summaryPatchLimit);
          // The coordinator cannot read this workspace, so each changed file's full patch is
          // uploaded once here; the summary patch above stays small for the first paint.
          filePatches = workspaceFilePatches(
            state.workspacePath,
            state.task.baseRevision,
            diff.files,
          ).patches;
        } catch {}
        try {
          checkpoint = captureTurnCheckpoint(state.workspacePath);
          if (state.startCheckpoint) {
            const from = state.startCheckpoint,
              to = checkpoint;
            turnDiff = diffTurnCheckpoints(state.workspacePath, from, to, summaryPatchLimit);
            turnFilePatches = workspaceFilePatches(
              state.workspacePath,
              from,
              turnDiff.files,
              (path) => turnFilePatch(state.workspacePath, from, to, path),
            ).patches;
          }
        } catch {}
        const run = await request(`/workers/${workerId}/complete`, {
          runId: state.run.id,
          generation: state.run.generation,
          ...state.terminal,
          sessionId: state.run.sessionId,
          workspacePath: state.workspacePath,
          diff,
          filePatches,
          baselineCommit: state.task.workspaceCommit?.commit,
          startCheckpoint: state.startCheckpoint || null,
          checkpoint,
          turnDiff,
          turnFilePatches,
        });
        if (state.terminal.status === 'unknown') {
          state.unknownReported = true;
          persist();
          settleUnknown(run);
          return;
        }
        if (state.recovered) archiveRecoveredAssignment();
        else {
          state = null;
          persist();
        }
      }
      return;
    }
    // Polling only happens with no assignment state on disk; say so, so a run a previous process
    // of this worker left behind can be resolved without waiting for the user.
    const assignment = await request(`/workers/${workerId}/poll`, { noAssignment: true });
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
    console.error('Worker disconnected:', describeError(error));
  } finally {
    busy = false;
  }
}
/** After reporting a run this process could not reconcile: wait, or archive once resolved. */
function settleUnknown(run: any) {
  // Never let go of the writer slot while the previous agent's process group still exists.
  if (run?.status === 'unknown' || processGroupAlive(state.pid) === true) {
    nextUnknownReport = Date.now() + 5000;
    if (!unknownWarned)
      console.error(
        state.terminal.process === 'alive'
          ? `Previous agent (process group ${state.pid}) is still running; no new work starts until it exits.`
          : 'Previous run could not be reconciled; no new work starts until it is marked stopped in deploy.local.',
      );
    unknownWarned = true;
    return;
  }
  archiveRecoveredAssignment();
}
const timer = setInterval(() => void tick(), 1000);
void tick();
console.log(`HTTP workspace worker ${workerId} ready`);
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  terminate();
  stopTerminals();
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
watchWorkerParent(shutdown);
