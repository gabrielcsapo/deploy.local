import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { coordinationTools } from './coordination-tools.ts';
import { captureSnapshot, validateSnapshot, restoreSnapshot } from '../../workspace/checkpoint.ts';
import { JobRunner } from '../../workspace/job-runner.ts';
import { agentLaunch, agentModelEnvironment } from './agent-launch.ts';
import { wireWorkerEntry } from '../../main/worker-entry.ts';

wireWorkerEntry();

const data = mkdtempSync(join(tmpdir(), 'deploy-coordination-test-'));
process.env.DEPLOY_DATA_DIR = data;
const { db, get, save, list, now } = await import('../../workspace/store.ts');
const { coordinationTool, issueAgentToken, authenticateAgent, jobCommand } =
  await import('./coordination.ts');
const { coordinationApi } = await import('../../workspace/coordination-api.ts');
const { enrollWorker, workerAuthentication } = await import('../../workspace/credentials.ts');
const { workspaceApi } = await import('../../workspace/api.ts');
const { createTask } = await import('../../workspace/test-repository.ts');
const { startRun } = await import('../../workspace/service.ts');
const owner = 'coordination-test';
const task = createTask(owner, { title: 'One conversation, multiple computers' });
writeFileSync(join(task.workspacePath, 'source.txt'), 'checkpoint version\n');
const run = startRun(owner, task.id, {
  revision: 0,
  content: 'Verify this source across computers',
});
save('run', owner, { ...run, status: 'running' });
const scope = { owner, taskId: task.id, runId: run.id };
const token = issueAgentToken(scope);
const tool = (name: string, args: any = {}) => coordinationTool(scope, name, args);
const operation = () => randomUUID();
const checkpoint = tool('deploy_checkpoint', {
  operationId: operation(),
  snapshot: captureSnapshot(task.workspacePath),
});
async function until(check: () => any | Promise<any>, timeout = 15000): Promise<any> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for condition');
}

test('job labels remain optional in the schema and do not add MCP tools', async () => {
  const { coordinationTools } = await import('./coordination-tools.ts');
  assert.equal(coordinationTools.length, 17);
  const needs = coordinationTools.find((tool) => tool.name === 'deploy_require_tools')!;
  assert.deepEqual(needs.inputSchema.required, ['needs']);
  assert.ok(!('checkpointId' in needs.inputSchema.properties));
  const runTool = coordinationTools.find((tool) => tool.name === 'deploy_run_job')!;
  assert.equal((runTool.inputSchema.properties as Record<string, any>).label.maxLength, 80);
  assert.ok(!runTool.inputSchema.required.includes('label'));
  assert.match(runTool.description, /short label saying what it checks/);
  // A checkpoint can name its change, and the title has to fit a commit subject.
  const capture = coordinationTools.find((tool) => tool.name === 'deploy_checkpoint')!;
  const fields = capture.inputSchema.properties as Record<string, any>;
  assert.equal(fields.title.maxLength, 72);
  assert.equal(fields.summary.maxLength, 10000);
  assert.deepEqual(capture.inputSchema.required, ['operationId']);
});

