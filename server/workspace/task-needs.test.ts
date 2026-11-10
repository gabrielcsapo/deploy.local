import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { probeTool, toolNames } from './worker-capabilities.ts';
import { captureSnapshot, restoreTaskCheckpoint, recordCheckpointBase } from './checkpoint.ts';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-task-needs-'));
process.env.DEPLOY_MDNS_ADDRESS = '127.0.0.1';
const { get, save, list, now } = await import('./store.ts');
const { askTools, recordToolAnswers, toolAnswer, pendingToolProbes, answerLocalTools } =
  await import('./tool-probes.ts');
const { queueTask, startWaitingTasks, taskRequirementsSnapshot, requireTaskTools } =
  await import('./task-workspace.ts');
const { coordinationTool } = await import('./coordination.ts');
const { workerCommand } = await import('./protocol.ts');
const { createTask } = await import('./test-repository.ts');
const { RepositoryRunner } = await import('./repository-runner.ts');

function worker(owner: string, id: string, online = true) {
  return save('worker', owner, {
    id,
    name: id === 'mac' ? 'Build Mac' : id,
    capabilities: ['codex'],
    instanceId: id,
    heartbeat: online ? now() : '2000-01-01',
    platform: 'darwin',
  });
}
function answer(owner: string, id: string, has: Record<string, boolean>) {
  askTools(owner, id, Object.keys(has));
  recordToolAnswers(owner, id, has);
}
function fixture() {
  const owner = randomUUID();
  worker(owner, 'linux');
  worker(owner, 'mac');
  return owner;
}

test('probes accept executable names and reject command lines before spawning', async () => {
  assert.deepEqual(toolNames(['node', 'node', 'git-lfs', 'clang++']), [
    'node',
    'git-lfs',
    'clang++',
  ]);
  assert.equal(await probeTool('node'), true);
  assert.equal(await probeTool('deploy-tool-that-does-not-exist'), false);
  assert.equal(await probeTool('constructor'), false);
  for (const name of [
    'node --version',
    'xcodebuild;id',
    '/bin/sh',
    '-version',
    'a'.repeat(42),
    '$(id)',
  ])
    assert.throws(() => probeTool(name), /bare tool names/);
});

