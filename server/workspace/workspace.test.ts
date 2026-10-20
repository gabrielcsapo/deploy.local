import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
process.env.DEPLOY_DATA_DIR = mkdtempSync(join(tmpdir(), 'deploy-workspace-test-'));
const { command, list, get } = await import('./store.ts');
const { createProject, createTask } = await import('./test-repository.ts');
const { startRun, stopRun, git, diff } = await import('./service.ts');
test('hosted project, isolated task, deduplicated run, conflict and durable changes', () => {
  const project = command('alice', 'create', () => createProject('alice', { name: 'Pilot' }));
  assert.equal(
    command('alice', 'create', () => {
      throw new Error('duplicate executed');
    }).id,
    project.id,
  );
  const task = createTask('alice', { projectId: project.id, title: 'First task' });
  assert.equal(git(task.workspacePath, ['rev-parse', 'HEAD']), task.baseRevision);
  writeFileSync(join(task.workspacePath, 'hello.txt'), 'hello\n');
  git(task.workspacePath, ['add', 'hello.txt']);
  const run = command('alice', 'send', () =>
    startRun('alice', task.id, { revision: 0, content: 'Read the repository' }),
  );
  assert.equal(
    command('alice', 'send', () => {
      throw new Error('duplicate run');
    }).id,
    run.id,
  );
  assert.throws(() => startRun('alice', task.id, { revision: 0, content: 'race' }), /Task changed/);
  assert.throws(() => startRun('alice', task.id, { revision: 1, content: 'race' }), /active run/);
  stopRun('alice', task.id, { revision: 1 });
  assert.equal(get('run', 'alice', run.id).stopRequested, true);
  assert.match(diff('alice', task.id).patch, /hello/);
  assert.equal(readFileSync(join(task.workspacePath, 'hello.txt'), 'utf8'), 'hello\n');
  assert.throws(() => get('task', 'bob', task.id), /Not found/);
  assert.equal(list('run', 'alice').length, 1);
});
test('import retains dirty source; clone and push hosted history', () => {
  const source = mkdtempSync(join(tmpdir(), 'deploy-source-'));
  git(source, ['init', '--initial-branch=main']);
  writeFileSync(join(source, 'tracked'), 'committed');
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'seed']);
  writeFileSync(join(source, 'tracked'), 'dirty');
  const p = createProject('alice', { name: 'Imported', sourcePath: source });
  const clone = mkdtempSync(join(tmpdir(), 'deploy-clone-'));
  git(clone, ['clone', p.repositoryPath, '.']);
  assert.equal(readFileSync(join(clone, 'tracked'), 'utf8'), 'committed');
  assert.equal(readFileSync(join(source, 'tracked'), 'utf8'), 'dirty');
  writeFileSync(join(clone, 'new'), 'push');
  git(clone, ['add', '.']);
  git(clone, ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-m', 'change']);
  git(clone, ['push', 'origin', 'main']);
  assert.equal(git(p.repositoryPath, ['rev-parse', 'main']), git(clone, ['rev-parse', 'HEAD']));
});
test('independent worker persists output, resumes provider reference, and cancels process', async () => {
  const { spawn } = await import('node:child_process');
  const { chmodSync } = await import('node:fs');
  const binary = join(process.env.DEPLOY_DATA_DIR!, 'test-agent');
  writeFileSync(
    binary,
    `#!${process.execPath}
let prompt='';process.stdin.on('data',x=>prompt+=x);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'test-session'}));if(prompt.includes('WAIT')){setInterval(()=>{},1000);return;}console.log(JSON.stringify({type:'item.updated',item:{id:'reply',type:'agent_message',text:'partial worker output'}}));setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{id:'reply',type:'agent_message',text:'verified worker output'}})),350);});
`,
  );
  chmodSync(binary, 0o700);
  const worker = spawn(process.execPath, ['server/workspace/worker.ts'], {
    env: { ...process.env, DEPLOY_CODEX_BIN: binary },
    stdio: 'pipe',
  });
  const wait = async (fn: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error('worker timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    const p = createProject('alice', { name: 'Worker lifecycle' }),
      t = createTask('alice', { projectId: p.id, title: 'Run' });
    const first = startRun('alice', t.id, { revision: 0, content: 'reply' });
    await wait(() =>
      list('message', 'alice').some(
        (m) => m.taskId === t.id && m.content === 'partial worker output',
      ),
    );
    assert.equal(get('run', 'alice', first.id).status, 'running');
    await wait(() => get('run', 'alice', first.id).status === 'succeeded');
    assert.match(get('run', 'alice', first.id).startCheckpoint, /^[0-9a-f]{40}$/);
    assert.match(get('run', 'alice', first.id).checkpoint, /^[0-9a-f]{40}$/);
    assert.equal(
      list('message', 'alice').filter((m) => m.taskId === t.id && m.role === 'assistant').length,
      1,
    );
    assert.equal(
      list('message', 'alice')
        .filter((m) => m.taskId === t.id)
        .at(-1).content,
      'verified worker output',
    );
    const second = startRun('alice', t.id, {
      revision: get('task', 'alice', t.id).revision,
      content: 'WAIT',
    });
    assert.equal(second.sessionId, 'test-session');
    await wait(() => get('run', 'alice', second.id).status === 'running');
    const { queueMessage, queuedMessage } = await import('./queued-message.ts');
    assert.equal(queueMessage('alice', t.id, { content: 'queued follow-up' }).sent, false);
    stopRun('alice', t.id, { revision: get('task', 'alice', t.id).revision });
    await wait(() => get('run', 'alice', second.id).status === 'interrupted');
    // A stopped turn never sends the queued follow-up; it is held with the reason.
    assert.equal(queuedMessage('alice', t.id).reason, 'Not sent because the turn was stopped.');
    assert.equal(get('run', 'alice', second.id).error, null);
    assert.equal(get('task', 'alice', t.id).status, 'review');
  } finally {
    worker.kill('SIGTERM');
    await new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  }
});
test('HTTP worker contract fences assignments, deduplicates replay and retains remote placement', async () => {
  const { workerCommand } = await import('./protocol.ts');
  workerCommand('alice', '/workers/register', {
    workerId: 'remote-test',
    name: 'Other computer',
    codex: true,
    providers: [
      {
        id: 'codex',
        status: 'signed-in',
        checkedAt: 123,
        windows: [{ label: 'Weekly', usedPercent: 37 }],
        token: 'must-not-be-stored',
      },
    ],
  });
  const registered = get('worker', 'alice', 'remote-test');
  assert.equal(registered.providers[0].windows[0].usedPercent, 37);
  assert.equal(JSON.stringify(registered.providers).includes('must-not-be-stored'), false);
  const p = createProject('alice', { name: 'Remote pilot' }),
    t = createTask('alice', { projectId: p.id, title: 'Remote task', workerId: 'remote-test' });
  const run = startRun('alice', t.id, { revision: 0, content: 'remote read' });
  const assigned = workerCommand('alice', '/workers/remote-test/poll', {});
  assert.equal(assigned.run.id, run.id);
  assert.ok(assigned.run.generation);
  assert.equal(
    workerCommand('alice', '/workers/remote-test/poll', {}).run.generation,
    assigned.run.generation,
  );
  const envelope = {
    runId: run.id,
    generation: assigned.run.generation,
    events: [
      { sequence: 1, type: 'message', payload: { role: 'assistant', content: 'remote response' } },
    ],
  };
  assert.equal(
    workerCommand('alice', '/workers/remote-test/events', envelope).acknowledgedSequence,
    1,
  );
  workerCommand('alice', '/workers/remote-test/events', envelope);
  assert.equal(
    list('message', 'alice').filter((m) => m.taskId === t.id && m.role === 'assistant').length,
    1,
  );
  assert.throws(
    () =>
      workerCommand('alice', '/workers/remote-test/events', { ...envelope, generation: 'stale' }),
    /Stale worker/,
  );
  assert.throws(
    () =>
      workerCommand('alice', '/workers/remote-test/events', {
        ...envelope,
        events: [{ sequence: 3, type: 'test', payload: {} }],
      }),
    /sequence gap/,
  );
  const streamed = {
    ...envelope,
    events: [
      {
        sequence: 2,
        type: 'message',
        payload: { providerItemId: 'streamed-reply', role: 'assistant', content: 'partial' },
      },
      {
        sequence: 3,
        type: 'message',
        payload: { providerItemId: 'streamed-reply', role: 'assistant', content: 'complete' },
      },
    ],
  };
  workerCommand('alice', '/workers/remote-test/events', streamed);
  workerCommand('alice', '/workers/remote-test/events', streamed);
  const replies = list('message', 'alice').filter(
    (m) => m.taskId === t.id && m.role === 'assistant',
  );
  assert.equal(replies.length, 2);
  assert.equal(replies.at(-1).content, 'complete');
  workerCommand('alice', '/workers/remote-test/complete', {
    runId: run.id,
    generation: assigned.run.generation,
    status: 'succeeded',
    workspacePath: '/remote/tasks/pilot',
    diff: { patch: 'remote diff', checks: [] },
  });
  assert.equal(diff('alice', t.id).patch, 'remote diff');
  assert.equal(get('task', 'alice', t.id).remoteWorkspacePath, '/remote/tasks/pilot');
  assert.equal(get('task', 'alice', t.id).workerId, 'remote-test');
});
test('untracked review includes source content and excludes private env files', () => {
  const p = createProject('alice', { name: 'Review' }),
    t = createTask('alice', { projectId: p.id, title: 'Untracked review' });
  writeFileSync(join(t.workspacePath, 'generated.ts'), 'export const answer = 42;\n');
  writeFileSync(join(t.workspacePath, '.env'), 'API_SECRET=do-not-display');
  const review = diff('alice', t.id);
  assert.match(review.patch, /export const answer = 42/);
  assert.doesNotMatch(review.patch, /do-not-display/);
  assert.ok(review.excluded.includes('.env'));
});
test('review lists files inside new directories and returns an applicable patch', () => {
  const p = createProject('alice', { name: 'Scaffold review' }),
    t = createTask('alice', { projectId: p.id, title: 'Scaffold' });
  mkdirSync(join(t.workspacePath, 'apple/Sources/Kit'), { recursive: true });
  writeFileSync(join(t.workspacePath, 'apple/Sources/Kit/Kit.swift'), 'public let kit = 1\n');
  mkdirSync(join(t.workspacePath, 'web'));
  writeFileSync(join(t.workspacePath, 'web/server.mjs'), 'export const port = 3000;\n');
  const review = diff('alice', t.id);
  const paths = review.files.map((file: any) => file.path).sort();
  assert.deepEqual(paths, ['apple/Sources/Kit/Kit.swift', 'web/server.mjs']);
  assert.match(review.patch, /public let kit = 1/);
  assert.match(review.patch, /export const port = 3000/);
  assert.ok(review.patch.endsWith('\n'));
  const clone = mkdtempSync(join(tmpdir(), 'review-apply-'));
  git(tmpdir(), ['clone', '-q', t.workspacePath, clone]);
  writeFileSync(join(clone, 'review.patch'), review.patch);
  git(clone, ['apply', '--check', 'review.patch']);
});
test('tracked-only review patch ends with a newline', async () => {
  const { inspectWorkspace } = await import('./review.ts');
  const p = createProject('alice', { name: 'Tracked review' }),
    t = createTask('alice', { projectId: p.id, title: 'Tracked' });
  writeFileSync(join(t.workspacePath, 'notes.txt'), 'one\n');
  git(t.workspacePath, ['add', 'notes.txt']);
  git(t.workspacePath, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@local',
    'commit',
    '-qm',
    'notes',
  ]);
  const base = git(t.workspacePath, ['rev-parse', 'HEAD']);
  writeFileSync(join(t.workspacePath, 'notes.txt'), 'one\ntwo\n');
  const review = inspectWorkspace(t.workspacePath, base);
  assert.match(review.patch, /\+two/);
  assert.ok(review.patch.endsWith('\n'));
  git(t.workspacePath, ['checkout', '--', 'notes.txt']);
  writeFileSync(join(tmpdir(), `tracked-${t.id}.patch`), review.patch);
  git(t.workspacePath, ['apply', '--check', join(tmpdir(), `tracked-${t.id}.patch`)]);
});
test('scoped worker credentials reject client commands and unrelated Git repositories', async () => {
  const { enrollWorker, workerAuthentication } = await import('./credentials.ts');
  const { workspaceApi } = await import('./api.ts');
  const { createServer } = await import('node:http');
  const credential = enrollWorker('alice', { workerId: 'scoped-worker' });
  const server = createServer((req, res) => {
    const auth = workerAuthentication(req);
    if (!auth) {
      res.writeHead(401);
      res.end();
      return;
    }
    void workspaceApi(req, res, auth.owner, auth.workerId);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port,
    headers = {
      'Content-Type': 'application/json',
      'x-deploy-worker-id': credential.workerId,
      'x-deploy-worker-token': credential.workerToken,
    };
  try {
    assert.equal((await fetch(origin + '/api/workspace/state', { headers })).status, 403);
    assert.equal(
      (
        await fetch(origin + '/api/workspace/projects', {
          method: 'POST',
          headers,
          body: JSON.stringify({ operationId: 'forbidden', name: 'No' }),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/workspace/workers/register', {
          method: 'POST',
          headers,
          body: JSON.stringify({ workerId: 'different' }),
        })
      ).status,
      403,
    );
    const p = createProject('alice', { name: 'Private repository' });
    assert.equal(
      (
        await fetch(origin + '/api/workspace/git/' + p.id + '/info/refs?service=git-upload-pack', {
          headers,
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(origin + '/api/workspace/workers/register', {
          method: 'POST',
          headers,
          body: JSON.stringify({ workerId: 'scoped-worker', instanceId: 'first' }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/workspace/workers/register', {
          method: 'POST',
          headers,
          body: JSON.stringify({ workerId: 'scoped-worker', instanceId: 'competing' }),
        })
      ).status,
      409,
    );
    const t = createTask('alice', {
      projectId: p.id,
      title: 'Authorized assignment',
      workerId: 'scoped-worker',
    });
    startRun('alice', t.id, { revision: 0, content: 'Read' });
    assert.equal(
      (
        await fetch(origin + '/api/workspace/workers/scoped-worker/poll', {
          method: 'POST',
          headers,
          body: JSON.stringify({ instanceId: 'first' }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/workspace/git/' + p.id + '/info/refs?service=git-upload-pack', {
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(origin + '/api/workspace/git/' + p.id + '/info/refs?service=git-receive-pack', {
          headers,
        })
      ).status,
      403,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('idempotency rejects reuse for a different command', () => {
  command('alice', 'signature-check', () => ({ ok: true }), 'first');
  assert.throws(
    () => command('alice', 'signature-check', () => ({ ok: false }), 'changed'),
    /different command/,
  );
});
test('compatible model tool loop executes file tools and persists resumable model context', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const source = mkdtempSync(join(tmpdir(), 'compatible-runtime-')),
    session = join(source, '..', `compatible-session-${Date.now()}.json`);
  let requests = 0;
  const provider = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    assert.equal(input.model, 'test-independent-model');
    assert.equal(req.headers.authorization, 'Bearer fixture-provider-key');
    const shellResult = input.messages.find((m: any) => m.tool_call_id === 'shell-1');
    if (shellResult) assert.equal(JSON.parse(shellResult.content).stdout.trim(), '{}');
    requests++;
    res.setHeader('Content-Type', 'application/json');
    const toolResult = input.messages.find((m: any) => m.role === 'tool');
    res.end(
      JSON.stringify({
        choices: [
          {
            message: toolResult
              ? { role: 'assistant', content: 'Created and verified the file.' }
              : {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'write-1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({
                          path: 'src/answer.ts',
                          content: 'export const answer = 42;\n',
                        }),
                      },
                    },
                    {
                      id: 'shell-1',
                      type: 'function',
                      function: {
                        name: 'run_command',
                        arguments: JSON.stringify({
                          command: `${process.execPath} -e 'console.log(JSON.stringify({key:process.env.DEPLOY_MODEL_API_KEY,session:process.env.DEPLOY_MODEL_SESSION_FILE,worker:process.env.DEPLOY_WORKER_TOKEN}))'`,
                        }),
                      },
                    },
                  ],
                },
          },
        ],
        usage: { total_tokens: 30 },
      }),
    );
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  try {
    let output = '';
    const child = spawn(process.execPath, [resolve('server/workspace/compatible-agent.ts')], {
      cwd: source,
      env: {
        ...process.env,
        DEPLOY_MODEL_BASE_URL: 'http://127.0.0.1:' + (provider.address() as any).port + '/v1',
        DEPLOY_MODEL_NAME: 'test-independent-model',
        DEPLOY_MODEL_BILLING_MODE: 'local',
        DEPLOY_MODEL_SESSION_FILE: session,
        DEPLOY_MODEL_API_KEY: 'fixture-provider-key',
        DEPLOY_WORKER_TOKEN: 'fixture-worker-token',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stdin.end('Create the answer file');
    const code = await new Promise<number | null>((done) => child.on('close', done));
    assert.equal(code, 0);
    assert.equal(
      readFileSync(join(source, 'src/answer.ts'), 'utf8'),
      'export const answer = 42;\n',
    );
    assert.equal(requests, 2);
    assert.match(output, /turn.completed/);
    assert.doesNotMatch(output, /fixture-provider-key|fixture-worker-token/);
    const context = JSON.parse(readFileSync(session, 'utf8'));
    assert.ok(context.id);
    assert.equal(context.messages.at(-1).content, 'Created and verified the file.');
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});
test('long checks keep state responsive, replay one job, fence writers and clean timeout/stop processes', async () => {
  const { workspaceApi } = await import('./api.ts');
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const server = createServer((req, res) => void workspaceApi(req, res, 'check-owner'));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const worker = spawn(process.execPath, ['server/workspace/worker.ts'], {
    env: {
      ...process.env,
      DEPLOY_MODEL_API_KEY: 'fixture-provider-key',
      DEPLOY_MODEL_SESSION_FILE: '/tmp/private-model-session',
      DEPLOY_WORKER_TOKEN: 'fixture-worker-token',
    },
    stdio: 'pipe',
  });
  const wait = async (fn: () => boolean) => {
    const deadline = Date.now() + 10000;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error('check lifecycle timeout');
      await new Promise((done) => setTimeout(done, 40));
    }
  };
  const p = createProject('check-owner', { name: 'Async checks' }),
    t = createTask('check-owner', { projectId: p.id, title: 'Long-running check' });
  const request = async (path: string, body?: any) => {
    const response = await fetch(origin + '/api/workspace' + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const scrubbed = await request('/tasks/' + t.id + '/check', {
      operationId: 'scrubbed-check',
      revision: 0,
      command: `${process.execPath} -e 'console.log(JSON.stringify({key:process.env.DEPLOY_MODEL_API_KEY,session:process.env.DEPLOY_MODEL_SESSION_FILE,worker:process.env.DEPLOY_WORKER_TOKEN}))'`,
    });
    await wait(() => get('check', 'check-owner', scrubbed.body.id).status === 'succeeded');
    assert.equal(get('check', 'check-owner', scrubbed.body.id).output.trim(), '{}');
    const body = {
      operationId: 'async-check',
      revision: get('task', 'check-owner', t.id).revision,
      command: `${process.execPath} -e 'console.log(process.pid);setInterval(()=>{},1000)'`,
      timeoutMs: 3000,
    };
    const started = Date.now(),
      first = await request('/tasks/' + t.id + '/check', body);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'queued');
    assert.ok(Date.now() - started < 1000, 'check dispatch must not wait for subprocess');
    const replay = await request('/tasks/' + t.id + '/check', body);
    assert.equal(replay.body.id, first.body.id);
    await wait(
      () =>
        get('check', 'check-owner', first.body.id).status === 'running' &&
        get('check', 'check-owner', first.body.id).output.trim().length > 0,
    );
    const live = Date.now(),
      snapshot = await request('/state');
    assert.equal(snapshot.status, 200);
    assert.ok(Date.now() - live < 500, 'state must respond while a check is executing');
    assert.throws(
      () =>
        startRun('check-owner', t.id, {
          revision: get('task', 'check-owner', t.id).revision,
          content: 'Competing writer',
        }),
      /active check/,
    );
    const timedPid = Number(get('check', 'check-owner', first.body.id).output.trim());
    await wait(() => get('check', 'check-owner', first.body.id).status === 'failed');
    assert.match(get('check', 'check-owner', first.body.id).error, /timeout/);
    await wait(() => {
      try {
        process.kill(timedPid, 0);
        return false;
      } catch (e: any) {
        return e.code === 'ESRCH';
      }
    });
    const second = await request('/tasks/' + t.id + '/check', {
      ...body,
      operationId: 'stopped-check',
      revision: get('task', 'check-owner', t.id).revision,
      timeoutMs: 10000,
    });
    await wait(
      () =>
        get('check', 'check-owner', second.body.id).status === 'running' &&
        get('check', 'check-owner', second.body.id).output.trim().length > 0,
    );
    const stoppedPid = Number(get('check', 'check-owner', second.body.id).output.trim());
    stopRun('check-owner', t.id, { revision: get('task', 'check-owner', t.id).revision });
    await wait(() => get('check', 'check-owner', second.body.id).status === 'interrupted');
    await wait(() => {
      try {
        process.kill(stoppedPid, 0);
        return false;
      } catch (e: any) {
        return e.code === 'ESRCH';
      }
    });
    assert.equal(get('task', 'check-owner', t.id).status, 'review');
  } finally {
    worker.kill('SIGTERM');
    await new Promise<void>((done) => worker.once('exit', () => done()));
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('projectless conversations are owner-scoped workspaces without synthetic projects', async () => {
  const { initializeScratchWorkspace } = await import('./scratch.ts');
  const before = list('project', 'independent-owner').length;
  const task = command('independent-owner', 'new-conversation', () =>
    createTask('independent-owner', { title: 'Plan my week' }),
  );
  assert.equal(task.projectId, null);
  assert.equal(list('project', 'independent-owner').length, before);
  assert.equal(
    command('independent-owner', 'new-conversation', () => {
      throw new Error('duplicate');
    }).id,
    task.id,
  );
  assert.throws(() => get('task', 'other-owner', task.id), /Not found/);
  writeFileSync(join(task.workspacePath, 'notes.md'), '# Plan\n');
  assert.match(diff('independent-owner', task.id).patch, /# Plan/);
  const second = createTask('independent-owner', { projectId: null, title: 'Second conversation' });
  assert.notEqual(second.workspacePath, task.workspacePath);
  const remoteCopy = mkdtempSync(join(tmpdir(), 'deploy-independent-worker-'));
  assert.equal(initializeScratchWorkspace(remoteCopy), task.baseRevision);
  assert.equal(git(remoteCopy, ['status', '--porcelain']), '');
  const run = startRun('independent-owner', task.id, { revision: 0, content: 'Read notes.md' });
  assert.equal(run.taskId, task.id);
  assert.throws(() => createTask('other-owner', { projectId: 'missing' }), /Not found/);
});

test('projectless HTTP assignments preserve nullable project and worker placement', async () => {
  const { workerCommand } = await import('./protocol.ts');
  const owner = 'independent-remote-owner';
  workerCommand(owner, '/workers/register', { workerId: 'independent-remote', name: 'Laptop' });
  const task = createTask(owner, { title: 'Independent work', workerId: 'independent-remote' });
  const run = startRun(owner, task.id, { revision: 0, content: 'Plan work' });
  const assignment = workerCommand(owner, '/workers/independent-remote/poll', {});
  assert.equal(assignment.project, null);
  assert.equal(assignment.task.id, task.id);
  assert.equal(assignment.run.id, run.id);
  assert.equal(workerCommand(owner, '/workers/independent-remote/poll', {}).project, null);
  workerCommand(owner, '/workers/independent-remote/complete', {
    runId: run.id,
    generation: assignment.run.generation,
    status: 'succeeded',
    workspacePath: '/worker/conversation',
    diff: { patch: '', files: [], checks: [] },
  });
  assert.equal(get('task', owner, task.id).projectId, null);
  assert.equal(get('task', owner, task.id).workerId, 'independent-remote');
});

test('run settings survive task reload and reject unsupported effort before adding a message', async () => {
  const { agentLaunch } = await import('./agent-launch.ts');
  const { validateRunSettings } = await import('./model-options.ts');
  const owner = 'model-settings';
  const task = createTask(owner, { title: 'Model and effort' });
  const run = startRun(owner, task.id, {
    revision: 0,
    content: 'Check settings',
    adapter: 'codex',
    model: 'custom-codex-model',
    effort: 'high',
  });
  assert.equal(get('run', owner, run.id).effort, 'high');
  assert.equal(get('run', owner, run.id).model, 'custom-codex-model');
  const args = agentLaunch({ ...run, sessionId: 'resumed-session' }).args;
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('custom-codex-model'));
  assert.ok(args.includes('resumed-session'));
  const next = createTask(owner, { title: 'Invalid settings' });
  const count = list('message', owner).length;
  assert.throws(
    () => startRun(owner, next.id, { revision: 0, content: 'Invalid', effort: 'invalid' }),
    /not supported/,
  );
  assert.equal(list('message', owner).length, count);
  assert.throws(
    () =>
      validateRunSettings({ adapter: 'codex', model: 'small', effort: 'ultra' }, [
        {
          id: 'codex',
          models: [{ id: 'small', name: 'Small', efforts: ['low'] }],
          efforts: ['low', 'ultra'],
        },
      ]),
    /not supported/,
  );
  assert.throws(
    () =>
      validateRunSettings({ adapter: 'compatible', effort: 'high' }, [
        { id: 'compatible', models: [], efforts: [] },
      ]),
    /not supported/,
  );
  assert.deepEqual(validateRunSettings({}, []), { model: null, effort: null });
});