test('checkpoint preserves dirty files and executable mode, excludes credentials and symlinks, and rejects traversal/tampering', () => {
  const cwd = join(data, 'capture');
  mkdirSync(cwd);
  assert.equal(spawnSync('git', ['init', cwd]).status, 0);
  writeFileSync(join(cwd, 'source'), 'dirty source');
  writeFileSync(join(cwd, 'script'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(cwd, '.env'), 'SECRET=never-transfer');
  writeFileSync(join(cwd, '.gitignore'), 'ignored\n');
  writeFileSync(join(cwd, 'ignored'), 'not transferred');
  symlinkSync('/etc/hosts', join(cwd, 'outside'));
  const snapshot = captureSnapshot(cwd);
  assert(snapshot.excluded.includes('.env'));
  assert(snapshot.excluded.includes('outside'));
  assert(!snapshot.files.some((f) => f.path === 'ignored'));
  const destination = join(data, 'restored');
  restoreSnapshot(snapshot, destination);
  assert.equal(readFileSync(join(destination, 'source'), 'utf8'), 'dirty source');
  assert(snapshot.files.find((f) => f.path === 'script')?.executable);
  assert.throws(() => restoreSnapshot(snapshot, destination));
  assert.throws(
    () =>
      validateSnapshot({
        ...snapshot,
        files: [{ path: '../escape', content: '', executable: false }],
      }),
    /Unsafe/,
  );
  assert.throws(() => validateSnapshot({ ...snapshot, digest: 'tampered' }), /digest/);
});

test('a checkpoint carries the agent’s own title and summary, within one short line', () => {
  const named = tool('deploy_checkpoint', {
    operationId: operation(),
    title: 'Name the change on its final checkpoint',
    summary: 'Publishing prefers this over a title derived from the request.',
    snapshot: captureSnapshot(task.workspacePath),
  });
  assert.equal(named.title, 'Name the change on its final checkpoint');
  const stored = get('checkpoint', owner, named.checkpointId);
  assert.equal(stored.title, 'Name the change on its final checkpoint');
  assert.equal(stored.summary, 'Publishing prefers this over a title derived from the request.');
  // Untitled captures stay untitled rather than inventing a name.
  const plain = tool('deploy_checkpoint', {
    operationId: operation(),
    snapshot: captureSnapshot(task.workspacePath),
  });
  assert.equal(plain.title, undefined);
  assert.equal(get('checkpoint', owner, plain.checkpointId).title, undefined);
  const refused = (args: any) =>
    assert.throws(() =>
      tool('deploy_checkpoint', {
        operationId: operation(),
        snapshot: captureSnapshot(task.workspacePath),
        ...args,
      }),
    );
  refused({ title: 'x'.repeat(73) });
  refused({ title: 'Two\nlines' });
  refused({ title: '  ' });
  refused({ title: 7 });
  refused({ summary: 'y'.repeat(10001) });
});

test('run credentials expire at completion and tools cannot cross owners or tasks', () => {
  assert.deepEqual(authenticateAgent(token), scope);
  assert.equal(authenticateAgent('bad'), null);
  const other = createTask(owner, { title: 'Other conversation' });
  const otherScope = { ...scope, taskId: other.id };
  assert.throws(
    () =>
      coordinationTool(otherScope, 'deploy_run_job', {
        checkpointId: checkpoint.checkpointId,
        operationId: operation(),
      }),
    /another task/,
  );
  assert.throws(
    () =>
      coordinationTool({ ...scope, owner: 'other-owner' }, 'deploy_run_job', {
        checkpointId: checkpoint.checkpointId,
        operationId: operation(),
      }),
    /Not found/,
  );
  save('run', owner, { ...get('run', owner, run.id), status: 'succeeded' });
  assert.equal(authenticateAgent(token), null);
  save('run', owner, { ...get('run', owner, run.id), status: 'running' });
});

test('local jobs are isolated, idempotent, cancellable, time bounded, and strip agent credentials', async () => {
  db.prepare('INSERT OR REPLACE INTO worker VALUES(?,?,?)').run('local', process.pid, now());
  const instanceId = operation();
  // A checkout left by a job from before this worker started.
  mkdirSync(join(data, 'local-jobs', 'stale-job-1'), { recursive: true });
  writeFileSync(join(data, 'local-jobs', 'stale-job-1', 'leftover.txt'), 'x');
  const jobFolders = () =>
    readdirSync(join(data, 'local-jobs'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  const runner = new JobRunner(join(data, 'local-jobs'), async (action, body) =>
    jobCommand(owner, 'local', action, { ...body, instanceId }),
  );
  const timer = setInterval(() => void runner.tick(), 40);
  process.env.DEPLOY_AGENT_TOKEN = 'do-not-leak';
  try {
    const input = {
      checkpointId: checkpoint.checkpointId,
      workerId: 'local',
      label: 'Verify checkpoint isolation',
      command: 'cat source.txt; echo changed > source.txt; test -z "$DEPLOY_AGENT_TOKEN"',
      operationId: operation(),
    };
    const job = tool('deploy_run_job', input);
    assert.equal(tool('deploy_run_job', input).id, job.id);
    assert.equal(job.name, input.label);
    for (const label of ['', 'x'.repeat(81), 'bad\nlabel', '<b>test</b>', 12]) {
      assert.throws(
        () => tool('deploy_run_job', { ...input, label, operationId: operation() }),
        /label must be plain text/,
      );
    }
    assert.throws(
      () => tool('deploy_run_job', { ...input, command: 'false' }),
      /different command/,
    );
    const done = await until(() => {
      const j = get('job', owner, job.id);
      return j.status === 'succeeded' && j;
    });
    assert.match(done.output, /checkpoint version/);
    // A finished job's checkout is removed once the coordinator has its result.
    await until(() => jobFolders().length === 0);
    assert.ok(Date.parse(done.startedAt) >= Date.parse(done.createdAt));
    assert.ok(Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
    assert.equal(
      readFileSync(join(task.workspacePath, 'source.txt'), 'utf8'),
      'checkpoint version\n',
    );
    assert.equal(get('run', owner, run.id).status, 'running');
    const slow = tool('deploy_run_job', {
      ...input,
      operationId: operation(),
      command: 'sleep 20',
      timeoutMs: 100,
    });
    await until(() => get('job', owner, slow.id).status === 'timed_out');
    const cancelled = tool('deploy_run_job', {
      ...input,
      operationId: operation(),
      command: 'sleep 20',
    });
    await until(() => get('job', owner, cancelled.id).status === 'running');
    tool('deploy_cancel_job', { jobId: cancelled.id, operationId: operation() });
    await until(() => get('job', owner, cancelled.id).status === 'cancelled');
  } finally {
    clearInterval(timer);
    runner.stop();
    delete process.env.DEPLOY_AGENT_TOKEN;
  }
});

test('restart marks an old assignment unknown without re-execution; generation rejects stale completion', () => {
  db.prepare('UPDATE worker SET heartbeat=?').run(now());
  const job = tool('deploy_run_job', {
    checkpointId: checkpoint.checkpointId,
    workerId: 'local',
    command: 'echo one-time',
    operationId: operation(),
  });
  const claimed = jobCommand(owner, 'local', 'poll', { instanceId: 'old-process' });
  assert.equal(claimed.job.id, job.id);
  assert.equal(jobCommand(owner, 'local', 'poll', { instanceId: 'new-process' }).job, null);
  assert.equal(get('job', owner, job.id).status, 'unknown');
  assert.throws(
    () =>
      jobCommand(owner, 'local', 'complete', {
        jobId: job.id,
        instanceId: 'new-process',
        generation: claimed.job.generation,
        status: 'succeeded',
      }),
    /Stale/,
  );
});

test('Claude adapter preserves session and tool result events without treating provider errors as success', async () => {
  const fake = join(data, 'claude-fixture');
  writeFileSync(
    fake,
    `#!/usr/bin/env node
if (!process.argv.includes('--effort') || !process.argv.includes('high') || !process.argv.includes('sonnet')) throw new Error('Missing model or effort');
process.stdin.resume();
process.stdin.on('end', () => {
  for (const value of [
    {type:'system',subtype:'init',session_id:'fixture-session'},
    {type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'mcp__deploy__deploy_list_computers',input:{}}]}},
    {type:'user',message:{content:[{type:'tool_result',tool_use_id:'tool-1',content:'{"computers":[]}'}]}},
    {type:'assistant',message:{content:[{type:'text',text:'No computers available.'}]}},
    {type:'result',is_error:true,result:'Fixture provider failure'}
  ]) console.log(JSON.stringify(value));
});
`,
    { mode: 0o700 },
  );
  const launch = agentLaunch({ adapter: 'claude' });
  const child = spawn(launch.executable, launch.args, {
    env: {
      ...process.env,
      DEPLOY_CLAUDE_BIN: fake,
      DEPLOY_MODEL_NAME: 'sonnet',
      DEPLOY_MODEL_EFFORT: 'high',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '',
    error = '';
  child.stdout.on('data', (c) => (output += c));
  child.stderr.on('data', (c) => (error += c));
  child.stdin.end('Fixture prompt');
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(error, /Fixture provider failure/);
  const events = output
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(events.some((e) => e.type === 'thread.started' && e.thread_id === 'fixture-session'));
  assert(events.some((e) => e.item?.type === 'tool_result' && e.item.output.includes('computers')));
  assert(events.some((e) => e.type === 'turn.failed'));
});

test('MCP to HTTP to real remote worker executes and retrieves results within the same task', async () => {
  const enrollment = enrollWorker(owner, { workerId: 'test-remote' });
  const server = createServer((req, res) => {
    if (req.headers['x-deploy-agent-token']) return void coordinationApi(req, res);
    const worker = workerAuthentication(req);
    if (worker) return void workspaceApi(req, res, worker.owner, worker.workerId);
    res.writeHead(401);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const child = spawn(process.execPath, [resolve('server/workspace/remote-worker.ts')], {
    env: {
      ...process.env,
      DEPLOY_COORDINATOR_URL: origin,
      DEPLOY_WORKER_ID: enrollment.workerId,
      DEPLOY_WORKER_TOKEN: enrollment.workerToken,
      DEPLOY_WORKER_ROOT: join(data, 'remote'),
      DEPLOY_AGENT_TOKEN: 'must-not-reach-command',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (chunk) => (errors += chunk));
  const mcp = spawn(process.execPath, [resolve('server/workspace/mcp.ts')], {
    cwd: task.workspacePath,
    env: {
      PATH: process.env.PATH!,
      DEPLOY_AGENT_URL: origin + '/api/agent/tools',
      DEPLOY_AGENT_TOKEN: token,
    },
  });
  const lines = createInterface({ input: mcp.stdout });
  const replies = lines[Symbol.asyncIterator]();
  let requestId = 0;
  const request = async (method: string, params?: object) => {
    const id = ++requestId;
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const line = await replies.next();
    assert.ok(!line.done, 'MCP server closed before replying');
    const reply = JSON.parse(line.value);
    assert.equal(reply.id, id);
    assert.ok(!reply.error, JSON.stringify(reply));
    return reply.result;
  };
  const call = async (name: string, args: any = {}) => {
    const result: any = await request('tools/call', { name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  try {
    await request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'acceptance', version: '1.0.0' },
    });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools: typeof coordinationTools = (await request('tools/list')).tools;
    assert.equal(tools.length, 17);
    const runTool = tools.find((tool) => tool.name === 'deploy_run_job')!;
    assert.equal((runTool.inputSchema.properties as Record<string, any>).label.maxLength, 80);
    assert.ok(!runTool.inputSchema.required?.includes('label'));
    assert.match(runTool.description!, /short label saying what it checks/);
    // Agents can create their repository and deploy through deploy.local.
    for (const name of ['deploy_create_repository', 'deploy_commit', 'deploy_application'])
      assert.ok(
        tools.some((tool: any) => tool.name === name),
        name,
      );
    assert.ok(tools.some((entry) => entry.name === 'deploy_attach'));
    assert.ok(tools.some((entry) => entry.name === 'deploy_ask_user'));
    assert.ok(tools.some((entry) => entry.name === 'deploy_control'));
    assert.ok(tools.some((entry) => entry.name === 'deploy_project'));
    await until(() => {
      assert.equal(child.exitCode, null, errors);
      return list('worker', owner).some((w) => w.id === enrollment.workerId);
    });
    const machines = await call('deploy_list_computers');
    assert(
      machines.computers.some((w: any) => w.id === enrollment.workerId && w.status === 'online'),
    );
    const cp = await call('deploy_checkpoint', { operationId: operation() });
    const job = await call('deploy_run_job', {
      checkpointId: cp.checkpointId,
      workerId: enrollment.workerId,
      command:
        'cat source.txt; printf "remote complete\\n"; test -z "$DEPLOY_AGENT_TOKEN$DEPLOY_WORKER_TOKEN"',
      operationId: operation(),
    });
    const done = await until(async () => {
      const j = await call('deploy_get_job', { jobId: job.id });
      return !['queued', 'running'].includes(j.status) && j;
    });
    assert.equal(done.status, 'succeeded', JSON.stringify(done) + errors);
    assert.match(done.output, /checkpoint version\nremote complete/);
    assert.equal(done.digest, cp.digest);
    assert.ok(Date.parse(done.finishedAt) >= Date.parse(done.startedAt));
    assert((await call('deploy_list_jobs')).jobs.some((j: any) => j.id === job.id));
    const rejected = await fetch(origin + '/api/state', {
      headers: { 'x-deploy-agent-token': token },
    });
    assert.equal(rejected.status, 403);
    const detailResponse = await fetch(origin + '/api/tasks/' + task.id, {
      headers: {
        'x-deploy-worker-id': enrollment.workerId,
        'x-deploy-worker-token': enrollment.workerToken,
      },
    });
    assert.equal(detailResponse.status, 403);
    for (const adapter of ['codex', 'claude']) {
      if (!process.env['DEPLOY_TEST_REAL_' + adapter.toUpperCase()]) continue;
      const launch = agentLaunch({ adapter });
      const smoke = spawn(launch.executable, launch.args, {
        cwd: task.workspacePath,
        env: {
          ...process.env,
          DEPLOY_AGENT_URL: origin + '/api/agent/tools',
          DEPLOY_AGENT_TOKEN: token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '';
      smoke.stdout.on('data', (c) => (output += c));
      smoke.stderr.on('data', (c) => (output += c));
      smoke.stdin.end(
        'Use the deploy MCP tools to discover computers, capture a checkpoint, and run cat source.txt on test-remote. Wait for its result and report the output. Use unique operationId strings. Do not use local shell tools or change files.',
      );
      const guard = setTimeout(() => smoke.kill('SIGTERM'), 60000);
      const [code] = await once(smoke, 'close');
      clearTimeout(guard);
      assert.equal(code, 0, output);
      assert.match(output, /test-remote/);
      assert.match(output, adapter === 'codex' ? /mcp_tool_call/ : /mcp__deploy__/);
      assert.match(output, /deploy_run_job/);
      assert.match(output, /checkpoint version/);
    }
  } finally {
    lines.close();
    for (const process of [mcp, child]) {
      if (process.exitCode === null && process.signalCode === null) {
        const closed = once(process, 'close');
        process.kill('SIGTERM');
        await closed;
      }
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('OS requirements queue until an eligible worker claims once, without changing the conversation worker', async (t) => {
  // Earlier tests leave fresh local/remote workers. On Linux ARM64 they match this
  // job until their heartbeats expire, making this assertion depend on suite speed.
  const previousWorkers = list('worker', owner);
  const local = db.prepare("SELECT heartbeat FROM worker WHERE id='local'").get() as
    | { heartbeat: string }
    | undefined;
  for (const worker of previousWorkers)
    save('worker', owner, { ...worker, heartbeat: new Date(0).toISOString() });
  db.prepare("UPDATE worker SET heartbeat=NULL WHERE id='local'").run();
  t.after(() => {
    for (const worker of previousWorkers) save('worker', owner, worker);
    if (local) db.prepare("UPDATE worker SET heartbeat=? WHERE id='local'").run(local.heartbeat);
  });
  const { workerCommand } = await import('../../workspace/protocol.ts');
  const job = tool('deploy_run_job', {
    checkpointId: checkpoint.checkpointId,
    requirements: {
      os: 'linux',
      architecture: 'arm64',
      capabilities: ['shell'],
    },
    command: 'true',
    operationId: operation(),
  });
  assert.equal(job.workerId, null);
  const register = (
    workerId: string,
    workerPlatform: string,
    architecture: string,
    checkpointJobs = true,
  ) =>
    workerCommand(owner, '/workers/register', {
      workerId,
      instanceId: workerId,
      platform: workerPlatform,
      architecture,
      checkpointJobs,
    });
  register('placement-mac', 'darwin', 'arm64');
  register('placement-x64', 'linux', 'x64');
  register('placement-no-jobs', 'linux', 'arm64', false);
  for (const workerId of ['placement-mac', 'placement-x64', 'placement-no-jobs'])
    assert.equal(jobCommand(owner, workerId, 'poll', { instanceId: workerId }).job, null);
  assert.equal(get('job', owner, job.id).status, 'queued');
  assert.match(tool('deploy_get_job', { jobId: job.id }).waitingReason, /No online worker/);
  register('placement-arm64', 'linux', 'arm64');
  register('placement-arm64-second', 'linux', 'arm64');
  const assignment = jobCommand(owner, 'placement-arm64', 'poll', {
    instanceId: 'placement-arm64',
  });
  assert.equal(assignment.job.id, job.id);
  assert.equal(assignment.job.workerId, 'placement-arm64');
  assert.equal(
    jobCommand(owner, 'placement-arm64-second', 'poll', { instanceId: 'placement-arm64-second' })
      .job,
    null,
  );
  assert.equal(get('task', owner, task.id).workerId, 'local');
  // A new process may not replay the already-running job on another matching host.
  save('worker', owner, { ...get('worker', owner, 'placement-arm64'), instanceId: 'restarted' });
  assert.equal(jobCommand(owner, 'placement-arm64', 'poll', { instanceId: 'restarted' }).job, null);
  assert.equal(get('job', owner, job.id).status, 'unknown');
  assert.equal(
    jobCommand(owner, 'placement-arm64-second', 'poll', { instanceId: 'placement-arm64-second' })
      .job,
    null,
  );
  const waiting = tool('deploy_run_job', {
    checkpointId: checkpoint.checkpointId,
    requirements: { os: 'windows' },
    command: 'echo test',
    operationId: operation(),
  });
  register('placement-windows', 'win32', 'x64');
  assert.equal(
    jobCommand(owner, 'placement-windows', 'poll', { instanceId: 'placement-windows' }).job,
    null,
  );
  assert.match(tool('deploy_get_job', { jobId: waiting.id }).waitingReason, /No online worker/);
  tool('deploy_cancel_job', { jobId: waiting.id, operationId: operation() });
  assert.equal(get('job', owner, waiting.id).status, 'cancelled');
  assert.ok(get('job', owner, waiting.id).finishedAt);
  assert.equal(get('job', owner, waiting.id).startedAt, undefined);
  assert.throws(
    () =>
      tool('deploy_run_job', {
        checkpointId: checkpoint.checkpointId,
        workerId: 'placement-mac',
        requirements: { os: 'linux' },
        command: 'true',
        operationId: operation(),
      }),
    /matching/,
  );
  assert.throws(
    () =>
      tool('deploy_run_job', {
        checkpointId: checkpoint.checkpointId,
        requirements: { os: 'linuz' },
        command: 'true',
        operationId: operation(),
      }),
    /Job OS/,
  );
});

test('subscription defaults never inherit the compatible model in a spawned Claude process', async () => {
  const fixture = join(data, 'claude-default-fixture');
  writeFileSync(
    fixture,
    `#!/usr/bin/env node
if (process.argv.includes('--model') || process.argv.includes('--effort')) process.exit(9);
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({type:'result',is_error:false,result:'Subscription default'})));
`,
    { mode: 0o700 },
  );
  const environment = {
    ...process.env,
    DEPLOY_MODEL_NAME: 'Qwen3-8B-GGUF',
    DEPLOY_MODEL_EFFORT: 'high',
  };
  for (const adapter of ['claude', 'codex']) {
    assert.equal(agentModelEnvironment({ adapter }, environment).DEPLOY_MODEL_NAME, undefined);
    assert.equal(agentModelEnvironment({ adapter }, environment).DEPLOY_MODEL_EFFORT, undefined);
    assert.equal(
      agentModelEnvironment({ adapter, model: 'explicit', effort: 'high' }, environment)
        .DEPLOY_MODEL_NAME,
      'explicit',
    );
  }
  assert.equal(
    agentModelEnvironment({ adapter: 'compatible' }, environment).DEPLOY_MODEL_NAME,
    'Qwen3-8B-GGUF',
  );
  assert.equal(
    agentModelEnvironment({ adapter: 'compatible', model: 'larger-model' }, environment)
      .DEPLOY_MODEL_NAME,
    'larger-model',
  );
  const launch = agentLaunch({ adapter: 'claude' });
  const child = spawn(launch.executable, launch.args, {
    env: {
      ...environment,
      ...agentModelEnvironment({ adapter: 'claude' }, environment),
      DEPLOY_CLAUDE_BIN: fixture,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end('Default provider acceptance');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(output, /Subscription default/);
});
test('agent MCP servers inherit the worker TLS trust for private coordinator CAs', async () => {
  const { trustEnvironment } = await import('../../workspace/tls-trust.ts');
  assert.deepEqual(trustEnvironment({ PATH: '/bin', DEPLOY_WORKER_TOKEN: 'secret' }, []), {});
  assert.deepEqual(
    trustEnvironment({ NODE_EXTRA_CA_CERTS: '/etc/deploy/ca.crt', NODE_USE_SYSTEM_CA: '1' }, []),
    { NODE_EXTRA_CA_CERTS: '/etc/deploy/ca.crt', NODE_USE_SYSTEM_CA: '1' },
  );
  assert.deepEqual(trustEnvironment({ NODE_OPTIONS: '--use-system-ca' }, []), {
    NODE_USE_SYSTEM_CA: '1',
  });
  assert.deepEqual(trustEnvironment({}, ['--use-system-ca']), { NODE_USE_SYSTEM_CA: '1' });
  const saved = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = '/etc/deploy/ca "home".crt';
  try {
    const args = agentLaunch({ adapter: 'codex' }).args;
    const override = args.find((arg: string) => arg.startsWith('mcp_servers.deploy.env='));
    assert.ok(override, 'Codex launch forwards CA trust to the deploy MCP server');
    assert.match(override, /NODE_EXTRA_CA_CERTS="\/etc\/deploy\/ca \\"home\\".crt"/);
    assert.ok(!args.some((arg: string) => /DEPLOY_WORKER_TOKEN|secret/.test(arg)));
  } finally {
    if (saved === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = saved;
  }
});

test('stopping a task timestamps queued job cancellation without inventing a start', async () => {
  const { stopRun } = await import('../../workspace/service.ts');
  const waitingTask = createTask(owner, { title: 'Stop queued job' });
  const waitingRun = startRun(owner, waitingTask.id, {
    revision: 0,
    content: 'Wait for a computer',
  });
  const waitingScope = { owner, taskId: waitingTask.id, runId: waitingRun.id };
  const cp = coordinationTool(waitingScope, 'deploy_checkpoint', {
    operationId: operation(),
    snapshot: captureSnapshot(waitingTask.workspacePath),
  });
  const queued = coordinationTool(waitingScope, 'deploy_run_job', {
    checkpointId: cp.checkpointId,
    operationId: operation(),
    requirements: { os: 'windows' },
    command: 'echo waiting',
  });
  stopRun(owner, waitingTask.id, { revision: get('task', owner, waitingTask.id).revision });
  const stopped = get('job', owner, queued.id);
  assert.equal(stopped.status, 'cancelled');
  assert.ok(stopped.finishedAt);
  assert.equal(stopped.startedAt, undefined);
});