test('probes find exact executable names on PATH without aliases or version-flag requirements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tool-path-'));
  const previous = process.env.PATH;
  try {
    for (const name of ['xcodebuild', 'python3', 'custom-compiler', 'CaseSensitiveTool'])
      writeFileSync(join(directory, name), '#!/bin/sh\nexit 64\n', { mode: 0o755 });
    writeFileSync(join(directory, 'not-executable'), '', { mode: 0o644 });
    mkdirSync(join(directory, 'directory'));
    process.env.PATH = directory;
    for (const name of ['xcodebuild', 'python3', 'custom-compiler', 'CaseSensitiveTool'])
      assert.equal(await probeTool(name), true, name);
    for (const name of ['xcode', 'python', 'not-executable', 'directory'])
      assert.equal(await probeTool(name), false, name);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('placement uses probe answers, excludes roles off, and prefers an idle eligible computer', () => {
  const owner = fixture();
  answer(owner, 'linux', { xcodebuild: false });
  answer(owner, 'mac', { xcodebuild: true });
  // A claimed inventory is not a probe answer.
  save('worker', owner, {
    ...get('worker', owner, 'linux'),
    capabilities: ['xcodebuild', 'codex'],
  });
  assert.equal(queueTask(owner, { needs: ['xcodebuild'] }).workerId, 'mac');
  worker(owner, 'idle');
  answer(owner, 'idle', { xcodebuild: true });
  save('run', owner, { id: 'busy', workerId: 'mac', taskId: 'busy', status: 'running' });
  assert.equal(queueTask(owner, { needs: ['xcodebuild'] }).workerId, 'idle');
  save('v2-computer-roles', owner, { id: 'idle', workerIds: ['idle'], roles: [] });
  assert.equal(queueTask(owner, { needs: ['xcodebuild'] }).workerId, 'mac');
});

test('a named computer that answers no is refused with the missing names', () => {
  const owner = fixture();
  answer(owner, 'mac', { xcodebuild: false, swift: false });
  assert.throws(
    () => queueTask(owner, { workerId: 'mac', needs: ['xcodebuild', 'swift'] }),
    /Build Mac is missing: xcodebuild, swift/,
  );
});

test('poll and active heartbeat carry questions and authenticated answers, retained offline', () => {
  const owner = fixture();
  queueTask(owner, { needs: ['custom-compiler'] });
  assert.deepEqual(workerCommand(owner, '/workers/mac/poll', {}).toolProbes, ['custom-compiler']);
  const registered = workerCommand(owner, '/workers/register', {
    workerId: 'mac',
    toolAnswers: { 'custom-compiler': true },
  });
  // Nothing asked: the reply carries no questions at all.
  assert.equal(registered.toolProbes, undefined);
  assert.equal(toolAnswer(owner, 'mac', 'custom-compiler'), true);
  const receipt = get('tool-probe', owner, 'mac:custom-compiler');
  assert.ok(Date.parse(receipt.answeredAt));
  worker(owner, 'mac', false);
  assert.equal(toolAnswer(owner, 'mac', 'custom-compiler'), true);
  assert.throws(() => recordToolAnswers(owner, 'linux', { 'node --version': true }), /bare tool/);
  assert.throws(() => recordToolAnswers(owner, 'linux', { node: true }), /not found/i);
});

test('waiting survives a fresh coordinator process and starts exactly once when a qualifying computer appears', async () => {
  const owner = fixture();
  answer(owner, 'linux', { xcodebuild: false });
  answer(owner, 'mac', { xcodebuild: true });
  worker(owner, 'mac', false);
  const task = queueTask(owner, { needs: ['xcodebuild'], prompt: 'Build the phone' });
  assert.equal(task.status, 'waiting');
  assert.deepEqual(taskRequirementsSnapshot(owner, task).needs, {
    tools: ['xcodebuild'],
    waiting: true,
    asked: [
      { id: 'linux', name: 'linux', online: true, has: { xcodebuild: false } },
      { id: 'mac', name: 'Build Mac', online: false, has: { xcodebuild: true } },
    ],
  });
  await startWaitingTasks();
  assert.equal(list('run', owner).length, 0);
  worker(owner, 'mac');
  const script =
    "const { startWaitingTasks } = await import('./server/workspace/task-workspace.ts'); await startWaitingTasks();";
  const restarted = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', script],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(restarted.status, 0, restarted.stderr);
  await Promise.all([startWaitingTasks(), startWaitingTasks()]);
  assert.equal(get('task', owner, task.id).workerId, 'mac');
  assert.equal(list('run', owner).length, 1);
  assert.equal(list('repository-operation', owner).length, 1);
  assert.equal(taskRequirementsSnapshot(owner, get('task', owner, task.id)).needs?.waiting, false);
});

test('unknown answers stay null, and an asynchronous named no is refused before launch', async () => {
  const owner = fixture();
  const task = queueTask(owner, { workerId: 'mac', needs: ['xcodebuild'], prompt: 'Build' });
  assert.equal(taskRequirementsSnapshot(owner, task).needs?.asked[1].has.xcodebuild, null);
  workerCommand(owner, '/workers/mac/poll', { toolAnswers: { xcodebuild: false } });
  await startWaitingTasks();
  assert.equal(get('task', owner, task.id).placementError, 'Build Mac is missing: xcodebuild');
  assert.equal(list('run', owner).length, 0);
});

test('the local coordinator probes the same tool and persists its answer', async () => {
  const owner = randomUUID();
  askTools(owner, 'local', ['node']);
  await answerLocalTools(owner);
  assert.equal(toolAnswer(owner, 'local', 'node'), true);
  assert.deepEqual(pendingToolProbes(owner, 'local'), []);
});

test('agent action records satisfied needs without stopping and re-places missing needs at its checkpoint', async () => {
  const owner = fixture();
  const task = createTask(owner, {
    workerId: 'linux',
    title: 'Move from checkpoint',
    prompt: 'Keep these edits',
  });
  const run = list('run', owner)[0];
  save('run', owner, { ...run, status: 'running', generation: 'g' });
  const scope = { owner, taskId: task.id, runId: run.id };
  answer(owner, 'linux', { node: true, xcodebuild: false });
  answer(owner, 'mac', { node: true, xcodebuild: true });
  const satisfied = await requireTaskTools(scope, { needs: ['node'], why: 'Run checks' });
  assert.equal(satisfied.needs?.waiting, false);
  assert.equal(get('run', owner, run.id).stopRequested, undefined);
  writeFileSync(join(task.workspacePath, 'dirty.txt'), 'preserve me');
  const cp = coordinationTool(scope, 'deploy_checkpoint', {
    operationId: randomUUID(),
    snapshot: captureSnapshot(task.workspacePath),
  });
  const result = await requireTaskTools(scope, {
    needs: ['xcodebuild'],
    why: 'Build phone',
    checkpointId: cp.checkpointId,
  });
  assert.deepEqual(result.needs?.tools, ['node', 'xcodebuild']);
  assert.equal(result.needs?.why, 'Build phone');
  assert.equal(result.needs?.waiting, true);
  assert.equal(get('run', owner, run.id).stopRequested, true);
  await startWaitingTasks();
  assert.equal(list('run', owner).length, 1, 'old process must stop before replacement');
  workerCommand(owner, '/workers/linux/complete', {
    runId: run.id,
    generation: 'g',
    status: 'interrupted',
  });
  await Promise.all([startWaitingTasks(), startWaitingTasks()]);
  const moved = get('task', owner, task.id);
  assert.equal(moved.workerId, 'mac');
  assert.equal(moved.resumeCheckpointId, cp.checkpointId);
  assert.notEqual(moved.workspacePath, task.workspacePath);
  assert.equal(list('run', owner).length, 2);
  assert.equal(list('message', owner).length, 1, 'a handoff must not invent another user message');
  const runner = new RepositoryRunner();
  await runner.tick();
  for (let n = 0; n < 100 && get('task', owner, task.id).workspaceStatus !== 'ready'; n++) {
    await runner.tick();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(get('task', owner, task.id).workspaceStatus, 'ready');
  const assignment = workerCommand(owner, '/workers/mac/poll', {});
  assert.equal(
    assignment.taskCheckpoint.digest,
    get('checkpoint', owner, cp.checkpointId).snapshot.digest,
  );
  assert.equal(assignment.run.sessionId, null);
  assert.equal(readFileSync(join(moved.workspacePath, 'dirty.txt'), 'utf8'), 'preserve me');
  writeFileSync(join(moved.workspacePath, 'dirty.txt'), 'later edits');
  restoreTaskCheckpoint(assignment.taskCheckpoint, moved.workspacePath);
  assert.equal(
    readFileSync(join(moved.workspacePath, 'dirty.txt'), 'utf8'),
    'later edits',
    'later runs must not replay the handoff',
  );
});

test('tasks without needs keep their existing local default and snapshot shape', () => {
  const owner = fixture();
  const task = queueTask(owner, { prompt: 'Do normal work' });
  assert.equal(task.workerId, 'local');
  assert.equal(task.workspaceStatus, 'preparing');
  assert.equal(task.status, 'running');
  assert.deepEqual(taskRequirementsSnapshot(owner, task), {});
  assert.equal(list('tool-probe', owner).length, 0);
  assert.equal(list('run', owner).length, 1);
});

test('an agent waits for its current computer to answer and only records satisfied needs', async () => {
  const owner = fixture();
  const task = createTask(owner, { workerId: 'mac', prompt: 'Check node' });
  const run = list('run', owner)[0];
  save('run', owner, { ...run, status: 'running' });
  const response = requireTaskTools({ owner, taskId: task.id, runId: run.id }, { needs: ['node'] });
  workerCommand(owner, '/workers/register', { workerId: 'mac', toolAnswers: { node: true } });
  assert.equal((await response).needs?.waiting, false);
  assert.equal(get('run', owner, run.id).stopRequested, undefined);
  assert.equal(list('checkpoint', owner).length, 0);
});

test('stopping a waiting task cancels its durable launch', async () => {
  const { stopRun } = await import('./service.ts');
  const owner = fixture();
  const task = queueTask(owner, { needs: ['xcodebuild'], prompt: 'Build later' });
  stopRun(owner, task.id, { revision: task.revision });
  answer(owner, 'mac', { xcodebuild: true });
  await startWaitingTasks();
  assert.equal(list('run', owner).length, 0);
  assert.equal(taskRequirementsSnapshot(owner, get('task', owner, task.id)).needs?.waiting, false);
});

test('a repository handoff restores changed and deleted files over its exact base', async () => {
  const { git } = await import('./service.ts');
  const source = mkdtempSync(join(tmpdir(), 'needs-delta-'));
  git(source, ['init', '--initial-branch=main']);
  writeFileSync(join(source, 'kept.txt'), 'base');
  writeFileSync(join(source, 'removed.txt'), 'remove me');
  git(source, ['add', '.']);
  git(source, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'Base',
  ]);
  const base = git(source, ['rev-parse', 'HEAD']);
  recordCheckpointBase(source, base);
  writeFileSync(join(source, 'kept.txt'), 'edited');
  unlinkSync(join(source, 'removed.txt'));
  const snapshot = captureSnapshot(source);
  const target = mkdtempSync(join(tmpdir(), 'needs-delta-target-'));
  git(target, ['clone', source, '.']);
  restoreTaskCheckpoint(snapshot, target);
  assert.equal(readFileSync(join(target, 'kept.txt'), 'utf8'), 'edited');
  assert.equal(existsSync(join(target, 'removed.txt')), false);
  assert.equal(git(target, ['rev-parse', 'HEAD']), base);
});

test('an answer is asked again once it is ten minutes old, and trusted meanwhile', async () => {
  const { askTools, pendingToolProbes, recordToolAnswers, toolAnswer, staleAfterMs } =
    await import('./tool-probes.ts');
  const { list, save } = await import('./store.ts');
  const owner = 'stale-owner';
  askTools(owner, 'mac', ['docker']);
  assert.deepEqual(pendingToolProbes(owner, 'mac'), ['docker']);
  recordToolAnswers(owner, 'mac', { docker: true });
  assert.deepEqual(pendingToolProbes(owner, 'mac'), []);
  // Fresh: asking again does not bother the computer.
  askTools(owner, 'mac', ['docker']);
  assert.deepEqual(pendingToolProbes(owner, 'mac'), []);
  const row = list('tool-probe', owner).find((entry: any) => entry.id === 'mac:docker');
  save('tool-probe', owner, {
    ...row,
    answeredAt: new Date(Date.now() - staleAfterMs - 1000).toISOString(),
  });
  askTools(owner, 'mac', ['docker']);
  assert.deepEqual(pendingToolProbes(owner, 'mac'), ['docker']);
  assert.equal(
    toolAnswer(owner, 'mac', 'docker'),
    true,
    'the last answer stands until the new one',
  );
  recordToolAnswers(owner, 'mac', { docker: false });
  assert.equal(toolAnswer(owner, 'mac', 'docker'), false);
  assert.deepEqual(pendingToolProbes(owner, 'mac'), []);
});

test('a Mac placeholder program does not count as having it', async () => {
  const { probeTool } = await import('./worker-capabilities.ts');
  assert.equal(await probeTool('definitely-not-a-program-zz'), false);
  assert.equal(await probeTool('node'), true);
  if (process.platform === 'darwin') assert.equal(await probeTool('ls'), true);
});
